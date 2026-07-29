import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,readFile,readdir,stat,writeFile
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Readable} from "node:stream";
import {
  streamSourceToWorkspace
} from "../src/personal-assistant/source-stream.mjs";

test("streams bytes once while hashing and probing only a bounded header",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-source-stream-"));
  const destination=join(root,"source-001.aiff");
  let observedHeader;
  const result=await streamSourceToWorkspace({
    input:Readable.from([Buffer.from("a"),Buffer.from("b"),Buffer.from("c")]),
    destination,maxBytes:3,
    inspectHeader:async({header,byteSize})=>{
      observedHeader=Buffer.from(header);
      return {
        detectedMime:"audio/aiff",format:"aiff",
        durationMs:1_000,limitations:[]
      };
    }
  });
  assert.equal(result.byteSize,3);
  assert.equal(
    result.sha256,
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
  assert.equal(observedHeader.toString("utf8"),"abc");
  assert.equal(await readFile(destination,"utf8"),"abc");
  assert.equal((await stat(destination)).mode&0o777,0o600);
});

test("removes every partial output when the source exceeds its limit",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-source-stream-limit-"));
  const destination=join(root,"source-001.mov");
  await assert.rejects(
    ()=>streamSourceToWorkspace({
      input:Readable.from([Buffer.from("abc"),Buffer.from("def")]),
      destination,maxBytes:5,
      inspectHeader:async()=>({
        detectedMime:"video/quicktime",format:"mov",
        durationMs:1_000,limitations:[]
      })
    }),
    /source_limit_exceeded/u
  );
  assert.deepEqual(await readdir(root),[]);
});

test("a cancelled stream leaves no model-visible media file",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-source-stream-cancel-"));
  const destination=join(root,"source-001.mov");
  const controller=new AbortController();
  controller.abort();
  await assert.rejects(
    ()=>streamSourceToWorkspace({
      input:Readable.from([Buffer.from("abc")]),
      destination,maxBytes:10,signal:controller.signal,
      inspectHeader:async()=>({
        detectedMime:"video/quicktime",format:"mov",
        durationMs:1_000,limitations:[]
      })
    }),
    error=>error?.name==="AbortError"
  );
  assert.deepEqual(await readdir(root),[]);
});

test("never replaces or removes a pre-existing destination",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-source-stream-existing-"));
  const destination=join(root,"source-001.mov");
  await writeFile(destination,"existing",{mode:0o600});
  await assert.rejects(
    ()=>streamSourceToWorkspace({
      input:Readable.from([Buffer.from("new")]),
      destination,maxBytes:10,
      inspectHeader:async()=>({
        detectedMime:"video/quicktime",format:"mov",
        durationMs:1_000,limitations:[]
      })
    }),
    /source_destination_exists/u
  );
  assert.equal(await readFile(destination,"utf8"),"existing");
  assert.deepEqual(await readdir(root),["source-001.mov"]);
});
