import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {
  chmod,mkdtemp,readFile,rm,writeFile
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  TaskPublicVideoReader
} from "../src/personal-assistant/task-public-video-reader.mjs";
import {
  createSourceSidecarManifest
} from "../src/personal-assistant/source-sidecar-manifest.mjs";

const NOW="2026-07-30T06:00:00.000Z";

test("publishes and reloads timestamped transcript plus full-timeline images",async()=>{
  const fixture=await workspaceFixture();
  let asrCalls=0,timelineCalls=0;
  try {
    const reader=new TaskPublicVideoReader({
      asr:{
        async transcribe(input) {
          asrCalls+=1;
          assert.equal(input.audioFile,fixture.audioFile);
          return transcriptResult(fixture);
        }
      },
      timelineReader:{
        async read(input) {
          timelineCalls+=1;
          return publishTimeline(input);
        }
      }
    });

    const first=await reader.prepare({
      workspaceDir:fixture.root,
      sources:[fixture.source],
      now:NOW
    });
    assert.equal(asrCalls,1);
    assert.equal(timelineCalls,1);
    assert.equal(first.observations.length,1);
    assert.equal(first.modelImageFiles.length,1);
    const content=JSON.parse(first.observations[0].content);
    assert.equal(content.transcript.coverageStatus,"complete");
    assert.equal(content.transcript.segments[0].text,"真实声音事实");
    assert.equal(content.visualTimeline.maxGapMs,10_000);
    assert.equal(content.visualTimeline.coverageStatus,"complete");

    const second=await reader.prepare({
      workspaceDir:fixture.root,
      sources:[fixture.source],
      now:"2026-07-30T06:01:00.000Z"
    });
    assert.equal(asrCalls,1);
    assert.equal(timelineCalls,1);
    assert.deepEqual(second,first);
    assert.equal(
      JSON.parse(await readFile(
        join(fixture.root,"source-001.manifest.json"),"utf8"
      )).derived.length,
      2
    );
  } finally {
    await rm(fixture.root,{recursive:true,force:true});
  }
});

test("a timeline retry reuses the already durable transcript without another ASR call",async()=>{
  const fixture=await workspaceFixture();
  let asrCalls=0,timelineCalls=0;
  try {
    const reader=new TaskPublicVideoReader({
      asr:{
        async transcribe() {
          asrCalls+=1;
          return transcriptResult(fixture);
        }
      },
      timelineReader:{
        async read(input) {
          timelineCalls+=1;
          if (timelineCalls===1) {
            throw new Error("video_timeline_media_invalid");
          }
          return publishTimeline(input);
        }
      }
    });
    await assert.rejects(
      reader.prepare({
        workspaceDir:fixture.root,
        sources:[fixture.source],
        now:NOW
      }),
      /public_video_timeline_failed/
    );
    assert.equal(asrCalls,1);
    assert.equal(
      JSON.parse(await readFile(
        join(fixture.root,"source-001.manifest.json"),"utf8"
      )).derived[0].kind,
      "transcript"
    );

    const recovered=await reader.prepare({
      workspaceDir:fixture.root,
      sources:[fixture.source],
      now:"2026-07-30T06:02:00.000Z"
    });
    assert.equal(recovered.observations.length,1);
    assert.equal(asrCalls,1);
    assert.equal(timelineCalls,2);
  } finally {
    await rm(fixture.root,{recursive:true,force:true});
  }
});

