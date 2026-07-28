import test from "node:test";
import assert from "node:assert/strict";
import {
  executeCreateDocument
} from "../src/personal-assistant/tools/create-document.mjs";

function binding(sourceId,format) {
  return {
    handle:{
      sourceId,displayName:`材料.${format}`,
      mediaClass:new Set(["png","jpg","jpeg","webp"]).has(format)
        ?"image":"document",
      format,relativePath:`${sourceId}.${format}`,byteSize:100,
      sha256:"a".repeat(64),availability:"ready"
    },
    absolutePath:`/private/llw-turn-test/${sourceId}.${format}`
  };
}

test("passes two selected originals into one verified generation job",async()=>{
  const calls=[];
  const result=await executeCreateDocument({
    toolCall:{name:"create_document",arguments:{
      sourceIds:["source-001","source-002"],
      format:"docx",title:"交流方案",content:"# 交流方案\n\n正文"
    }},
    sourceBindings:[
      binding("source-001","png"),binding("source-002","pdf")
    ],
    sessionId:"v401-session",draftVersion:1,
    workspace:{
      async generate(input){
        calls.push(input);
        return {
          kind:"docx",path:"/private/output/v401-session/交流方案.docx",
          displayName:"交流方案.docx",mime:"application/docx",
          sha256:"a".repeat(64),size:1024
        };
      },
      async verifyPublished(){return true;}
    },
    generate:async()=>{}
  });
  assert.equal(calls.length,1);
  assert.deepEqual(
    calls[0].sources.map(source=>source.sourceId),
    ["source-001","source-002"]
  );
  assert.equal(result.status,"committed");
  assert.equal(result.replyFile.sha256,"a".repeat(64));
});

test("rejects unknown sources and artifacts outside FileOutputWorkspace",async()=>{
  let generations=0;
  const base={
    sourceBindings:[binding("source-001","pdf")],
    sessionId:"v401-session",draftVersion:1,
    generate:async()=>{}
  };
  await assert.rejects(()=>executeCreateDocument({
    ...base,
    toolCall:{name:"create_document",arguments:{
      sourceIds:["source-002"],format:"docx",
      title:"交流方案",content:"正文"
    }},
    workspace:{async generate(){generations+=1;}}
  }),/tool_call_invalid/);
  const result=await executeCreateDocument({
    ...base,
    toolCall:{name:"create_document",arguments:{
      sourceIds:["source-001"],format:"docx",
      title:"交流方案",content:"正文"
    }},
    workspace:{
      async generate(){
        generations+=1;
        return {
          kind:"docx",path:"/tmp/outside.docx",
          displayName:"交流方案.docx",sha256:"b".repeat(64),size:10
        };
      },
      async verifyPublished(){return false;}
    }
  });
  assert.equal(generations,1);
  assert.equal(result.status,"failed");
});

test("does not save a generated file into knowledge automatically",async()=>{
  let knowledgeCalls=0;
  const result=await executeCreateDocument({
    toolCall:{name:"create_document",arguments:{
      sourceIds:[],format:"xlsx",title:"清单",content:"项目,状态"
    }},
    sourceBindings:[],sessionId:"v401-session",draftVersion:2,
    workspace:{
      async generate(){
        return {
          kind:"xlsx",path:"/private/output/清单.xlsx",
          displayName:"清单.xlsx",mime:"application/xlsx",
          sha256:"b".repeat(64),size:2048
        };
      },
      async verifyPublished(){return true;}
    },
    generate:async()=>{},
    knowledgeWriter:{async commit(){knowledgeCalls+=1;}}
  });
  assert.equal(result.status,"committed");
  assert.equal(knowledgeCalls,0);
});
