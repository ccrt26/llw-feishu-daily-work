import test from "node:test";
import assert from "node:assert/strict";
import {createFeishuIncomingMessage,createReplyTarget,createWechatIncomingMessage} from "../src/core/incoming-message.mjs";

const event={eventId:"e1",messageId:"m1",senderId:"u1",chatId:"c1",chatType:"p2p",messageType:"image",content:"![Image](img_abc)",createTimeMs:1784426400000};

test("converts a secured Feishu event to the exact minimal IncomingMessage and ReplyTarget",() => {
  assert.deepEqual(createFeishuIncomingMessage(event),{
    source:"feishu",
    sourceMessageId:"m1",
    userId:"u1",
    conversationId:"c1",
    receivedAt:"2026-07-19T02:00:00.000Z",
    attachments:[{type:"image",sourceAttachmentId:"img_abc",displayName:"飞书图片",extension:""}],
    replyTarget:{source:"feishu",sourceMessageId:"m1",conversationId:"c1"}
  });
  assert.deepEqual(createFeishuIncomingMessage({...event,messageType:"text",content:"今天完成评审"}),{
    source:"feishu",sourceMessageId:"m1",userId:"u1",conversationId:"c1",receivedAt:"2026-07-19T02:00:00.000Z",
    text:"今天完成评审",attachments:[],replyTarget:{source:"feishu",sourceMessageId:"m1",conversationId:"c1"}
  });
  assert.deepEqual(createFeishuIncomingMessage({...event,messageType:"file",content:'<file name="folder/发票.PDF" key="file_secret"/> '}).attachments,[
    {type:"file",sourceAttachmentId:"file_secret",displayName:"发票.PDF",extension:"pdf"}
  ]);
});

test("accepts the current lark-cli image marker without widening the resource key boundary",() => {
  assert.deepEqual(createFeishuIncomingMessage({...event,content:"[Image: img_current-123]"}).attachments,[
    {type:"image",sourceAttachmentId:"img_current-123",displayName:"飞书图片",extension:""}
  ]);
  for (const content of [
    "[Image: file_wrong]",
    "[Image: img_bad value]",
    "prefix [Image: img_abc]",
    "[Image: img_abc] suffix"
  ]) assert.throws(()=>createFeishuIncomingMessage({...event,content}),/invalid_incoming_message/);
});

test("rejects malformed platform attachments and invalid reply targets",() => {
  for (const malformed of [
    {...event,content:"x![Image](img_abc)"},
    {...event,messageType:"file",content:'<file name="票.pdf"/>'},
    {...event,messageType:"audio",content:"x"}
  ]) assert.throws(()=>createFeishuIncomingMessage(malformed),/invalid_incoming_message/);
  assert.throws(()=>createReplyTarget({source:"feishu",sourceMessageId:"",conversationId:"c1"}),/invalid_reply_target/);
  assert.throws(()=>createReplyTarget({source:"email",sourceMessageId:"m1",conversationId:"c1"}),/invalid_reply_target/);
});

test("converts one sanitized WeChat text event to the exact minimal internal contract",() => {
  const message=createWechatIncomingMessage({
    messageId:"1001",userId:"wx-owner",conversationId:"wx-owner",
    createTimeMs:1784851200000,type:"text",text:"今天完成评审",
    contextToken:"test-context"
  });
  assert.deepEqual(message,{
    source:"wechat",sourceMessageId:"1001",userId:"wx-owner",
    conversationId:"wx-owner",receivedAt:"2026-07-24T00:00:00.000Z",
    text:"今天完成评审",attachments:[],
    replyTarget:{source:"wechat",sourceMessageId:"1001",conversationId:"wx-owner",contextToken:"test-context"}
  });
  assert.equal(message.contextToken,undefined);
});

test("keeps WeChat reply context out of Feishu targets and rejects raw or malformed WeChat events",() => {
  assert.deepEqual(createReplyTarget({
    source:"feishu",sourceMessageId:"m1",conversationId:"c1",contextToken:"must-not-copy"
  }),{source:"feishu",sourceMessageId:"m1",conversationId:"c1"});
  assert.throws(()=>createReplyTarget({
    source:"wechat",sourceMessageId:"1001",conversationId:"wx-owner"
  }),/invalid_reply_target/);
  for (const malformed of [
    {messageId:"1001",userId:"wx-owner",conversationId:"wx-owner",createTimeMs:1784851200000,type:"voice",text:"x",contextToken:"test-context"},
    {messageId:"1001",userId:"wx-owner",conversationId:"wx-owner",createTimeMs:1784851200000,type:"text",text:"",contextToken:"test-context"},
    {messageId:"1001",userId:"wx-owner",conversationId:"wx-owner",createTimeMs:1784851200000,type:"text",text:"x",contextToken:"test-context",group_id:"raw-group"},
    {messageId:"1001",userId:"wx-owner",conversationId:"wx-owner",createTimeMs:1784851200000,type:"image",contextToken:"test-context",
      attachment:{type:"image",sourceAttachmentId:"media-1",displayName:"微信图片",extension:""},encrypt_query_param:"raw-cdn"},
    {messageId:"1".repeat(513),userId:"wx-owner",conversationId:"wx-owner",createTimeMs:1784851200000,type:"text",text:"x",contextToken:"test-context"},
    {messageId:"1001",userId:"wx-owner",conversationId:"wx-owner",createTimeMs:1784851200000,type:"text",text:"x".repeat(32769),contextToken:"test-context"},
    {messageId:"1001",userId:"wx-owner",conversationId:"wx-owner",createTimeMs:1784851200000,type:"text",text:"x",contextToken:"x".repeat(4097)}
  ]) assert.throws(()=>createWechatIncomingMessage(malformed),/invalid_incoming_message/);
});
