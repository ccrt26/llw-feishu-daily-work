import test from "node:test";
import assert from "node:assert/strict";
import {PersonalAssistantCoordinator} from "../src/personal-assistant/coordinator.mjs";

const base={
  source:"feishu",sourceMessageId:"m1",
  receivedAt:"2026-07-28T00:00:00.000Z",
  instructionText:"生成 Word",attachments:[],
  replyTarget:{source:"feishu",sourceMessageId:"m1",conversationId:"c1"}
};

test("dispatches create_document through its one registered executor",async()=>{
  let generated=0,saved=0;
  const coordinator=new PersonalAssistantCoordinator({
    prepareSource:async()=>({
      workspaceDir:"/private/tmp/llw-turn-document-test",
      sources:[],cleanup:async()=>{}
    }),
    assistant:{async decide(){return {kind:"tool",toolCall:{
      name:"create_document",arguments:{
        sourceIds:[],format:"docx",title:"交流方案",content:"正文"
      }
    }};}},
    writer:{},dailyWriter:{},invoiceWriter:{},
    documentWorkspace:{async generate(){
      generated+=1;
      return {
        kind:"docx",path:"/private/output/交流方案.docx",
        displayName:"交流方案.docx",mime:"application/docx",
        sha256:"a".repeat(64),size:100
      };
    },async verifyPublished(){return true;}},
    artifactGenerator:async()=>{},
    outcomeStore:{async get(){return null;},async save(){saved+=1;}},
    messenger:{async send(){}},personalRules:[],model:"codex",skillVersion:"4.0.1"
  });
  const result=await coordinator.handle(base);
  assert.equal(generated,1);
  assert.equal(saved,1);
  assert.equal(result.replyFile.kind,"docx");
});

test("labels an unknown post-decision failure with its bounded phase",async()=>{
  const coordinator=new PersonalAssistantCoordinator({
    prepareSource:async()=>({
      workspaceDir:"/private/tmp/llw-turn-stage-test",
      sources:[],cleanup:async()=>{}
    }),
    assistant:{async decide(){return {kind:"reply",text:"只读回答"};}},
    writer:{},dailyWriter:{},invoiceWriter:{},
    outcomeStore:{async get(){return null;},async save(){}},
    messenger:{async send(){}},
    conversationStore:{
      async get(){return null;},
      async clear(){throw new Error("private_state_detail");}
    },
    personalRules:[],model:"codex",skillVersion:"4.0.1"
  });
  await assert.rejects(
    coordinator.handle({...base,instructionText:"只读回答"}),
    error=>error.message==="private_state_detail"&&
      error.failurePhase==="conversation_state_failed"
  );
});

test("labels an unknown model-selection failure before source preparation",async()=>{
  const coordinator=new PersonalAssistantCoordinator({
    prepareSource:async()=>{throw new Error("must_not_prepare");},
    assistant:{async decide(){throw new Error("must_not_decide");}},
    writer:{},dailyWriter:{},invoiceWriter:{},
    outcomeStore:{async get(){return null;},async save(){}},
    messenger:{async send(){}},
    conversationStore:{async get(){return null;}},
    selectModel:async()=>{throw new Error("private_model_state_detail");},
    personalRules:[],model:"codex",skillVersion:"4.0.1"
  });
  await assert.rejects(
    coordinator.handle(base),
    error=>error.message==="private_model_state_detail"&&
      error.failurePhase==="model_selection_failed"
  );
});
