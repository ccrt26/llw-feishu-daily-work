import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DailyWorkService } from "../src/service.mjs";
import { StateStore } from "../src/state-store.mjs";
import { createDailyWorkCapability } from "../src/capabilities/daily-work/capability.mjs";

const binding = {senderId: "user-1", chatId: "chat-1"};
const baseEvent = {sender_id: "user-1", chat_id: "chat-1", chat_type: "p2p", message_type: "text", message_id: "m1", create_time: "1784426400000", content: "今天完成了方案评审"};
const candidate = {record_id: "90f29b02eb9ec9bb", date: "2026-07-18", occurred_time: "", occurred_end_time: "", title: "标品订单RV会议", people: [], location: "线上", summary: "公司线上召开标品订单RV会议。", follow_ups: ["下周完成EDR安装部署。"]};

function record(originalText, overrides = {}) {
  return {
    occurred_date: "2026-07-19", occurred_time: "10:00", occurred_end_time: "", title: "方案评审",
    people: ["张三"], location: "会议室", summary: "完成方案评审。", follow_ups: [], original_text: originalText,
    ...overrides
  };
}

function createDecision(text) {
  return {action: "create_record", confidence: "high", reason: "明确新工作", question: "", source_text: text, target_record_id: "", records: [record(text)]};
}

async function harness(decide, {catalogEntries = [candidate]} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "llw-service-"));
  const state = await StateStore.open(join(dir, "state.json"));
  const creates = [];
  const supplements = [];
  const sends = [];
  const catalog = {list: async () => structuredClone(catalogEntries)};
  const writer = {
    create: async job => { creates.push(job); return {files: ["亚信工作/每日工作/2026年07月19日/工作记录.md"], recordIds: ["aaaaaaaaaaaaaaaa"], inserted: true}; },
    supplement: async job => { supplements.push(job); return {files: ["亚信工作/每日工作/2026年07月18日/工作记录.md"], recordIds: [job.targetRecordId], updated: true}; }
  };
  const send = async message => { sends.push(message); };
  return {state, creates, supplements, sends, catalog, writer, service: new DailyWorkService({binding, state, decide, catalog, writer, send})};
}

test("clear new work returns one committed outcome without sending", async () => {
  const h = await harness(async ({message}) => createDecision(message.text));
  const result = await h.service.handleEvent(baseEvent);
  assert.equal(h.creates.length, 1);
  assert.equal(h.supplements.length, 0);
  assert.equal(h.sends.length, 0);
  assert.equal(result.status, "committed");
  assert.match(result.reply, /已入库/);
  assert.match(result.reply, /完成方案评审/);
  assert.deepEqual(result.artifacts, ["亚信工作/每日工作/2026年07月19日/工作记录.md"]);
});

test("natural-language clarification supplements the July 18 record instead of creating July 19", async () => {
  const calls = [];
  const supplementText = "我补充一下，参会时间是下午4点30开始，到下午5:30。参会人员包括江苏区的销售。";
  const clarification = "补充的昨天下午线上标品订单RV会议";
  const h = await harness(async input => {
    calls.push(structuredClone(input));
    if (calls.length === 1) {
      return {action: "ask_user", confidence: "low", reason: "需要目标", question: "这是在补充哪一场会议或什么工作事项？", source_text: input.message.text, target_record_id: "", records: []};
    }
    return {
      action: "supplement_record", confidence: "high", reason: "唯一候选", question: "", source_text: input.message.text,
      target_record_id: candidate.record_id,
      records: [record(supplementText, {
        occurred_date: "2026-07-18", occurred_time: "16:30", occurred_end_time: "17:30", title: candidate.title,
        people: ["江苏区销售"], location: "线上", summary: "公司线上召开标品订单RV会议，参会人员包括江苏区销售。", follow_ups: candidate.follow_ups
      })]
    };
  });
  const first = await h.service.handleEvent({...baseEvent, content: supplementText});
  assert.equal(first.status, "awaiting_clarification");
  assert.equal(h.state.getConversation().turns.length, 2);
  const second = await h.service.handleEvent({...baseEvent, message_id: "m2", create_time: "1784426460000", content: clarification});
  assert.equal(calls.length, 2);
  assert.equal(calls[1].message.text, clarification);
  assert.equal(calls[1].conversation.turns[0].text, supplementText);
  assert.equal(calls[1].conversation.turns[1].text, "这是在补充哪一场会议或什么工作事项？");
  assert.deepEqual(calls[1].candidates, [candidate]);
  assert.equal(h.creates.length, 0);
  assert.equal(h.supplements.length, 1);
  assert.equal(h.supplements[0].targetRecordId, candidate.record_id);
  assert.equal(h.supplements[0].record.original_text, supplementText);
  assert.match(second.reply, /已补充到原记录/);
  assert.match(second.reply, /2026年07月18日/);
  assert.equal(h.sends.length, 0);
  assert.equal(h.state.getConversation(), null);
});

