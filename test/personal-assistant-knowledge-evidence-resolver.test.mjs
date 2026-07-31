import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {
  mkdtemp,readFile,rm,writeFile
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  resolveKnowledgeEvidence
} from "../src/personal-assistant/knowledge-evidence-resolver.mjs";
import {
  appendDerivedRepresentation,createSourceSidecarManifest
} from "../src/personal-assistant/source-sidecar-manifest.mjs";

test("resolves one complete video as safe evidence without any path",async()=>{
  const fixture=await videoFixture();
  try {
    const result=await resolveKnowledgeEvidence({
      workspaceDir:fixture.workspaceDir,
      sourceBindings:[fixture.binding],
      evidenceSourceIds:["source-001"],
      sourceIds:[]
    });
    assert.equal(result.evidenceSources.length,1);
    assert.deepEqual(result.evidenceSources[0],{
      sourceId:"source-001",
      displayName:"公开视频.mp4",
      mediaClass:"video",
      format:"mp4",
      byteSize:fixture.videoBytes.length,
      sha256:fixture.videoSha256,
      durationMs:12_000,
      derivedEvidence:[
        {
          kind:"timeline",
          sha256:fixture.timelineSha256,
          limitations:["完整时间线导航"]
        },
        {
          kind:"transcript",
          sha256:fixture.transcriptSha256,
          limitations:["时间戳不是逐字级"]
        }
      ],
      limitations:["公开链接临时取得"]
    });
    assert.doesNotMatch(JSON.stringify(result),/private|relativePath|absolutePath/u);
    assert.match(result.sourceSetDigest,/^[a-f0-9]{64}$/u);
  } finally {
    await rm(fixture.workspaceDir,{recursive:true,force:true});
  }
});

test("rejects missing or changed derived video evidence before Writer",async()=>{
  const fixture=await videoFixture();
  try {
    await writeFile(
      join(fixture.workspaceDir,"source-001.transcript.json"),
      '{"tampered":true}\n',
      {mode:0o600}
    );
    await assert.rejects(()=>resolveKnowledgeEvidence({
      workspaceDir:fixture.workspaceDir,
      sourceBindings:[fixture.binding],
      evidenceSourceIds:["source-001"],
      sourceIds:[]
    }),/knowledge_evidence_invalid/u);
  } finally {
    await rm(fixture.workspaceDir,{recursive:true,force:true});
  }
});

test("rejects partial or failed transcript evidence before Writer",async()=>{
  for (const coverageStatus of ["partial","failed"]) {
    const fixture=await videoFixture({coverageStatus});
    try {
      await assert.rejects(()=>resolveKnowledgeEvidence({
        workspaceDir:fixture.workspaceDir,
        sourceBindings:[fixture.binding],
        evidenceSourceIds:["source-001"],
        sourceIds:[]
      }),/knowledge_evidence_invalid/u);
    } finally {
      await rm(fixture.workspaceDir,{recursive:true,force:true});
    }
  }
});

async function videoFixture({coverageStatus="complete"}={}) {
  const workspaceDir=await mkdtemp(join(tmpdir(),"llw-video-evidence-"));
  const videoBytes=Buffer.from("synthetic-public-video");
  const videoSha256=sha256(videoBytes);
  const videoPath=join(workspaceDir,"source-001.mp4");
  await writeFile(videoPath,videoBytes,{mode:0o600});
  const binding={
    handle:{
      sourceId:"source-001",displayName:"公开视频.mp4",
      mediaClass:"video",format:"mp4",
      relativePath:"source-001.mp4",
      byteSize:videoBytes.length,sha256:videoSha256,
      availability:"ready",durationMs:12_000,
      representationIndexPath:"source-001.manifest.json",
      limitations:["公开链接临时取得"]
    },
    absolutePath:videoPath,archiveExtension:"mp4"
  };
  const manifestPath=await createSourceSidecarManifest({
    workspaceDir,
    original:{
      sourceId:"source-001",relativePath:"source-001.mp4",
      byteSize:videoBytes.length,sha256:videoSha256,
      mime:"video/mp4",durationMs:12_000
    },
    now:"2026-07-31T00:00:00.000Z"
  });
  const transcriptPath=join(
    workspaceDir,"source-001.transcript.json"
  );
  await writeFile(transcriptPath,JSON.stringify({
    version:1,sourceId:"source-001",
    originalDurationMs:12_000,coverageStatus,
    limitations:["时间戳不是逐字级"]
  }),{mode:0o600});
  await appendDerivedRepresentation({
    workspaceDir,manifestPath,
    entry:{
      kind:"transcript",
      relativePath:"source-001.transcript.json",
      producedBy:"llw.public-video-reader.v1",
      limitations:["时间戳不是逐字级"]
    },
    now:"2026-07-31T00:00:01.000Z"
  });
  const timelinePath=join(
    workspaceDir,"source-001.timeline.json"
  );
  await writeFile(timelinePath,JSON.stringify({
    version:1,sourceId:"source-001",
    originalSha256:videoSha256,kind:"video_timeline",
    durationMs:12_000,coverageStatus:"complete",
    limitations:["完整时间线导航"]
  }),{mode:0o600});
  await appendDerivedRepresentation({
    workspaceDir,manifestPath,
    entry:{
      kind:"timeline",
      relativePath:"source-001.timeline.json",
      producedBy:"llw.public-video-reader.v1",
      limitations:["完整时间线导航"]
    },
    now:"2026-07-31T00:00:02.000Z"
  });
  return {
    workspaceDir,binding,videoBytes,videoSha256,
    transcriptSha256:sha256(await readFile(transcriptPath)),
    timelineSha256:sha256(await readFile(timelinePath))
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
