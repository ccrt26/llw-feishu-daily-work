import test from "node:test";
import assert from "node:assert/strict";
import {createFeishuIncomingMessage,createReplyTarget} from "../src/core/incoming-message.mjs";

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

test("rejects malformed platform attachments and invalid reply targets",() => {
  for (const malformed of [
    {...event,content:"x![Image](img_abc)"},
    {...event,messageType:"file",content:'<file name="票.pdf"/>'},
    {...event,messageType:"audio",content:"x"}
  ]) assert.throws(()=>createFeishuIncomingMessage(malformed),/invalid_incoming_message/);
  assert.throws(()=>createReplyTarget({source:"feishu",sourceMessageId:"",conversationId:"c1"}),/invalid_reply_target/);
  assert.throws(()=>createReplyTarget({source:"email",sourceMessageId:"m1",conversationId:"c1"}),/invalid_reply_target/);
});
