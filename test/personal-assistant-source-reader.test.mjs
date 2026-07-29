import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {
  chmod,mkdtemp,writeFile
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {SourceReader} from "../src/personal-assistant/source-reader.mjs";

const source={
  handle:{
    sourceId:"source-001",displayName:"测试视频.mov",
    mediaClass:"video",format:"mov",relativePath:"source-001.mov",
    byteSize:2_000,sha256:"a".repeat(64),availability:"ready",
    durationMs:12_000,instructionRole:"source_content",
    representationIndexPath:"source-001.manifest.json",limitations:[]
  }
};

test("returns one verified observation and reuses it on an identical retry",async()=>{
  const workspaceDir=await mkdtemp(join(tmpdir(),"llw-source-reader-"));
  await chmod(workspaceDir,0o700);
  let backendCalls=0;
  const reader=new SourceReader({
    backends:{
      inspect_time_range:async()=>{
        backendCalls+=1;
        const content="画面中出现固定测试代号。";
        const derivedRelativePath="source-001.inspect-001.txt";
        await writeFile(
          join(workspaceDir,derivedRelativePath),content,{mode:0o600}
        );
        return {
          content,derivedRelativePath,
          sha256:createHash("sha256").update(content).digest("hex"),
          producedBy:"synthetic-reader",
          limitations:["这是指定时间段的派生观察"]
        };
      }
    }
  });
  const input={
    requests:[{
      sourceId:"source-001",view:"inspect_time_range",
      startMs:5_000,endMs:7_000
    }],
    sources:[source],workspaceDir
  };
  const first=await reader.read(input);
  const second=await reader.read(input);
  assert.deepEqual(second,first);
  assert.equal(backendCalls,1);
  assert.equal(first.observations[0].sourceId,"source-001");
  assert.equal(first.observations[0].content,"画面中出现固定测试代号。");
  assert.equal(
    first.observations[0].derivedRelativePath,
    "source-001.inspect-001.txt"
  );
});

test("does not call a source backend after cancellation",async()=>{
  const workspaceDir=await mkdtemp(join(tmpdir(),"llw-source-reader-cancel-"));
  await chmod(workspaceDir,0o700);
  const controller=new AbortController();
  controller.abort();
  const reader=new SourceReader({
    backends:{
      probe_media:async()=>{
        throw new Error("backend_must_not_run");
      }
    }
  });
  await assert.rejects(
    ()=>reader.read({
      requests:[{sourceId:"source-001",view:"probe_media"}],
      sources:[source],workspaceDir,signal:controller.signal
    }),
    error=>error?.name==="AbortError"
  );
});
