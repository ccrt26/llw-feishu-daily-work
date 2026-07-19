import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DailyWorkService } from "../src/service.mjs";
import { StateStore } from "../src/state-store.mjs";

const binding = {senderId: "user-1", chatId: "chat-1"};
const baseEvent = {sender_id: "user-1", chat_id: "chat-1", chat_type: "p2p", message_type: "text", message_id: "m1", create_time: "1784426400000", content: "今天完成了方案评审"};

function daily(text) {
  return {intent: "daily_work", confidence: "high", evidence: "明确", question: "", source_text: text,
    records: [{occurred_date: "2026-07-19", occurred_time: "10:00", title: "方案评审", people: ["张三"], location: "会议室", summary: "完成方案评审。", follow_ups: [], original_text: text}]};
}

async function harness(classify) {
  const dir = await mkdtemp(join(tmpdir(), "llw-service-"));
  const state = await StateStore.open(join(dir, "state.json"));
  const writes = [];
  const sends = [];
  const writer = {commit: async job => {writes.push(job); return {files: ["亚信工作/每日工作/2026年07月19日/工作记录.md"], recordIds: ["r1"], inserted: true};}};
  const send = async message => {sends.push(message);};
  return {state, writes, sends, service: new DailyWorkService({binding, state, classify, writer, send})};
}

test("clear daily work commits once then returns organized content", async () => {
  const h = await harness(async ({text}) => daily(text));
  await h.service.handleEvent(baseEvent);
  await h.service.handleEvent(baseEvent);
  assert.equal(h.writes.length, 1);
  assert.equal(h.sends.length, 1);
  assert.match(h.sends[0].text, /已入库/);
  assert.match(h.sends[0].text, /完成方案评审/);
  assert.match(h.sends[0].text, /亚信工作\/每日工作\/2026年07月19日\/工作记录.md/);
  assert.equal(h.sends[0].idempotencyKey, "reply:m1");
  assert.equal(h.state.hasOutcome("m1"), true);
});

test("other text never writes", async () => {
  const h = await harness(async ({text}) => ({intent: "other", confidence: "high", evidence: "普通回复", question: "", source_text: text, records: []}));
  await h.service.handleEvent({...baseEvent, content: "收到，谢谢"});
  assert.equal(h.writes.length, 0);
  assert.equal(h.sends[0].text, "这段内容未作为工作记录入库。");
});

test("uncertain waits for yes before writing", async () => {
  const calls = [];
  const h = await harness(async input => {
    calls.push(input);
    return input.forceDaily ? daily(input.text) : {intent: "uncertain", confidence: "low", evidence: "不足", question: "这段内容是否需要作为工作记录入库？", source_text: input.text, records: []};
  });
  await h.service.handleEvent({...baseEvent, content: "这个后面再说"});
  assert.equal(h.writes.length, 0);
  assert.match(h.sends[0].text, /是否需要/);
  assert.equal(h.state.getPending().messageId, "m1");
  await h.service.handleEvent({...baseEvent, message_id: "m2", content: "是"});
  assert.equal(calls[1].forceDaily, true);
  assert.equal(h.writes.length, 1);
  assert.equal(h.state.getPending(), null);
});

test("another sender and group messages are silently ignored", async () => {
  const h = await harness(async ({text}) => daily(text));
  await h.service.handleEvent({...baseEvent, sender_id: "other"});
  await h.service.handleEvent({...baseEvent, chat_type: "group"});
  assert.equal(h.writes.length, 0);
  assert.equal(h.sends.length, 0);
});

test("bound user unsupported attachment is not sent to AI", async () => {
  let classifications = 0;
  const h = await harness(async () => {classifications++; return daily("x");});
  await h.service.handleEvent({...baseEvent, message_type: "image", content: "[图片]"});
  assert.equal(classifications, 0);
  assert.equal(h.sends[0].text, "当前工作记录第一版仅支持纯文字；该附件未下载、未交给 AI、未入库。");
});

test("restart retries only a stored reply", async () => {
  const h = await harness(async ({text}) => daily(text));
  await h.state.saveOutcome("m-old", {status: "committed", reply: "已入库旧记录", recordIds: ["r-old"]});
  await h.service.resumeReplies();
  assert.equal(h.writes.length, 0);
  assert.deepEqual(h.sends[0], {chatId: "chat-1", text: "已入库旧记录", idempotencyKey: "reply:m-old"});
  assert.deepEqual(h.state.unreplied(), []);
});

test("temporary AI failure does not create a false confirmation", async () => {
  const h = await harness(async () => { throw new Error("model_capacity"); });
  await h.service.handleEvent(baseEvent);
  assert.equal(h.writes.length, 0);
  assert.equal(h.state.getPending(), null);
  assert.equal(h.sends[0].text, "AI 暂时不可用，本条未入库；请稍后重新发送。");
});

test("missing Vault never falls back to a Mac directory", async () => {
  const h = await harness(async ({text}) => daily(text));
  h.service.writer.commit = async () => { throw new Error("vault_marker_missing"); };
  await h.service.handleEvent(baseEvent);
  assert.equal(h.writes.length, 0);
  assert.equal(h.sends[0].text, "U盘知识库当前不可用，本条未入库；请连接U盘后重新发送。");
});
