import test from "node:test";
import assert from "node:assert/strict";
import {createChannelMessenger} from "../src/adapters/channel-messenger.mjs";

test("selects only the explicit Feishu or WeChat messenger from the reply target",async () => {
  const calls=[];
  const messenger=createChannelMessenger({
    feishu:{send:async message=>calls.push(["feishu",message])},
    wechat:{send:async message=>calls.push(["wechat",message])}
  });
  const feishu={replyTarget:{source:"feishu"},text:"a"};
  const wechat={replyTarget:{source:"wechat"},text:"b"};
  await messenger.send(feishu);
  await messenger.send(wechat);
  assert.deepEqual(calls,[["feishu",feishu],["wechat",wechat]]);
  assert.throws(()=>messenger.send({replyTarget:{source:"email"}}),/invalid_reply_target/);
});

test("keeps Feishu usable when the WeChat messenger is disabled",async () => {
  let calls=0;
  const messenger=createChannelMessenger({
    feishu:{send:async()=>{calls++;}},
    wechat:null
  });
  await messenger.send({replyTarget:{source:"feishu"}});
  assert.throws(()=>messenger.send({replyTarget:{source:"wechat"}}),/invalid_reply_target/);
  assert.equal(calls,1);
});
