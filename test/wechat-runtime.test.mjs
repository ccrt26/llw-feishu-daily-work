import test from "node:test";
import assert from "node:assert/strict";
import {createWechatApi} from "../src/adapters/wechat-api.mjs";
import {startWechatListener} from "../src/adapters/wechat-runtime.mjs";
import {Dispatcher} from "../src/core/dispatcher.mjs";

const owner="wx-owner";
const apiBaseUrl="https://ilinkai.weixin.qq.com";
const apiToken="test-secret-token";
const apiUin="MTIzNDU2";
const baseMessage={
  message_id:1001,
  from_user_id:owner,
  to_user_id:"bot-test",
  create_time_ms:1784851200000,
  message_type:1,
  message_state:2,
  context_token:"test-context",
  item_list:[{type:1,text_item:{text:"今天完成评审"}}]
};

function state(cursor="cursor-1") {
  const writes=[];
  return {
    resources:new Map(),
    writes,
    readCursor:async()=>cursor,
    writeCursor:async value=>writes.push(value)
  };
}

function rawTextMessage(idToken,text='"/llw-model status"') {
  return `{"message_id":${idToken},"from_user_id":"${owner}","to_user_id":"bot-test",`+
    '"create_time_ms":1784851200000,"message_type":1,"message_state":2,'+
    `"context_token":"test-context","item_list":[{"type":1,"text_item":{"text":${text}}}]}`;
}

function apiFromBodies(bodies) {
  return createWechatApi({
    baseUrl:apiBaseUrl,token:apiToken,uIn:apiUin,
    fetchImpl:async()=>new Response(bodies.shift(),{headers:{"content-type":"application/json"}})
  });
}

test("delivers only one bound p2p finished user text and atomically advances its cursor",async () => {
  const messages=[
    baseMessage,
    {...baseMessage,message_id:1002,from_user_id:"wx-other"},
    {...baseMessage,message_id:1003,group_id:"group-1"},
    {...baseMessage,message_id:1004,message_type:2},
    {...baseMessage,message_id:1005,message_state:1},
    {...baseMessage,message_id:1006,item_list:[{type:5,video_item:{}}]},
    {...baseMessage,message_id:1007,item_list:[{type:3,voice_item:{}}]},
    {...baseMessage,message_id:1008,item_list:[...baseMessage.item_list,...baseMessage.item_list]},
    structuredClone(baseMessage)
  ];
  const channelState=state();
  const received=[],errors=[];
  const replies=[
    {ret:0,msgs:messages,get_updates_buf:"cursor-2"},
    {ret:1,errcode:-14,errmsg:"secret expired"}
  ];
  const listener=await startWechatListener({
    api:{getUpdates:async()=>replies.shift()},
    state:channelState,
    binding:{userId:owner,conversationId:owner},
    onMessage:async message=>received.push(message),
    onError:error=>errors.push(error),
    retryDelayMs:0
  });
  await listener.done;
  assert.deepEqual(received,[{
    source:"wechat",
    sourceMessageId:"1001",
    userId:owner,
    conversationId:owner,
    receivedAt:"2026-07-24T00:00:00.000Z",
    text:"今天完成评审",
    attachments:[],
    replyTarget:{
      source:"wechat",sourceMessageId:"1001",conversationId:owner,contextToken:"test-context"
    }
  }]);
  assert.deepEqual(channelState.writes,["cursor-2"]);
  assert.deepEqual(errors,[{stage:"wechat_poll",code:"wechat_auth_expired"}]);
  assert.equal(JSON.stringify([received,errors]).includes("secret expired"),false);
});

test("keeps adjacent large JSON message IDs distinct through reply idempotency and deduplicates an exact repeat",async () => {
  const first="9007199254740992";
  const second="9007199254740993";
  const api=apiFromBodies([
    `{"msgs":[${rawTextMessage(first)},${rawTextMessage(second)},${rawTextMessage(second)}],"get_updates_buf":"cursor-2"}`,
    '{"errcode":-14}'
  ]);
  const channelState=state();
  const outcomes=new Map();
  const sends=[];
  const dispatcher=new Dispatcher({
    binding:{senderId:"feishu-owner",chatId:"feishu-chat"},
    bindings:{
      feishu:{userId:"feishu-owner",conversationId:"feishu-chat"},
      wechat:{userId:owner,conversationId:owner}
    },
    state:{
      hasOutcome:key=>outcomes.has(key),
      saveOutcome:async (key,value)=>{
        if (!outcomes.has(key)) outcomes.set(key,{...structuredClone(value),replied:false});
        return structuredClone(outcomes.get(key));
      },
      markReplied:async key=>{ outcomes.get(key).replied=true; }
    },
    capabilities:[],
    intentRouter:{decide:async()=>{throw new Error("must_not_route");}},
    messenger:{send:async value=>sends.push(structuredClone(value))},
    modelMode:{read:async()=>"codex",write:async()=>{throw new Error("must_not_write");}},
    deepseekEnabled:true
  });
  const errors=[];
  const listener=await startWechatListener({
    api,state:channelState,
    binding:{userId:owner,conversationId:owner},
    onMessage:message=>dispatcher.handleIncomingMessage(message),
    onError:error=>errors.push(error),
    retryDelayMs:0
  });
  await listener.done;

  assert.deepEqual([...outcomes.keys()],[`wechat:${first}`,`wechat:${second}`]);
  assert.deepEqual(sends.map(value=>value.replyTarget.sourceMessageId),[first,second]);
  assert.deepEqual(sends.map(value=>value.idempotencyKey),[
    `reply:wechat:${first}`,
    `reply:wechat:${second}`
  ]);
  assert.deepEqual(channelState.writes,["cursor-2"]);
  assert.deepEqual(errors,[{stage:"wechat_poll",code:"wechat_auth_expired"}]);
});

