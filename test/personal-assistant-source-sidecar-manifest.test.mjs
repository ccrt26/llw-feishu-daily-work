import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,readFile,writeFile
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  appendDerivedRepresentation,createSourceSidecarManifest
} from "../src/personal-assistant/source-sidecar-manifest.mjs";

const ORIGINAL_SHA="a".repeat(64);

test("records original media and a hashed derived observation separately",async()=>{
  const workspaceDir=await mkdtemp(join(tmpdir(),"llw-sidecar-"));
  const manifestPath=await createSourceSidecarManifest({
    workspaceDir,
    original:{
      sourceId:"source-001",relativePath:"source-001.mov",
      byteSize:2_000,sha256:ORIGINAL_SHA,
      mime:"video/quicktime",durationMs:12_000
    },
    now:"2026-07-29T01:00:00.000Z"
  });
  await writeFile(
    join(workspaceDir,"source-001.transcript.jsonl"),
    '{"startMs":0,"endMs":1000,"text":"测试"}\n',
    {mode:0o600}
  );
  await appendDerivedRepresentation({
    workspaceDir,manifestPath,
    entry:{
      kind:"transcript",
      relativePath:"source-001.transcript.jsonl",
      producedBy:"synthetic-test",
      limitations:["派生转写不是完整原始视频"]
    },
    now:"2026-07-29T01:00:01.000Z"
  });
  const manifest=JSON.parse(await readFile(manifestPath,"utf8"));
  assert.equal(manifest.original.sha256,ORIGINAL_SHA);
  assert.equal(manifest.derived.length,1);
  assert.equal(manifest.derived[0].kind,"transcript");
  assert.match(manifest.derived[0].sha256,/^[a-f0-9]{64}$/u);
  assert.deepEqual(
    manifest.derived[0].limitations,
    ["派生转写不是完整原始视频"]
  );
});

test("rejects traversal instead of writing a sidecar outside the job",async()=>{
  const workspaceDir=await mkdtemp(join(tmpdir(),"llw-sidecar-unsafe-"));
  await assert.rejects(
    ()=>createSourceSidecarManifest({
      workspaceDir,
      original:{
        sourceId:"source-001",relativePath:"../source-001.mov",
        byteSize:2_000,sha256:ORIGINAL_SHA,
        mime:"video/quicktime",durationMs:12_000
      },
      now:"2026-07-29T01:00:00.000Z"
    }),
    /source_sidecar_invalid/u
  );
});

test("allows a document original without duration but still requires media duration",async()=>{
  const workspaceDir=await mkdtemp(join(tmpdir(),"llw-sidecar-document-"));
  const documentPath=await createSourceSidecarManifest({
    workspaceDir,
    original:{
      sourceId:"source-001",
      relativePath:"source-001.pdf",
      byteSize:2_000,
      sha256:ORIGINAL_SHA,
      mime:"application/pdf"
    },
    now:"2026-07-29T01:00:00.000Z"
  });
  const document=JSON.parse(await readFile(documentPath,"utf8"));
  assert.equal(Object.hasOwn(document.original,"durationMs"),false);
  await assert.rejects(
    createSourceSidecarManifest({
      workspaceDir,
      original:{
        sourceId:"source-002",
        relativePath:"source-002.mp4",
        byteSize:2_000,
        sha256:ORIGINAL_SHA,
        mime:"video/mp4"
      },
      now:"2026-07-29T01:00:00.000Z"
    }),
    /source_sidecar_invalid/u
  );
});
