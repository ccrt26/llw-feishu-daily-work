import test from "node:test";
import assert from "node:assert/strict";
import {
  PersonalAssistantCoordinator
} from "../src/personal-assistant/coordinator.mjs";

test("a fourth source-read request becomes a no-write limitation reply",async()=>{
  let assistantCalls=0,readerCalls=0,writerCalls=0;
  const coordinator=new PersonalAssistantCoordinator({
    prepareSource:async()=>({
      workspaceDir:"/private/tmp/llw-v410-limit",
      sources:[{
        handle:{
          sourceId:"source-001",displayName:"测试视频.mov",
          mediaClass:"video",format:"mov",relativePath:"source-001.mov",
          byteSize:2_000,sha256:"a".repeat(64),availability:"ready",
          durationMs:12_000,instructionRole:"source_content",
          representationIndexPath:"source-001.manifest.json",
          limitations:[]
        },
        absolutePath:"/private/tmp/llw-v410-limit/source-001.mov"
      }],
      cleanup:async()=>{}
    }),
    assistant:{async decide(){
      assistantCalls+=1;
      return {
        kind:"source_read",
        requests:[{
          sourceId:"source-001",view:"inspect_time_range",
          startMs:0,endMs:1_000
        }]
      };
    }},
    sourceReader:{async read(){
      readerCalls+=1;
      return {observations:[{
        sourceId:"source-001",view:"inspect_time_range",
        derivedRelativePath:"source-001.inspect-001.txt",
        sha256:"b".repeat(64),producedBy:"synthetic-reader",
        content:"仍不足以可靠回答。",limitations:["合成观察"]
      }]};
    }},
    maxSourceReadRounds:3,
    writer:{async commit(){writerCalls+=1;}},
    dailyWriter:{},invoiceWriter:{},
    outcomeStore:{async get(){return null;},async save(){}},
    messenger:{async send(){}},
    personalRules:[],model:"codex",skillVersion:"4.0.1"
  });
  const outcome=await coordinator.handle({
    source:"wechat",sourceMessageId:"media-limit",
    userId:"owner",conversationId:"conversation",
    receivedAt:"2026-07-29T01:00:00.000Z",
    instructionText:"总结这个视频",attachments:[{}],
    replyTarget:{
      source:"wechat",sourceMessageId:"media-limit",
      conversationId:"conversation",contextToken:"synthetic"
    }
  });
  assert.equal(assistantCalls,4);
  assert.equal(readerCalls,3);
  assert.equal(writerCalls,0);
  assert.equal(outcome.status,"committed");
  assert.match(outcome.reply,/无法继续取得足够的媒体观察/u);
});