test("recovers a transcript written before its sidecar append without resubmitting ASR",async()=>{
  const fixture=await workspaceFixture();
  let asrCalls=0,timelineCalls=0;
  try {
    await createSourceSidecarManifest({
      workspaceDir:fixture.root,
      original:{
        sourceId:"source-001",
        relativePath:"source-001.mp4",
        byteSize:fixture.source.handle.byteSize,
        sha256:fixture.source.handle.sha256,
        mime:"video/mp4",
        durationMs:20_000
      },
      now:NOW
    });
    const raw=transcriptResult(fixture);
    await writeFile(
      join(fixture.root,"source-001.transcript.json"),
      `${JSON.stringify({
        version:1,sourceId:"source-001",
        originalDurationMs:20_000,
        providerDurationMs:20_000,
        engine:"external_video_asr",
        runtime:{
          providerId:raw.providerId,
          apiVersion:raw.apiVersion,
          resourceId:raw.resourceId,
          requestProfile:raw.requestProfile
        },
        audioSha256:raw.audioSha256,
        segments:raw.segments,
        coveredRanges:raw.coveredRanges,
        uncoveredRanges:raw.uncoveredRanges,
        coverageStatus:raw.coverageStatus,
        limitations:raw.limitations
      },null,2)}\n`,
      {mode:0o600}
    );
    const reader=new TaskPublicVideoReader({
      asr:{async transcribe(){asrCalls+=1;throw new Error("duplicate");}},
      timelineReader:{
        async read(input) {
          timelineCalls+=1;
          return publishTimeline(input);
        }
      }
    });
    const recovered=await reader.prepare({
      workspaceDir:fixture.root,
      sources:[fixture.source],
      now:"2026-07-30T06:03:00.000Z"
    });
    assert.equal(recovered.observations.length,1);
    assert.equal(asrCalls,0);
    assert.equal(timelineCalls,1);
    assert.equal(
      JSON.parse(await readFile(
        join(fixture.root,"source-001.manifest.json"),"utf8"
      )).derived[0].kind,
      "transcript"
    );
  } finally {
    await rm(fixture.root,{recursive:true,force:true});
  }
});

async function workspaceFixture() {
  const root=await mkdtemp(join(tmpdir(),"llw-task-video-reader-"));
  await chmod(root,0o700);
  const videoBytes=Buffer.from("0000ftypmp42 reader video");
  const audioBytes=Buffer.from("0000ftypM4A reader audio");
  const videoFile=join(root,"source-001.mp4");
  const audioFile=join(root,"source-001.audio.m4a");
  await writeFile(videoFile,videoBytes,{mode:0o600});
  await writeFile(audioFile,audioBytes,{mode:0o600});
  return {
    root,audioFile,
    audioSha:sha(audioBytes),
    source:{
      handle:{
        sourceId:"source-001",
        displayName:"bilibili-BV1Synthetic.mp4",
        mediaClass:"video",
        format:"mp4",
        relativePath:"source-001.mp4",
        byteSize:videoBytes.length,
        sha256:sha(videoBytes),
        availability:"ready",
        durationMs:20_000,
        instructionRole:"source_content",
        representationIndexPath:"source-001.manifest.json",
        limitations:[]
      },
      absolutePath:videoFile,
      archiveExtension:"mp4"
    }
  };
}

function transcriptResult(fixture) {
  return {
    providerId:"volcengine",
    apiVersion:"v3",
    resourceId:"volc.bigasr.auc",
    requestProfile:"recording_file_standard_base64_m4a_v1",
    audioSha256:fixture.audioSha,
    originalDurationMs:20_000,
    providerDurationMs:20_000,
    segments:[{
      startMs:0,endMs:20_000,text:"真实声音事实",
      alternatives:[],isFinal:true,status:"recognized"
    }],
    coveredRanges:[{startMs:0,endMs:20_000}],
    uncoveredRanges:[],
    coverageStatus:"complete",
    limitations:["provider_utterance_timestamps_not_word_exact"]
  };
}

async function publishTimeline(input) {
  const bytes=pngHeader(320,180);
  const relativePath=`${input.sourceId}.timeline-001.png`;
  await writeFile(
    join(input.workspaceDir,relativePath),bytes,{mode:0o600}
  );
  return {
    durationMs:20_000,
    sampleCount:2,
    maxGapMs:10_000,
    samples:[
      {startMs:0,endMs:10_000,sampleMs:5_000},
      {startMs:10_000,endMs:20_000,sampleMs:15_000}
    ],
    images:[{
      sourceId:input.sourceId,
      relativePath,
      sha256:sha(bytes),
      startMs:0,endMs:20_000
    }],
    limitations:[
      "uniform_timeline_sampling","not_frame_by_frame"
    ]
  };
}

function pngHeader(width,height) {
  const value=Buffer.alloc(24);
  Buffer.from([
    0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a
  ]).copy(value,0);
  value.writeUInt32BE(13,8);
  value.write("IHDR",12,"ascii");
  value.writeUInt32BE(width,16);
  value.writeUInt32BE(height,20);
  return value;
}

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}
