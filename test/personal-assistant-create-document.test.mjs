import test from "node:test";
import assert from "node:assert/strict";
import {executeCreateDocument} from "../src/personal-assistant/tools/create-document.mjs";

test("generates and returns exactly one verified Office artifact",async()=>{
  const calls=[];
  const result=await executeCreateDocument({
    toolCall:{name:"create_document",arguments:{
      format:"docx",title:"交流方案",content:"# 交流方案\n\n正文"
    }},
    sessionId:"v401-session",draftVersion:1,
    workspace:{async generate(input){
      calls.push(input);
      return {
        kind:"docx",path:"/private/output/v401-session/交流方案.docx",
        displayName:"交流方案.docx",mime:"application/docx",
        sha256:"a".repeat(64),size:1024
      };
    }},
    generate:async()=>{}
  });
  assert.equal(calls.length,1);
  assert.equal(calls[0].kind,"docx");
  assert.equal(result.status,"committed");
  assert.equal(result.replyFile.sha256,"a".repeat(64));
  assert.deepEqual(result.artifacts,[]);
});

test("does not save generated files into knowledge automatically",async()=>{
  let knowledgeCalls=0;
  const result=await executeCreateDocument({
    toolCall:{name:"create_document",arguments:{
      format:"xlsx",title:"清单",content:"项目,状态"
    }},
    sessionId:"v401-session",draftVersion:2,
    workspace:{async generate(){
      return {
        kind:"xlsx",path:"/private/output/清单.xlsx",
        displayName:"清单.xlsx",mime:"application/xlsx",
        sha256:"b".repeat(64),size:2048
      };
    }},
    generate:async()=>{},
    knowledgeWriter:{async commit(){ knowledgeCalls+=1; }}
  });
  assert.equal(result.status,"committed");
  assert.equal(knowledgeCalls,0);
});
