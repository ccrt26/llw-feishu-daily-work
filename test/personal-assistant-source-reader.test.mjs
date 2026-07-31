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
      probe_media:async()=>{
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
    requests:[{sourceId:"source-001",view:"probe_media"}],
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
  assert.deepEqual(first.modelImageFiles,[]);
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

test("returns one verified interval image with its bounded observation",async()=>{
  const workspaceDir=await mkdtemp(join(tmpdir(),"llw-source-reader-image-"));
  await chmod(workspaceDir,0o700);
  const content=JSON.stringify({
    kind:"public_video_interval",
    startMs:5_000,
    endMs:7_000
  });
  const derivedRelativePath="source-001.inspect-5000-7000.json";
  const imageRelativePath="source-001.inspect-5000-7000.png";
  const imageBytes=png(2,2,33);
  await Promise.all([
    writeFile(join(workspaceDir,derivedRelativePath),content,{mode:0o600}),
    writeFile(join(workspaceDir,imageRelativePath),imageBytes,{mode:0o600})
  ]);
  let backendCalls=0;
  const reader=new SourceReader({
    backends:{
      inspect_time_range:async()=>{
        backendCalls+=1;
        return {
          content,
          derivedRelativePath,
          sha256:sha256(content),
          producedBy:"synthetic-range-reader",
          limitations:["uniform_range_sampling"],
          modelImageFiles:[{
            sourceId:"source-001",
            relativePath:imageRelativePath,
            sha256:sha256(imageBytes),
            startMs:5_000,
            endMs:7_000
          }]
        };
      }
    },
    maxRequests:1,
    maxRangeMs:60_000,
    maxTotalRangeMs:60_000,
    maxModelImageFiles:1
  });
  const input={
    requests:[{
      sourceId:"source-001",
      view:"inspect_time_range",
      startMs:5_000,
      endMs:7_000
    }],
    sources:[source],
    workspaceDir
  };
  const first=await reader.read(input);
  const second=await reader.read(input);
  assert.deepEqual(second,first);
  assert.equal(backendCalls,1);
  assert.equal(first.observations[0].content,content);
  assert.deepEqual(first.modelImageFiles,[{
    sourceId:"source-001",
    relativePath:imageRelativePath,
    sha256:sha256(imageBytes),
    startMs:5_000,
    endMs:7_000
  }]);
});

test("rejects forged or excessive interval image evidence",async()=>{
  for (const mode of [
    "wrong_source","wrong_hash","wrong_range","too_many"
  ]) {
    const workspaceDir=await mkdtemp(
      join(tmpdir(),`llw-source-reader-${mode}-`)
    );
    await chmod(workspaceDir,0o700);
    const content=JSON.stringify({mode});
    const derivedRelativePath="source-001.inspect-5000-7000.json";
    const imageRelativePath="source-001.inspect-5000-7000.png";
    const imageBytes=png(2,2,33);
    await Promise.all([
      writeFile(join(workspaceDir,derivedRelativePath),content,{mode:0o600}),
      writeFile(join(workspaceDir,imageRelativePath),imageBytes,{mode:0o600})
    ]);
    const descriptor={
      sourceId:mode==="wrong_source"?"source-002":"source-001",
      relativePath:imageRelativePath,
      sha256:mode==="wrong_hash"?"f".repeat(64):sha256(imageBytes),
      startMs:mode==="wrong_range"?4_000:5_000,
      endMs:7_000
    };
    const reader=new SourceReader({
      backends:{
        inspect_time_range:async()=>({
          content,
          derivedRelativePath,
          sha256:sha256(content),
          producedBy:"synthetic-range-reader",
          limitations:["uniform_range_sampling"],
          modelImageFiles:mode==="too_many"
            ?[descriptor,{...descriptor,
              relativePath:"source-001.inspect-extra.png"
            }]
            :[descriptor]
        })
      },
      maxRequests:1,
      maxRangeMs:60_000,
      maxTotalRangeMs:60_000,
      maxModelImageFiles:1
    });
    await assert.rejects(
      ()=>reader.read({
        requests:[{
          sourceId:"source-001",
          view:"inspect_time_range",
          startMs:5_000,
          endMs:7_000
        }],
        sources:[source],
        workspaceDir
      }),
      /source_reader_result_invalid/u
    );
  }
});

test("applies configured request and total interval bounds before a backend",async()=>{
  let backendCalls=0;
  const workspaceDir=await mkdtemp(join(tmpdir(),"llw-source-reader-limits-"));
  await chmod(workspaceDir,0o700);
  const reader=new SourceReader({
    backends:{
      inspect_time_range:async()=>{
        backendCalls+=1;
        throw new Error("backend_must_not_run");
      }
    },
    maxRequests:1,
    maxRangeMs:60_000,
    maxTotalRangeMs:60_000,
    maxModelImageFiles:1
  });
  await assert.rejects(
    ()=>reader.read({
      requests:[
        {
          sourceId:"source-001",
          view:"inspect_time_range",
          startMs:0,
          endMs:10_000
        },
        {
          sourceId:"source-001",
          view:"inspect_time_range",
          startMs:10_000,
          endMs:20_000
        }
      ],
      sources:[source],
      workspaceDir
    }),
    /source_read_request_invalid/u
  );
  await assert.rejects(
    ()=>reader.read({
      requests:[{
        sourceId:"source-001",
        view:"inspect_time_range",
        startMs:0,
        endMs:60_001
      }],
      sources:[{
        handle:{...source.handle,durationMs:120_000}
      }],
      workspaceDir
    }),
    /source_read_request_invalid/u
  );
  assert.equal(backendCalls,0);
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function png(width,height,totalBytes) {
  const value=Buffer.alloc(Math.max(33,totalBytes),0);
  Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])
    .copy(value,0);
  value.writeUInt32BE(13,8);
  value.write("IHDR",12,"ascii");
  value.writeUInt32BE(width,16);
  value.writeUInt32BE(height,20);
  value[24]=8;
  value[25]=6;
  return value;
}
