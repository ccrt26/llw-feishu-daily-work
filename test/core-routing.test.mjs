import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEvent } from "../src/core/event-normalizer.mjs";
import { checkSecurity } from "../src/core/security-gate.mjs";
import { createRouterMessage } from "../src/core/router-message.mjs";

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

test("builds minimal router messages without Feishu identifiers or resource keys", () => {
  const event = normalizeEvent(raw);
  const image=createRouterMessage(event);
  assert.deepEqual(image.attachment,{displayName:"飞书图片",extension:"",resourceType:"image"});
  const file=createRouterMessage({...event,messageType:"file",content:'<file name="folder/发票.PDF" key="file_secret"/>'});
  assert.deepEqual(file.attachment,{displayName:"发票.PDF",extension:"pdf",resourceType:"file"});
  const text=createRouterMessage({...event,messageType:"text",content:"今天完成评审"});
  assert.equal(text.text,"今天完成评审");
  const serialized=JSON.stringify([image,file,text]);
  for (const secret of ["img_abc","file_secret","m1","u1","c1","folder/"]) assert.equal(serialized.includes(secret),false);
});
