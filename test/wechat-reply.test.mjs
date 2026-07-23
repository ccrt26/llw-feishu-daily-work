import test from "node:test";
import assert from "node:assert/strict";
import {createWechatMessenger} from "../src/adapters/wechat-reply.mjs";

test("replies only to the bound owner with the original context and a stable client id",async () => {
  const calls=[];
  const messenger=createWechatMessenger({
    api:{sendMessage:async value=>calls.push(value)},
    boundUserId:"wx-owner"
  });
  const message={
    capability:"daily-work",
    replyTarget:{
      source:"wechat",sourceMessageId:"1001",conversationId:"wx-owner",contextToken:"test-context"
    },
    text:"已记录",
    idempotencyKey:"reply:wechat:1001"
  };
  await messenger.send(message);
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0],{
    toUserId:"wx-owner",
    contextToken:"test-context",
    text:"已记录",
    clientId:calls[0].clientId
  });
  assert.match(calls[0].clientId,/^llw-[a-f0-9]{32}$/);
  await messenger.send(message);
  assert.equal(calls[1].clientId,calls[0].clientId);
});

test("rejects missing context, another target and non-WeChat reply targets before send",async () => {
  let calls=0;
  const messenger=createWechatMessenger({
    api:{sendMessage:async()=>{calls++;}},
    boundUserId:"wx-owner"
  });
  const target={
    source:"wechat",sourceMessageId:"1001",conversationId:"wx-owner",contextToken:"test-context"
  };
  for (const replyTarget of [
    {...target,contextToken:""},
    {...target,conversationId:"wx-other"},
    {source:"feishu",sourceMessageId:"m1",conversationId:"c1"}
  ]) {
    await assert.rejects(
      ()=>messenger.send({replyTarget,text:"已记录",idempotencyKey:"reply:wechat:1001"}),
      /invalid_reply_target/
    );
  }
  assert.equal(calls,0);
});
