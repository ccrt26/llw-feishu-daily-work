import test from "node:test";
import assert from "node:assert/strict";
import { checkDailyWorkMessage } from "../src/policy.mjs";

const valid = {
  source:"feishu",sourceMessageId:"message-1",userId:"user-1",conversationId:"chat-1",receivedAt:"2026-07-19T02:00:00.000Z",
  text:"今天完成了方案评审",attachments:[],replyTarget:{source:"feishu",sourceMessageId:"message-1",conversationId:"chat-1"}
};

test("accepts a secured internal text message", () => {
  assert.deepEqual(checkDailyWorkMessage(valid), {
    ok: true,
    messageId: "message-1",
    createTime: 1784426400000,
    text: "今天完成了方案评审"
  });
});

test("rejects unsupported attachments", () => {
  assert.deepEqual(checkDailyWorkMessage({...valid,text:undefined,attachments:[{type:"image"}]}), {
    ok: false,
    reason: "unsupported_message_type",
    notify: true
  });
});

test("rejects malformed or oversized text", () => {
  assert.equal(checkDailyWorkMessage({...valid, text: "   "}).reason, "empty_text");
  assert.equal(checkDailyWorkMessage({...valid, text: "x".repeat(12001)}).reason, "text_too_long");
  assert.equal(checkDailyWorkMessage({...valid, receivedAt: "bad"}).reason, "invalid_message");
  assert.equal(checkDailyWorkMessage({...valid, sourceMessageId: ""}).reason, "invalid_message");
});
