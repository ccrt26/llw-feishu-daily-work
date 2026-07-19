import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEvent } from "../src/core/event-normalizer.mjs";
import { checkSecurity } from "../src/core/security-gate.mjs";
import { routeCapability } from "../src/core/capability-router.mjs";

const raw = {
  event_id: "e1",
  message_id: "m1",
  sender_id: "u1",
  chat_id: "c1",
  chat_type: "p2p",
  message_type: "image",
  content: "![Image](img_abc)",
  create_time: "1784426400000"
};

test("normalizes the exact lark event fields", () => {
  assert.deepEqual(normalizeEvent(raw), {
    eventId: "e1",
    messageId: "m1",
    senderId: "u1",
    chatId: "c1",
    chatType: "p2p",
    messageType: "image",
    content: "![Image](img_abc)",
    createTimeMs: 1784426400000
  });
});

test("rejects malformed events before routing", () => {
  for (const event of [
    null,
    {...raw, event_id: ""},
    {...raw, message_id: null},
    {...raw, chat_type: "topic"},
    {...raw, content: null},
    {...raw, create_time: "bad"},
    {...raw, create_time: "0"}
  ]) assert.throws(() => normalizeEvent(event), /invalid_event/);
});

test("allows only the bound sender in the bound p2p chat", () => {
  const event = normalizeEvent(raw);
  const binding = {senderId: "u1", chatId: "c1"};
  assert.deepEqual(checkSecurity(event, binding), {ok: true});
  assert.deepEqual(checkSecurity({...event, senderId: "u2"}, binding), {ok:false, reason:"sender_not_allowed", notify:false});
  assert.deepEqual(checkSecurity({...event, chatId: "c2"}, binding), {ok:false, reason:"chat_not_allowed", notify:false});
  assert.deepEqual(checkSecurity({...event, chatType: "group"}, binding), {ok:false, reason:"chat_not_p2p", notify:false});
});

test("routes to exactly one capability", () => {
  const event = normalizeEvent(raw);
  const invoice = {name:"invoice", match:item => item.messageType === "image"};
  const daily = {name:"daily-work", match:item => item.messageType === "text"};
  assert.equal(routeCapability(event, {}, [daily, invoice]), invoice);
  assert.equal(routeCapability({...event, messageType:"video"}, {}, [daily, invoice]), null);
});

test("rejects overlapping capability matches with sorted safe names", () => {
  const event = normalizeEvent(raw);
  const invoice = {name:"invoice", match:() => true};
  const other = {name:"other", match:() => true};
  assert.throws(() => routeCapability(event, {}, [other, invoice]), /route_conflict:invoice,other/);
});
