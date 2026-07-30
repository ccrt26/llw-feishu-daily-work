import test from "node:test";
import assert from "node:assert/strict";
import {PersonalAssistantClient} from "../src/personal-assistant/client.mjs";

test("calls exactly one selected provider and validates one tool",async() => {
  const calls=[];
  const client=new PersonalAssistantClient({
    codex:async (context,options)=>{
      calls.push({context,options});
      return {
        type:"tool_call",
        toolName:"save_knowledge",
        arguments:{
          libraryKey:"personal-knowledge",folderSegments:[],
          title:"资料",summary:"资料摘要。",tags:[],
          sourceIds:[],
          knowledgeSections:{
            keyFacts:["事实"],structureAndMainContent:"正文。",
            reusableContent:[],sourceNotes:"完整来源。",
            contentIndex:"一段。"
          }
        }
      };
    },
    deepseek:async()=>{ throw new Error("unexpected_deepseek"); }
  });
  const decision=await client.decide({
    model:"codex",instructionText:"保存",tools:[],sources:[]
  },{
    workspaceDir:"/private/tmp/llw-turn-test",
    imageFiles:["/private/tmp/llw-turn-test/page.png"],
    modelImageFiles:[{
      sourceId:"source-001",
      relativePath:"source-001.page-001.png",
      sha256:"a".repeat(64),
      pageNumber:1
    }]
  });
  assert.equal(calls.length,1);
  assert.deepEqual(
    calls[0].options.imageFiles,
    ["/private/tmp/llw-turn-test/page.png"]
  );
  assert.equal(calls[0].options.workspaceDir,"/private/tmp/llw-turn-test");
  assert.deepEqual(calls[0].options.modelImageFiles,[{
    sourceId:"source-001",
    relativePath:"source-001.page-001.png",
    sha256:"a".repeat(64),
    pageNumber:1
  }]);
  assert.equal(decision.kind,"tool");
  assert.equal(decision.toolCall.name,"save_knowledge");
});

test("never falls back to another provider after a failure",async() => {
  let deepseekCalls=0;
  const client=new PersonalAssistantClient({
    codex:async()=>{ throw new Error("unavailable"); },
    deepseek:async()=>{ deepseekCalls+=1; }
  });
  await assert.rejects(client.decide({model:"codex"}),/assistant_model_failed/);
  assert.equal(deepseekCalls,0);
});

test("preserves bounded pre-Writer diagnostics without provider fallback",async()=>{
  for (const code of [
    "assistant_timeout",
    "assistant_process_failed",
    "assistant_result_invalid",
    "pdf_prepare_failed"
  ]) {
    let deepseekCalls=0;
    const client=new PersonalAssistantClient({
      codex:async()=>{throw new Error(code);},
      deepseek:async()=>{deepseekCalls+=1;}
    });
    await assert.rejects(
      client.decide({model:"codex",tools:[],sources:[]}),
      error=>error?.message===code
    );
    assert.equal(deepseekCalls,0);
  }
});

test("validates a Codex observation against only the current source set",async()=>{
  const client=new PersonalAssistantClient({
    codex:async()=>({
      type:"source_read_request",
      requests:[{sourceId:"source-001",view:"probe_media"}]
    }),
    deepseek:async()=>{throw new Error("unexpected_deepseek");}
  });
  const decision=await client.decide({
    model:"codex",instructionText:"总结",
    tools:[],
    sources:[{
      sourceId:"source-001",mediaClass:"video",durationMs:12_000,
      displayName:"测试.mov",format:"mov",relativePath:"source-001.mov",
      byteSize:2_000,sha256:"a".repeat(64),availability:"ready"
    }]
  });
  assert.deepEqual(decision,{
    kind:"source_read",
    requests:[{sourceId:"source-001",view:"probe_media"}]
  });
});