test("every reply phrase is sent back to AI without program keyword handling", async () => {
  for (const [index, text] of ["是", "不是这场", "就是昨天那场"].entries()) {
    const calls = [];
    const h = await harness(async input => {
      calls.push(input);
      return {action: "ignore", confidence: "high", reason: "测试", question: "", source_text: input.message.text, target_record_id: "", records: []};
    });
    await h.state.setConversation({id: `c${index}`, status: "open", turns: [{role: "assistant", text: "请说明目标"}], candidateIds: [candidate.record_id]});
    await h.service.handleEvent({...baseEvent, message_id: `reply-${index}`, content: text});
    assert.equal(calls.length, 1);
    assert.equal(calls[0].message.text, text);
  }
});

test("ignore never writes", async () => {
  const h = await harness(async ({message}) => ({action: "ignore", confidence: "high", reason: "普通回复", question: "", source_text: message.text, target_record_id: "", records: []}));
  const result = await h.service.handleEvent({...baseEvent, content: "收到，谢谢"});
  assert.equal(h.creates.length, 0);
  assert.equal(h.supplements.length, 0);
  assert.equal(result.reply, null);
  assert.equal(result.status,"ignored");
  assert.equal(h.sends.length, 0);
});

test("another sender and group messages are silently ignored", async () => {
  let decisions = 0;
  const h = await harness(async ({message}) => { decisions++; return createDecision(message.text); });
  await h.service.handleEvent({...baseEvent, sender_id: "other"});
  await h.service.handleEvent({...baseEvent, chat_type: "group"});
  assert.equal(decisions, 0);
  assert.equal(h.sends.length, 0);
});

test("bound user unsupported attachment is not sent to AI", async () => {
  let decisions = 0;
  const h = await harness(async () => { decisions++; return createDecision("x"); });
  const result = await h.service.handleEvent({...baseEvent, message_type: "image", content: "[图片]"});
  assert.equal(decisions, 0);
  assert.equal(result.reply, "当前工作记录第一版仅支持纯文字；该附件未下载、未交给 AI、未入库。");
  assert.equal(h.sends.length, 0);
});

test("temporary AI failure does not create a false conversation", async () => {
  const h = await harness(async () => { throw new Error("model_capacity"); });
  const result = await h.service.handleEvent(baseEvent);
  assert.equal(h.creates.length, 0);
  assert.equal(h.state.getConversation(), null);
  assert.equal(result.reply, "AI 暂时不可用，本条未入库；请稍后重新发送。");
  assert.equal(h.sends.length, 0);
});

test("missing Vault never falls back to a Mac directory", async () => {
  const h = await harness(async ({message}) => createDecision(message.text));
  h.writer.create = async () => { throw new Error("vault_marker_missing"); };
  const result = await h.service.handleEvent(baseEvent);
  assert.equal(result.reply, "U盘知识库当前不可用，本条未入库；请连接U盘后重新发送。");
  assert.equal(h.sends.length, 0);
});

test("daily-work capability maps only an already-selected normalized event", async () => {
  const received = [];
  const capability = createDailyWorkCapability({service:{handleEvent:async event => {
    received.push(event);
    return {status:"ignored", reply:"未入库", artifacts:[]};
  }}});
  assert.equal(capability.name, "daily-work");
  assert.equal(Object.hasOwn(capability,"match"),false);
  const result = await capability.handle({messageId:"m1", createTimeMs:1784426400000, content:"工作内容", senderId:"u1", chatId:"c1", chatType:"p2p", messageType:"text"});
  assert.equal(result.status, "ignored");
  assert.deepEqual(received[0], {message_id:"m1", create_time:1784426400000, content:"工作内容", sender_id:"u1", chat_id:"c1", chat_type:"p2p", message_type:"text"});
});