test("keeps invalid decimal forms out of the Dispatcher without exposing IDs or text in errors",async () => {
  const marker="invalid-message-body-marker";
  const api=apiFromBodies([
    `{"msgs":[
      ${rawTextMessage("1.5",JSON.stringify(marker))},
      ${rawTextMessage("1e3",JSON.stringify(marker))},
      ${rawTextMessage("-1",JSON.stringify(marker))},
      ${rawTextMessage("0",JSON.stringify(marker))},
      ${rawTextMessage("11111111111111111111111111111111",JSON.stringify(marker))},
      ${rawTextMessage("null",JSON.stringify(marker))},
      ${rawTextMessage("[]",JSON.stringify(marker))},
      ${rawTextMessage("{}",JSON.stringify(marker))},
      ${rawTextMessage('"1e3"',JSON.stringify(marker))},
      ${rawTextMessage('"11111111111111111111111111111111"',JSON.stringify(marker))}
    ],"get_updates_buf":"cursor-2"}`,
    '{"errcode":-14}'
  ]);
  const received=[],errors=[];
  const listener=await startWechatListener({
    api,state:state(),
    binding:{userId:owner,conversationId:owner},
    onMessage:async message=>received.push(message),
    onError:error=>errors.push(error),
    retryDelayMs:0
  });
  await listener.done;

  assert.deepEqual(received,[]);
  assert.deepEqual(errors,[{stage:"wechat_poll",code:"wechat_auth_expired"}]);
  assert.equal(JSON.stringify(errors).includes(marker),false);
  assert.equal(JSON.stringify(errors).includes("11111111111111111111111111111111"),false);
});

test("contains network failures and bounded retries inside the WeChat listener",async () => {
  const channelState=state();
  const errors=[];
  let calls=0;
  const listener=await startWechatListener({
    api:{getUpdates:async()=>{
      calls++;
      if (calls===1) throw new Error("network secret");
      if (calls===2) throw new Error("wechat_timeout");
      return {ret:1,errcode:-14};
    }},
    state:channelState,
    binding:{userId:owner,conversationId:owner},
    onMessage:async()=>{throw new Error("must_not_call");},
    onError:error=>errors.push(error),
    retryDelayMs:0
  });
  await assert.doesNotReject(()=>listener.done);
  assert.equal(calls,3);
  assert.deepEqual(errors,[
    {stage:"wechat_poll",code:"wechat_network_error"},
    {stage:"wechat_poll",code:"wechat_auth_expired"}
  ]);
  assert.equal(JSON.stringify(errors).includes("secret"),false);
  assert.deepEqual(channelState.writes,[]);
});

test("accepts the observed getUpdates shape without ret and ignores sync_buf",async () => {
  const channelState=state();
  const received=[],errors=[];
  const replies=[
    {msgs:[baseMessage],get_updates_buf:"cursor-2",sync_buf:"must-not-persist"},
    {errcode:-14}
  ];
  const listener=await startWechatListener({
    api:{getUpdates:async()=>replies.shift()},
    state:channelState,
    binding:{userId:owner,conversationId:owner},
    onMessage:async message=>received.push(message),
    onError:error=>errors.push(error),
    retryDelayMs:0
  });
  await listener.done;
  assert.equal(received.length,1);
  assert.deepEqual(channelState.writes,["cursor-2"]);
  assert.deepEqual(errors,[{stage:"wechat_poll",code:"wechat_auth_expired"}]);
  assert.equal(JSON.stringify([received,channelState.writes,errors]).includes("must-not-persist"),false);
});

