import test from "node:test";
import assert from "node:assert/strict";
import {PersonalAssistantClient} from "../src/personal-assistant/client.mjs";
import {PersonalAssistantCoordinator} from "../src/personal-assistant/coordinator.mjs";
import {
  PersonalAssistantDispatcher
} from "../src/personal-assistant/dispatcher.mjs";

function message({
  source="feishu",id="m1",instructionText="总结附件",attachments=[]
}={}) {
  return {
    source,sourceMessageId:id,userId:"owner",conversationId:"private",
    receivedAt:"2026-07-28T00:00:00.000Z",
    instructionText,attachments,
    replyTarget:{
      source,sourceMessageId:id,conversationId:"private",
      ...(source==="wechat"?{contextToken:"ctx"}:{})
    }
  };
}

test("DeepSeek attachment is rejected before download, preparation, AI or Writer",async()=>{
  let prepares=0,assistantCalls=0,writerCalls=0;
  const saved=[],sent=[];
  const coordinator=new PersonalAssistantCoordinator({
    prepareSource:async()=>{prepares+=1;throw new Error("must_not_prepare");},
    assistant:{async decide(){assistantCalls+=1;}},
    writer:{async commit(){writerCalls+=1;}},
    outcomeStore:{
      async get(){return null;},
      async save(outcome){saved.push(structuredClone(outcome));},
      async markReplied(){}
    },
    messenger:{async send(value){sent.push(structuredClone(value));}},
    personalRules:[],selectModel:async()=>"deepseek",
    model:"codex",skillVersion:"4.0.1"
  });
  const result=await coordinator.handle(message({
    attachments:[{
      type:"file",sourceAttachmentId:"file_1",
      displayName:"材料.pdf",extension:"pdf"
    }]
  }));
  assert.equal(result.status,"rejected");
  assert.equal(prepares,0);
  assert.equal(assistantCalls,0);
  assert.equal(writerCalls,0);
  assert.equal(saved.length,1);
  assert.equal(sent.length,1);
});

test("unsafe tool arguments become one failure Outcome and duplicate delivery does no work",async()=>{
  const outcomes=new Map(),sent=[];
  let assistantCalls=0,writerCalls=0;
  const state={
    hasOutcome:key=>outcomes.has(key),
    getOutcome:key=>outcomes.get(key)||null,
    async saveOutcome(key,outcome){
      outcomes.set(key,{...structuredClone(outcome),replied:false});
    },
    async markReplied(key){outcomes.get(key).replied=true;},
    unreplied(){return [];}
  };
  const coordinator=new PersonalAssistantCoordinator({
    prepareSource:async()=>({
      workspaceDir:"/private/tmp/llw-turn-fault",
      sources:[],cleanup:async()=>{}
    }),
    assistant:new PersonalAssistantClient({
      codex:async()=>{
        assistantCalls+=1;
        return {
          type:"tool_call",toolName:"save_knowledge",
          arguments:{
            libraryKey:"personal-knowledge",folderSegments:["安全"],
            title:"测试",summary:"安全摘要。",tags:[],
            sourceIds:[],
            knowledgeSections:{
              keyFacts:["安全事实。"],
              structureAndMainContent:"安全内容。",
              reusableContent:[],sourceNotes:"完整来源。",
              contentIndex:"一段。"
            },
            absolutePath:"/private/escape"
          }
        };
      },
      deepseek:async()=>{throw new Error("unexpected");}
    }),
    writer:{async commit(){writerCalls+=1;}},
    outcomeStore:{
      get:key=>state.getOutcome(key),
      save:(outcome,key)=>state.saveOutcome(key,outcome),
      markReplied:key=>state.markReplied(key)
    },
    messenger:{async send(value){sent.push(structuredClone(value));}},
    personalRules:[],model:"codex",skillVersion:"4.0.1"
  });
  const dispatcher=new PersonalAssistantDispatcher({
    binding:{senderId:"owner",chatId:"private"},
    bindings:{feishu:{userId:"owner",conversationId:"private"}},
    state,coordinator,modelMode:{},deepseekEnabled:false,
    messenger:{async send(value){sent.push(structuredClone(value));}}
  });
  const input=message({id:"unsafe-1",instructionText:"保存这段内容"});
  assert.deepEqual(await dispatcher.handleIncomingMessage(input),{
    handled:true,status:"failed"
  });
  assert.equal(assistantCalls,1);
  assert.equal(writerCalls,0);
  assert.equal(outcomes.get("feishu:unsafe-1").status,"failed");
  assert.deepEqual(await dispatcher.handleIncomingMessage(input),{
    handled:false,reason:"duplicate"
  });
  assert.equal(assistantCalls,1);
  assert.equal(sent.length,1);
});

