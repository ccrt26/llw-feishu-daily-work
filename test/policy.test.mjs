import test from "node:test";
import assert from "node:assert/strict";
import { checkEvent } from "../src/policy.mjs";

const binding = { senderId: "user-1", chatId: "chat-1" };
const valid = {
  sender_id: "user-1",
  chat_id: "chat-1",
  chat_type: "p2p",
  message_type: "text",
  message_id: "message-1",
  create_time: "1784426400000",
  content: "今天完成了方案评审"
};

test("accepts bound user p2p text", () => {
  assert.deepEqual(checkEvent(valid, binding), {
    ok: true,
    messageId: "message-1",
    createTime: 1784426400000,
    text: "今天完成了方案评审"
  });
});

test("rejects another sender without notification", () => {
  assert.deepEqual(checkEvent({...valid, sender_id: "user-2"}, binding), {
    ok: false,
    reason: "sender_not_allowed",
    notify: false
  });
});

test("rejects groups and unsupported message types", () => {
  assert.equal(checkEvent({...valid, chat_type: "group"}, binding).reason, "chat_not_p2p");
  assert.deepEqual(checkEvent({...valid, message_type: "image"}, binding), {
    ok: false,
    reason: "unsupported_message_type",
    notify: true
  });
});

test("rejects malformed or oversized text", () => {
  assert.equal(checkEvent({...valid, content: "   "}, binding).reason, "empty_text");
  assert.equal(checkEvent({...valid, content: "x".repeat(12001)}, binding).reason, "text_too_long");
  assert.equal(checkEvent({...valid, create_time: "bad"}, binding).reason, "invalid_event");
});