test("rejects every present nonzero or nonnumeric ret and errcode before side effects",async () => {
  const invalidResponses=[
    {ret:undefined,msgs:[baseMessage],get_updates_buf:"cursor-2"},
    {ret:null,msgs:[baseMessage],get_updates_buf:"cursor-2"},
    {ret:"0",msgs:[baseMessage],get_updates_buf:"cursor-2"},
    {ret:{},msgs:[baseMessage],get_updates_buf:"cursor-2"},
    {ret:1,msgs:[baseMessage],get_updates_buf:"cursor-2"},
    {ret:0,errcode:undefined,msgs:[baseMessage],get_updates_buf:"cursor-2"},
    {ret:0,errcode:null,msgs:[baseMessage],get_updates_buf:"cursor-2"},
    {ret:0,errcode:"0",msgs:[baseMessage],get_updates_buf:"cursor-2"},
    {ret:0,errcode:1,msgs:[baseMessage],get_updates_buf:"cursor-2"}
  ];
  for (const response of invalidResponses) {
    const channelState=state();
    const received=[],errors=[];
    const replies=[response,{errcode:-14}];
    const listener=await startWechatListener({
      api:{getUpdates:async()=>replies.shift()},
      state:channelState,
      binding:{userId:owner,conversationId:owner},
      onMessage:async message=>received.push(message),
      onError:error=>errors.push(error),
      retryDelayMs:0
    });
    await listener.done;
    assert.deepEqual(received,[]);
    assert.deepEqual(channelState.writes,[]);
    assert.deepEqual(errors,[{stage:"wechat_poll",code:"wechat_protocol_error"}]);
  }
});

test("validates required messages and cursor before delivering any message",async () => {
  const invalidResponses=[
    {ret:0,get_updates_buf:"cursor-2"},
    {ret:0,msgs:null,get_updates_buf:"cursor-2"},
    {ret:0,msgs:{},get_updates_buf:"cursor-2"},
    {ret:0,msgs:[baseMessage]},
    {ret:0,msgs:[baseMessage],sync_buf:"cursor-2"},
    {ret:0,msgs:[baseMessage],get_updates_buf:2},
    {ret:0,msgs:[baseMessage],get_updates_buf:"x".repeat(1024*1024+1)}
  ];
  for (const response of invalidResponses) {
    const channelState=state();
    const received=[],errors=[];
    const listener=await startWechatListener({
      api:{getUpdates:async()=>response},
      state:channelState,
      binding:{userId:owner,conversationId:owner},
      onMessage:async message=>received.push(message),
      onError:error=>errors.push(error),
      retryDelayMs:0
    });
    await listener.done;
    assert.deepEqual(received,[]);
    assert.deepEqual(channelState.writes,[]);
    assert.deepEqual(errors,[{stage:"wechat_poll",code:"wechat_protocol_error"}]);
  }
});

test("keeps one image or PDF media reference only in the current in-memory resource table",async () => {
  const channelState=state();
  const received=[];
  const mediaUrl="https://media.weixin.qq.com/encrypted";
  const aesKey="MDEyMzQ1Njc4OWFiY2RlZg==";
  const replies=[
    {ret:0,get_updates_buf:"cursor-2",msgs:[
      {...baseMessage,message_id:2001,item_list:[{type:2,image_item:{media:{full_url:mediaUrl,aes_key:aesKey}}}]},
      {...baseMessage,message_id:2002,item_list:[{type:4,file_item:{file_name:"发票.PDF",media:{full_url:mediaUrl,aes_key:aesKey}}}]}
    ]},
    {ret:1,errcode:-14}
  ];
  const listener=await startWechatListener({
    api:{getUpdates:async()=>replies.shift()},
    state:channelState,
    binding:{userId:owner,conversationId:owner},
    onMessage:async message=>received.push(message),
    retryDelayMs:0
  });
  await listener.done;
  assert.equal(received.length,2);
  assert.deepEqual(received.map(message=>message.attachments[0].type),["image","file"]);
  assert.deepEqual(received.map(message=>message.attachments[0].extension),["","pdf"]);
  assert.equal(JSON.stringify(received).includes(mediaUrl),false);
  assert.equal(JSON.stringify(received).includes(aesKey),false);
  assert.equal(channelState.resources.size,2);
  for (const message of received) {
    const id=message.attachments[0].sourceAttachmentId;
    assert.match(id,/^wxr_[a-f0-9]{32}$/);
    assert.equal(channelState.resources.get(id).url,mediaUrl);
  }
});

test("stop ends only the WeChat loop without rejecting its done promise",async () => {
  let signal;
  const listener=await startWechatListener({
    api:{getUpdates:async options=>{
      signal=options.signal;
      return new Promise((_resolve,reject)=>{
        options.signal.addEventListener("abort",()=>reject(new DOMException("stopped","AbortError")),{once:true});
      });
    }},
    state:state(),
    binding:{userId:owner,conversationId:owner},
    onMessage:async()=>{},
    retryDelayMs:0
  });
  while (!signal) await new Promise(resolve=>setImmediate(resolve));
  listener.stop();
  await assert.doesNotReject(()=>listener.done);
  assert.equal(signal.aborted,true);
});
