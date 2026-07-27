import test from "node:test";
import assert from "node:assert/strict";
import {PersonalAssistantCoordinator} from "../src/personal-assistant/coordinator.mjs";

test("same-turn PDF instruction returns a summary with zero Writer calls",async()=>{
  let assistantCalls=0,writerCalls=0,saves=0,sends=0;
  const coordinator=new PersonalAssistantCoordinator({
    prepareSource:async()=>({
      preparedSource:{},
      evidence:{
        kind:"pdf",displayName:"材料.pdf",byteSize:100,
        sha256:"a".repeat(64),text:"PDF 正文",structure:[{page:1}],
        integrity:"complete",limitations:[],jobRef:"source.pdf"
      }
    }),
    assistant:{async decide(context){
      assistantCalls+=1;
      assert.equal(context.instructionText,"总结这份 PDF，不要保存");
      return {kind:"reply",text:"这份 PDF 主要说明了测试内容。"};
    }},
    writer:{async commit(){ writerCalls+=1; }},
    outcomeStore:{async get(){return null;},async save(){saves+=1;}},
    messenger:{async send(){sends+=1;}},
    personalRules:["普通附件默认保存"],model:"codex",skillVersion:"4.0.1"
  });
  const result=await coordinator.handle({
    source:"feishu",sourceMessageId:"m-pdf",
    receivedAt:"2026-07-28T00:00:00.000Z",
    instructionText:"总结这份 PDF，不要保存",
    attachments:[{type:"file",displayName:"材料.pdf",extension:"pdf"}],
    replyTarget:{source:"feishu",sourceMessageId:"m-pdf",conversationId:"c1"}
  });
  assert.equal(result.status,"committed");
  assert.equal(assistantCalls,1);
  assert.equal(writerCalls,0);
  assert.equal(saves,1);
  assert.equal(sends,1);
});

test("partial Office evidence is exposed as partial, never as fully understood",async()=>{
  const coordinator=new PersonalAssistantCoordinator({
    prepareSource:async()=>({
      preparedSource:{},
      evidence:{
        kind:"pptx",displayName:"材料.pptx",byteSize:100,
        sha256:"a".repeat(64),text:"已提取文字",structure:[],
        integrity:"partial",limitations:["charts_not_extracted"],
        jobRef:"source.pptx"
      }
    }),
    assistant:{async decide(context){
      assert.equal(context.sourceEvidence.integrity,"partial");
      return {kind:"reply",text:"仅根据已提取文字总结；图表未读取。"};
    }},
    writer:{},outcomeStore:{async get(){return null;},async save(){}},
    messenger:{async send(){}},personalRules:[],model:"codex",skillVersion:"4.0.1"
  });
  const result=await coordinator.handle({
    source:"wechat",sourceMessageId:"m1",
    receivedAt:"2026-07-28T00:00:00.000Z",
    instructionText:"根据已读文字总结",attachments:[{}],
    replyTarget:{source:"wechat",sourceMessageId:"m1",conversationId:"c",contextToken:"t"}
  });
  assert.match(result.reply,/图表未读取/);
});
