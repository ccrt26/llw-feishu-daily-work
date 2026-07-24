import test from "node:test";
import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {fileURLToPath} from "node:url";

const moduleUrl=new URL("../src/core/prepared-image.mjs",import.meta.url);

test("prepares one checked image and owns cleanup around the caller operation",async () => {
  assert.equal(existsSync(fileURLToPath(moduleUrl)),true,"prepared image lifecycle module must exist");
  const {createPreparedImageRunner}=await import(moduleUrl);
  const calls=[];
  const run=createPreparedImageRunner({
    parse:message=>{
      calls.push("parse");
      assert.equal(message.source,"feishu");
      return {fileKey:"img_abc",type:"image"};
    },
    download:async input=>{
      calls.push("download");
      assert.deepEqual(input,{fileKey:"img_abc",type:"image",source:"feishu",messageId:"m1"});
      return {tempDir:"/tmp/job-safe",file:"/tmp/job-safe/attachment.png"};
    },
    inspect:async file=>{
      calls.push("inspect");
      assert.equal(file,"/tmp/job-safe/attachment.png");
      return {kind:"supported_image",format:"png",extension:"png",sizeBytes:321};
    },
    cleanup:async tempDir=>{
      calls.push("cleanup");
      assert.equal(tempDir,"/tmp/job-safe");
    }
  });
  const result=await run({
    source:"feishu",sourceMessageId:"m1",
    attachments:[{type:"image",sourceAttachmentId:"img_abc",displayName:"飞书图片",extension:""}]
  },async preparedImage=>{
    calls.push("operation");
    assert.deepEqual(preparedImage,{
      tempDir:"/tmp/job-safe",
      file:"/tmp/job-safe/attachment.png",
      detectedFormat:"png",
      archiveExtension:"png",
      sizeBytes:321
    });
    return "done";
  });
  assert.equal(result,"done");
  assert.deepEqual(calls,["parse","download","inspect","operation","cleanup"]);
});

test("cleans the downloaded directory after inspection or downstream failures",async () => {
  for (const failAt of ["inspect","operation"]) {
    let cleanupCalls=0;
    const run=await createRunnerForFailure({
      failAt,
      cleanup:async tempDir=>{
        cleanupCalls++;
        assert.equal(tempDir,"/tmp/job-safe");
      }
    });
    await assert.rejects(
      ()=>run({source:"wechat",sourceMessageId:"1001"},async ()=>{
        if (failAt==="operation") throw new Error("operation_failed");
      }),
      new RegExp(`${failAt}_failed`)
    );
    assert.equal(cleanupCalls,1);
  }
});

async function createRunnerForFailure({failAt,cleanup}) {
  const {createPreparedImageRunner}=await import(moduleUrl);
  return createPreparedImageRunner({
    parse:()=>({resourceId:"wxr_0123456789abcdef0123456789abcdef",type:"image"}),
    download:async()=>({tempDir:"/tmp/job-safe",file:"/tmp/job-safe/attachment.png"}),
    inspect:async()=>{
      if (failAt==="inspect") throw new Error("inspect_failed");
      return {kind:"supported_image",format:"png",extension:"png",sizeBytes:10};
    },
    cleanup
  });
}
