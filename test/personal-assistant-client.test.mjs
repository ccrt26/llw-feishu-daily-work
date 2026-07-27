import test from "node:test";
import assert from "node:assert/strict";
import {PersonalAssistantClient} from "../src/personal-assistant/client.mjs";

test("calls exactly one selected provider and validates one tool",async() => {
  const calls=[];
  const client=new PersonalAssistantClient({
    codex:async context=>{
      calls.push(context);
      return {
        type:"tool_call",
        toolName:"save_knowledge",
        arguments:{
          libraryKey:"personal-knowledge",folderSegments:[],
          title:"资料",summary:"资料摘要。",tags:[],
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
    model:"codex",instructionText:"保存",tools:[],sourceEvidence:null
  });
  assert.equal(calls.length,1);
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
