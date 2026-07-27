import test from "node:test";
import assert from "node:assert/strict";
import {createFeishuIncomingMessage} from "../src/core/incoming-message.mjs";
import {prepareKnowledgeText} from "../src/capabilities/knowledge-ingest/source-preparer.mjs";
import {createSourceEvidence} from "../src/personal-assistant/source-evidence.mjs";
import {PersonalAssistantClient} from "../src/personal-assistant/client.mjs";
import {PersonalAssistantCoordinator} from "../src/personal-assistant/coordinator.mjs";

test("Feishu text travels through real preparation, one assistant, tool, Writer, Outcome and Reply",async() => {
  const order=[];
  let assistantCalls=0,writerCalls=0;
  const toolArguments={
    libraryKey:"personal-knowledge",folderSegments:["学习资料"],
    title:"交流准备",summary:"交流前的准备资料。",tags:["交流"],
    knowledgeSections:{
      keyFacts:["先确认交流目标。"],
      structureAndMainContent:"资料说明目标、对象和后续动作。",
      reusableContent:["交流前确认目标。"],
      sourceNotes:"根据完整文字来源忠实整理。",
      contentIndex:"来源共一段。"
    }
  };
  const assistant=new PersonalAssistantClient({
    codex:async context=>{
      assistantCalls+=1;
      order.push("assistant");
      assert.equal(context.sourceEvidence.integrity,"complete");
      assert.equal(context.instructionText.includes("保存到日常生活"),true);
      return {type:"tool_call",toolName:"save_knowledge",arguments:toolArguments};
    },
    deepseek:async()=>{ throw new Error("unexpected"); }
  });
  const saved=[];
  const sent=[];
  const coordinator=new PersonalAssistantCoordinator({
    prepareSource:async message=>{
      order.push("prepare");
      const prepared={
        ...prepareKnowledgeText({
          text:message.instructionText,maxSourceBytes:262_144
        }),
        content:message.instructionText
      };
      return {preparedSource:prepared,evidence:createSourceEvidence(prepared)};
    },
    assistant,
    writer:{
      async commit(input) {
        writerCalls+=1;
        order.push("writer");
        assert.equal(input.source.extractionIntegrity,"complete");
        return {
          status:"created",knowledgeId:"k1",libraryKey:"personal-knowledge",
          relativePath:"日常生活/学习资料/交流准备",
          files:["日常生活/学习资料/交流准备/knowledge.md"]
        };
      }
    },
    outcomeStore:{
      async get() { return null; },
      async save(outcome) { order.push("outcome"); saved.push(outcome); }
    },
    messenger:{
      async send(target,reply) { order.push("reply"); sent.push({target,reply}); }
    },
    personalRules:[],
    model:"codex",
    skillVersion:"4.0.1"
  });
  const message=createFeishuIncomingMessage({
    messageId:"m-v401",senderId:"owner",chatId:"private-chat",
    messageType:"text",
    content:"把交流目标、对象和后续动作保存到日常生活/学习资料",
    createTimeMs:1785196800000
  });
  const outcome=await coordinator.handle(message);
  assert.deepEqual(order,["prepare","assistant","writer","outcome","reply"]);
  assert.equal(assistantCalls,1);
  assert.equal(writerCalls,1);
  assert.equal(saved.length,1);
  assert.equal(sent.length,1);
  assert.equal(outcome.status,"committed");
});

test("reply recovery reuses Outcome without rerunning assistant or Writer",async() => {
  let assistantCalls=0,writerCalls=0;
  const existing={
    status:"committed",reply:"知识资料已保存。",artifacts:["x/knowledge.md"],
    replyTarget:{source:"feishu",sourceMessageId:"m1",conversationId:"c1"}
  };
  const sent=[];
  const coordinator=new PersonalAssistantCoordinator({
    prepareSource:async()=>{ throw new Error("must_not_prepare"); },
    assistant:{async decide(){ assistantCalls+=1; }},
    writer:{async commit(){ writerCalls+=1; }},
    outcomeStore:{async get(){ return existing; },async save(){ throw new Error("must_not_save"); }},
    messenger:{async send(target,reply){ sent.push({target,reply}); }},
    personalRules:[],model:"codex",skillVersion:"4.0.1"
  });
  await coordinator.handle({
    source:"feishu",sourceMessageId:"m1",receivedAt:"2026-07-28T00:00:00.000Z",
    instructionText:"重复",attachments:[],
    replyTarget:{source:"feishu",sourceMessageId:"m1",conversationId:"c1"}
  });
  assert.equal(assistantCalls,0);
  assert.equal(writerCalls,0);
  assert.equal(sent.length,1);
});
