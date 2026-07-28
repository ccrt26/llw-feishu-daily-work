import test from "node:test";
import assert from "node:assert/strict";
import {PersonalAssistantCoordinator} from "../src/personal-assistant/coordinator.mjs";

function preparedSource(format,displayName) {
  return {
    handle:{
      sourceId:"source-001",displayName,mediaClass:"document",
      format,relativePath:`source-001.${format}`,byteSize:100,
      sha256:"a".repeat(64),availability:"ready"
    },
    absolutePath:`/private/tmp/llw-turn-read-only/source-001.${format}`
  };
}

test("same-turn PDF instruction returns a summary with zero Writer calls",async()=>{
  let assistantCalls=0,writerCalls=0,saves=0,sends=0;
  const coordinator=new PersonalAssistantCoordinator({
    prepareSource:async()=>({
      workspaceDir:"/private/tmp/llw-turn-read-only",
      sources:[preparedSource("pdf","材料.pdf")],cleanup:async()=>{}
    }),
    assistant:{async decide(context){
      assistantCalls+=1;
      assert.equal(context.instructionText,"总结这份 PDF，不要保存");
      assert.equal(context.sources[0].relativePath,"source-001.pdf");
      assert.equal("content" in context.sources[0],false);
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

test("original Office source is exposed as a read-only handle, never pre-parsed evidence",async()=>{
  const coordinator=new PersonalAssistantCoordinator({
    prepareSource:async()=>({
      workspaceDir:"/private/tmp/llw-turn-read-only",
      sources:[preparedSource("pptx","材料.pptx")],cleanup:async()=>{}
    }),
    assistant:{async decide(context){
      assert.equal(context.sources[0].format,"pptx");
      assert.equal("sourceEvidence" in context,false);
      assert.equal("integrity" in context.sources[0],false);
      return {kind:"reply",text:"已直接检查原始 PPTX；未可靠读取的图表会明确说明。"};
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
  assert.match(result.reply,/原始 PPTX/);
});

test("uses the source-preparer instruction override so a Feishu document URL never reaches AI",async()=>{
  let writerCalls=0;
  const coordinator=new PersonalAssistantCoordinator({
    prepareSource:async()=>({
      instructionText:"总结[飞书文档快照]，不保存",
      workspaceDir:"/private/tmp/llw-turn-cloud-read-only",
      sources:[preparedSource("docx","合成云文档.docx")],
      cleanup:async()=>{}
    }),
    assistant:{async decide(context){
      assert.equal(context.instructionText,"总结[飞书文档快照]，不保存");
      assert.equal(context.instructionText.includes("synthetic_token"),false);
      assert.equal(context.sources.length,1);
      return {kind:"reply",text:"云文档摘要。"};
    }},
    writer:{async commit(){writerCalls+=1;}},
    outcomeStore:{async get(){return null;},async save(){}},
    messenger:{async send(){}},personalRules:[],
    model:"codex",skillVersion:"4.0.1"
  });
  const result=await coordinator.handle({
    source:"feishu",sourceMessageId:"cloud-read-only",
    receivedAt:"2026-07-28T00:00:00.000Z",
    instructionText:
      "总结https://example.feishu.cn/docx/synthetic_token，不保存",
    attachments:[],
    replyTarget:{
      source:"feishu",sourceMessageId:"cloud-read-only",conversationId:"c1"
    }
  });
  assert.equal(result.status,"committed");
  assert.equal(writerCalls,0);
});