test("reply failure recovery reuses the persisted Outcome without a second AI call",async()=>{
  const outcomes=new Map();
  let prepares=0,assistantCalls=0,sends=0;
  const outcomeStore={
    async get(key){return outcomes.get(key)||null;},
    async save(outcome,key){
      outcomes.set(key,{...structuredClone(outcome),replied:false});
    },
    async markReplied(key){outcomes.get(key).replied=true;}
  };
  const createCoordinator=()=>new PersonalAssistantCoordinator({
    prepareSource:async()=>{
      prepares+=1;
      return {
        preparedSource:{},evidence:null,imageFiles:[],cleanup:async()=>{}
      };
    },
    assistant:{async decide(){
      assistantCalls+=1;
      return {kind:"reply",text:"只读结果。"};
    }},
    outcomeStore,
    messenger:{async send(){
      sends+=1;
      if (sends===1) throw new Error("synthetic_reply_failure");
    }},
    personalRules:[],model:"codex",skillVersion:"4.0.1"
  });
  const input=message({id:"reply-1",instructionText:"只读回答"});
  await assert.rejects(createCoordinator().handle(input),/synthetic_reply_failure/);
  assert.equal(outcomes.get("feishu:reply-1").replied,false);
  const recovered=await createCoordinator().handle(input);
  assert.equal(recovered.status,"committed");
  assert.equal(outcomes.get("feishu:reply-1").replied,true);
  assert.equal(prepares,1);
  assert.equal(assistantCalls,1);
  assert.equal(sends,2);
});

test("Writer publication failure never triggers a second assistant decision",async()=>{
  let assistantCalls=0,writerCalls=0;
  const saved=[];
  const coordinator=new PersonalAssistantCoordinator({
    prepareSource:async()=>({
      workspaceDir:"/private/tmp/llw-turn-fault",
      sources:[],cleanup:async()=>{}
    }),
    assistant:new PersonalAssistantClient({
      codex:async()=>{
        assistantCalls+=1;
        return {
          type:"tool_call",toolName:"save_knowledge",
          arguments:{
            libraryKey:"personal-knowledge",folderSegments:["安全"],
            title:"测试",summary:"安全摘要。",tags:[],
            sourceIds:[],
            knowledgeSections:{
              keyFacts:["安全事实。"],
              structureAndMainContent:"安全内容。",
              reusableContent:[],sourceNotes:"完整来源。",
              contentIndex:"一段。"
            }
          }
        };
      },
      deepseek:async()=>{throw new Error("unexpected");}
    }),
    writer:{async commit(){
      writerCalls+=1;
      throw new Error("synthetic_publish_failure");
    }},
    outcomeStore:{
      async get(){return null;},
      async save(outcome){saved.push(structuredClone(outcome));},
      async markReplied(){}
    },
    messenger:{async send(){}},
    personalRules:[],model:"codex",skillVersion:"4.0.1"
  });
  const result=await coordinator.handle(message({
    id:"writer-1",instructionText:"保存这段内容"
  }));
  assert.equal(result.status,"failed");
  assert.equal(assistantCalls,1);
  assert.equal(writerCalls,1);
  assert.equal(saved.length,1);
});
