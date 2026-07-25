import test from "node:test";
import assert from "node:assert/strict";
import {createPreparedVisualRunner} from "../src/core/prepared-visual.mjs";

test("prepares one image once and owns cleanup around router plus business work",async()=>{
  const calls=[];
  const run=createPreparedVisualRunner({
    parse:()=>{calls.push("parse");return {fileKey:"img_abc",type:"image"};},
    download:async input=>{calls.push("download");assert.equal(input.source,"feishu");return {tempDir:"/tmp/job",file:"/tmp/job/source.png"};},
    inspect:async()=>{calls.push("inspect");return {kind:"supported_image",format:"png",extension:"png",sizeBytes:321};},
    preparePdf:async()=>{throw new Error("must_not_prepare_pdf");},
    cleanup:async()=>calls.push("cleanup")
  });
  const result=await run({source:"feishu",sourceMessageId:"m1"},async preparedVisual=>{
    calls.push("operation");
    assert.deepEqual(preparedVisual,{
      tempDir:"/tmp/job",
      resourceType:"image",
      analysisInput:{
        originalFile:"/tmp/job/source.png",detectedFormat:"png",archiveExtension:"png",
        pageImages:["/tmp/job/source.png"],extractedText:"",
        documentFacts:{pageCount:1,textAvailable:false}
      }
    });
    return "done";
  });
  assert.equal(result,"done");
  assert.deepEqual(calls,["parse","download","inspect","operation","cleanup"]);
});

test("prepares one PDF once and passes the exact same AnalysisInput onward",async()=>{
  const analysisInput={
    originalFile:"/tmp/job/source.pdf",detectedFormat:"pdf",archiveExtension:"pdf",
    pageImages:["/tmp/job/analysis/page-1.png","/tmp/job/analysis/page-2.png"],
    extractedText:"safe",documentFacts:{pageCount:2,textAvailable:true}
  };
  let downloads=0,inspections=0,preparations=0,cleanups=0;
  const run=createPreparedVisualRunner({
    parse:()=>({resourceId:"wxr_0123456789abcdef0123456789abcdef",type:"file"}),
    download:async()=>{downloads++;return {tempDir:"/tmp/job",file:"/tmp/job/source.pdf"};},
    inspect:async()=>{inspections++;return {kind:"pdf",format:"pdf",extension:"pdf",sizeBytes:456};},
    preparePdf:async input=>{preparations++;assert.deepEqual(input,{file:"/tmp/job/source.pdf"});return analysisInput;},
    cleanup:async()=>{cleanups++;}
  });
  await run({source:"wechat",sourceMessageId:"m2"},async preparedVisual=>{
    assert.equal(preparedVisual.analysisInput,analysisInput);
    assert.equal(preparedVisual.resourceType,"file");
  });
  assert.deepEqual({downloads,inspections,preparations,cleanups},{downloads:1,inspections:1,preparations:1,cleanups:1});
});

test("cleans exactly once after inspect, PDF preparation or downstream failure",async()=>{
  for (const failAt of ["inspect","prepare","operation"]) {
    let cleanups=0;
    const run=createPreparedVisualRunner({
      parse:()=>({fileKey:"file_abc",type:"file"}),
      download:async()=>({tempDir:"/tmp/job",file:"/tmp/job/source.pdf"}),
      inspect:async()=>{if(failAt==="inspect") throw new Error("inspect_failed");return {kind:"pdf",format:"pdf",extension:"pdf",sizeBytes:1};},
      preparePdf:async()=>{if(failAt==="prepare") throw new Error("prepare_failed");return {
        originalFile:"/tmp/job/source.pdf",detectedFormat:"pdf",archiveExtension:"pdf",
        pageImages:["/tmp/job/page-1.png"],extractedText:"",documentFacts:{pageCount:1,textAvailable:false}
      };},
      cleanup:async()=>{cleanups++;}
    });
    await assert.rejects(()=>run({source:"feishu",sourceMessageId:"m1"},async()=>{if(failAt==="operation")throw new Error("operation_failed");}),new RegExp(`${failAt}_failed`));
    assert.equal(cleanups,1);
  }
});
