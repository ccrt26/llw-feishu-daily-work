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
  let asrCalls=0,timelineCalls=0,processingSignals=0;
  try {
    const reader=new TaskPublicVideoReader({
      asr:{
        async transcribe(input) {
          asrCalls+=1;
          assert.equal(input.audioFile,fixture.audioFile);
          await input.onProcessingAccepted();
          await input.onProcessingAccepted();
          return transcriptResult(fixture);
        }
      },
      timelineReader:{
        async read(input) {
          timelineCalls+=1;
          return publishTimeline(input);
        },
        async readRange() {
          throw new Error("range_must_not_run");
        }
      }
    });

    const first=await reader.prepare({
      workspaceDir:fixture.root,
      sources:[fixture.source],
      now:NOW,
      onProcessingAccepted:async()=>{processingSignals+=1;}
    });
    assert.equal(asrCalls,1);
    assert.equal(timelineCalls,1);
    assert.equal(processingSignals,1);
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
      now:"2026-07-30T06:01:00.000Z",
      onProcessingAccepted:async()=>{processingSignals+=1;}
    });
    assert.equal(asrCalls,1);
    assert.equal(timelineCalls,1);
    assert.equal(processingSignals,1);
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
  const events=[];
  try {
    const reader=new TaskPublicVideoReader({
      asr:{
        async transcribe(input) {
          asrCalls+=1;
          await input.onProcessingAccepted();
          return transcriptResult(fixture);
        }
      },
      timelineReader:{
        async read(input) {
          timelineCalls+=1;
          events.push(`timeline-${timelineCalls}`);
          if (timelineCalls===1) {
            throw new Error("video_timeline_media_invalid");
          }
          return publishTimeline(input);
        },
        async readRange() {
          throw new Error("range_must_not_run");
        }
      }
    });
    await assert.rejects(
      reader.prepare({
        workspaceDir:fixture.root,
        sources:[fixture.source],
        now:NOW,
        onProcessingAccepted:async()=>{events.push("processing");}
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
      now:"2026-07-30T06:02:00.000Z",
      onProcessingAccepted:async()=>{events.push("processing");}
    });
    assert.equal(recovered.observations.length,1);
    assert.equal(asrCalls,1);
    assert.equal(timelineCalls,2);
    assert.deepEqual(events,[
      "processing","timeline-1","processing","timeline-2"
    ]);
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
        },
        async readRange() {
          throw new Error("range_must_not_run");
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

test("publishes and reloads one durable inspected video interval",async()=>{
  const fixture=await workspaceFixture();
  let rangeCalls=0;
  try {
    const timelineReader={
      async read(input) {
        return publishTimeline(input);
      },
      async readRange(input) {
        rangeCalls+=1;
        return publishRange(input);
      }
    };
    const firstReader=new TaskPublicVideoReader({
      asr:{async transcribe(){return transcriptResult(fixture);}},
      timelineReader,
      clock:()=>"2026-07-30T06:01:00.000Z"
    });
    await firstReader.prepare({
      workspaceDir:fixture.root,
      sources:[fixture.source],
      now:NOW
    });
    const request={
      sourceId:"source-001",
      view:"inspect_time_range",
      startMs:5_000,
      endMs:7_000
    };
    const first=await firstReader.inspectTimeRange({
      request,
      source:fixture.source,
      workspaceDir:fixture.root
    });
    assert.equal(rangeCalls,1);
    assert.equal(
      first.derivedRelativePath,
      "source-001.inspect-5000-7000.json"
    );
    assert.deepEqual(first.modelImageFiles,[{
      sourceId:"source-001",
      relativePath:"source-001.inspect-5000-7000.png",
      sha256:first.modelImageFiles[0].sha256,
      startMs:5_000,
      endMs:7_000
    }]);
    const index=JSON.parse(await readFile(
      join(fixture.root,first.derivedRelativePath),"utf8"
    ));
    assert.equal(index.kind,"video_interval_inspection");
    assert.equal(index.originalSha256,fixture.source.handle.sha256);
    assert.equal(index.coverageStatus,"complete");
    assert.equal(index.startMs,5_000);
    assert.equal(index.endMs,7_000);
    assert.deepEqual(index.samples,[
      {startMs:5_000,endMs:7_000,sampleMs:6_000}
    ]);
    const manifest=JSON.parse(await readFile(
      join(fixture.root,"source-001.manifest.json"),"utf8"
    ));
    assert.equal(
      manifest.derived.filter(item=>item.kind==="inspection").length,
      1
    );
    assert.equal(
      manifest.derived.find(item=>item.kind==="inspection").sha256,
      first.sha256
    );

    const restartedReader=new TaskPublicVideoReader({
      asr:{async transcribe(){throw new Error("asr_must_not_run");}},
      timelineReader,
      clock:()=>"2026-07-30T06:02:00.000Z"
    });
    const second=await restartedReader.inspectTimeRange({
      request,
      source:fixture.source,
      workspaceDir:fixture.root
    });
    assert.deepEqual(second,first);
    assert.equal(rangeCalls,1);

    const orphanManifest=JSON.parse(await readFile(
      join(fixture.root,"source-001.manifest.json"),"utf8"
    ));
    orphanManifest.derived=orphanManifest.derived.filter(
      item=>item.kind!=="inspection"
    );
    await writeFile(
      join(fixture.root,"source-001.manifest.json"),
      `${JSON.stringify(orphanManifest,null,2)}\n`,
      {mode:0o600}
    );
    const orphanRecoveryReader=new TaskPublicVideoReader({
      asr:{async transcribe(){throw new Error("asr_must_not_run");}},
      timelineReader,
      clock:()=>"2026-07-30T06:03:00.000Z"
    });
    const recovered=await orphanRecoveryReader.inspectTimeRange({
      request,
      source:fixture.source,
      workspaceDir:fixture.root
    });
    assert.deepEqual(recovered,first);
    assert.equal(rangeCalls,1);
    assert.equal(
      JSON.parse(await readFile(
        join(fixture.root,"source-001.manifest.json"),"utf8"
      )).derived.filter(item=>item.kind==="inspection").length,
      1
    );
  } finally {
    await rm(fixture.root,{recursive:true,force:true});
  }
});

test("rejects a forged inspected range before returning model evidence",async()=>{
  const fixture=await workspaceFixture();
  try {
    const reader=new TaskPublicVideoReader({
      asr:{async transcribe(){return transcriptResult(fixture);}},
      timelineReader:{
        async read(input) {
          return publishTimeline(input);
        },
        async readRange(input) {
          const result=await publishRange(input);
          return {...result,startMs:4_000};
        }
      }
    });
    await reader.prepare({
      workspaceDir:fixture.root,
      sources:[fixture.source],
      now:NOW
    });
    await assert.rejects(
      ()=>reader.inspectTimeRange({
        request:{
          sourceId:"source-001",
          view:"inspect_time_range",
          startMs:5_000,
          endMs:7_000
        },
        source:fixture.source,
        workspaceDir:fixture.root
      }),
      /task_public_video_reader_invalid/u
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

async function publishRange(input) {
  const bytes=pngHeader(320,180);
  const relativePath=[
    `${input.sourceId}.inspect`,
    `${input.startMs}`,
    `${input.endMs}.png`
  ].join("-");
  await writeFile(
    join(input.workspaceDir,relativePath),bytes,{mode:0o600}
  );
  return {
    durationMs:20_000,
    startMs:input.startMs,
    endMs:input.endMs,
    sampleCount:1,
    maxGapMs:input.endMs-input.startMs,
    samples:[{
      startMs:input.startMs,
      endMs:input.endMs,
      sampleMs:input.startMs+
        Math.floor((input.endMs-input.startMs)/2)
    }],
    images:[{
      sourceId:input.sourceId,
      relativePath,
      sha256:sha(bytes),
      startMs:input.startMs,
      endMs:input.endMs
    }],
    limitations:[
      "uniform_range_sampling","not_frame_by_frame"
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
