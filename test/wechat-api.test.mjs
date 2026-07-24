import test from "node:test";
import assert from "node:assert/strict";
import {createCipheriv,randomBytes} from "node:crypto";
import {createWechatApi,decryptWechatMedia} from "../src/adapters/wechat-api.mjs";

const BASE_URL="https://ilinkai.weixin.qq.com";
const TOKEN="test-secret-token";
const UIN="MTIzNDU2";

function json(value,{status=200,headers={}}={}) {
  return new Response(JSON.stringify(value),{
    status,
    headers:{"content-type":"application/json",...headers}
  });
}

function octetJson(value,{status=200,headers={}}={}) {
  return new Response(JSON.stringify(value),{
    status,
    headers:{"content-type":"application/octet-stream",...headers}
  });
}

function rawJson(value,{status=200,headers={}}={}) {
  return new Response(value,{
    status,
    headers:{"content-type":"application/json",...headers}
  });
}

test("accepts bounded octet-stream JSON objects for the four fixed iLink control operations",async () => {
  const responses=[
    octetJson(
      {ret:0,qrcode:"test-qr-key",qrcode_img_content:"https://weixin.qq.com/test-qr"},
      {headers:{"content-type":"application/octet-stream; charset=utf-8"}}
    ),
    octetJson({status:"confirmed",bot_token:TOKEN,ilink_bot_id:"bot-test",ilink_user_id:"wx-owner"}),
    octetJson({ret:0,msgs:[],get_updates_buf:"cursor-2"}),
    octetJson({})
  ];
  const api=createWechatApi({
    baseUrl:BASE_URL,token:TOKEN,uIn:UIN,
    fetchImpl:async()=>responses.shift()
  });

  assert.equal((await api.getQrCode()).qrcode,"test-qr-key");
  assert.equal((await api.pollQrStatus({qrCode:"test-qr-key"})).status,"confirmed");
  assert.equal((await api.getUpdates({cursor:"cursor-1"})).ret,0);
  await api.sendMessage({
    toUserId:"wx-owner",contextToken:"test-context",text:"处理完成",clientId:"client-1"
  });

  const structuredJsonApi=createWechatApi({
    baseUrl:BASE_URL,token:TOKEN,uIn:UIN,
    fetchImpl:async()=>json(
      {ret:0,qrcode:"test-qr-key",qrcode_img_content:"https://weixin.qq.com/test-qr"},
      {headers:{"content-type":"application/vnd.ilink+json; charset=utf-8"}}
    )
  });
  assert.equal((await structuredJsonApi.getQrCode()).qrcode,"test-qr-key");
});

test("rejects every non-object JSON control response for JSON and octet-stream media types",async () => {
  for (const contentType of ["application/json","application/octet-stream"]) {
    for (const value of [[],["unexpected"],"unexpected",7,null]) {
      const api=createWechatApi({
        baseUrl:BASE_URL,token:TOKEN,uIn:UIN,
        fetchImpl:async()=>new Response(JSON.stringify(value),{headers:{"content-type":contentType}})
      });
      await assert.rejects(
        ()=>api.sendMessage({
          toUserId:"wx-owner",contextToken:"test-context",text:"处理完成",clientId:"client-1"
        }),
        error=>error.message==="wechat_protocol_error"
      );
    }
  }
});

test("requires successful ret and bounded fields for QR control responses",async () => {
  const valid={
    ret:0,
    qrcode:"test-qr-key",
    qrcode_img_content:"https://weixin.qq.com/test-qr",
    ignored_upstream_field:"ignored"
  };
  for (const value of [
    {...valid,ret:1},
    {...valid,ret:"0"},
    {...valid,qrcode:"q".repeat(4097)},
    {...valid,qrcode_img_content:`https://weixin.qq.com/${"q".repeat(4097)}`}
  ]) {
    const api=createWechatApi({
      baseUrl:BASE_URL,token:TOKEN,uIn:UIN,
      fetchImpl:async()=>octetJson(value)
    });
    await assert.rejects(()=>api.getQrCode(),error=>error.message==="wechat_protocol_error");
  }

  const api=createWechatApi({
    baseUrl:BASE_URL,token:TOKEN,uIn:UIN,
    fetchImpl:async()=>octetJson(valid)
  });
  assert.deepEqual(await api.getQrCode(),{
    qrcode:"test-qr-key",
    qrcode_img_content:"https://weixin.qq.com/test-qr"
  });
});

test("accepts only the fixed QR status enum",async () => {
  for (const value of [
    {status:"wait"},
    {status:"scaned"},
    {status:"expired"},
    {status:"scaned_but_redirect",redirect_host:"ilink2.weixin.qq.com"},
    {
      status:"confirmed",
      bot_token:TOKEN,
      ilink_bot_id:"bot-test",
      ilink_user_id:"wx-owner",
      baseurl:"https://ilink2.weixin.qq.com"
    }
  ]) {
    const api=createWechatApi({
      baseUrl:BASE_URL,token:TOKEN,uIn:UIN,
      fetchImpl:async()=>octetJson(value)
    });
    assert.equal((await api.pollQrStatus({qrCode:"test-qr-key"})).status,value.status);
  }

  for (const status of ["unknown","",7,null]) {
    const api=createWechatApi({
      baseUrl:BASE_URL,token:TOKEN,uIn:UIN,
      fetchImpl:async()=>octetJson({status})
    });
    await assert.rejects(
      ()=>api.pollQrStatus({qrCode:"test-qr-key"}),
      error=>error.message==="wechat_protocol_error"
    );
  }
});

test("accepts only empty or successful object results from sendMessage",async () => {
  for (const value of [{},{ret:0},{ret:0,ignored_upstream_field:"ignored"}]) {
    const api=createWechatApi({
      baseUrl:BASE_URL,token:TOKEN,uIn:UIN,
      fetchImpl:async()=>octetJson(value)
    });
    await api.sendMessage({
      toUserId:"wx-owner",contextToken:"test-context",text:"处理完成",clientId:"client-1"
    });
  }
  for (const ret of [1,-1,"0",null]) {
    const api=createWechatApi({
      baseUrl:BASE_URL,token:TOKEN,uIn:UIN,
      fetchImpl:async()=>octetJson({ret})
    });
    await assert.rejects(
      ()=>api.sendMessage({
        toUserId:"wx-owner",contextToken:"test-context",text:"处理完成",clientId:"client-1"
      }),
      error=>error.message==="wechat_protocol_error"
    );
  }
});

test("uses the fixed direct HTTPS protocol for QR, updates, replies and bounded media",async () => {
  const calls=[];
  const responses=[
    json({qrcode:"test-qr-key",qrcode_img_content:"https://weixin.qq.com/test-qr"}),
    json({status:"confirmed",bot_token:TOKEN,ilink_bot_id:"bot-test",ilink_user_id:"wx-owner",baseurl:"https://ilink2.weixin.qq.com"}),
    json({ret:0,msgs:[],get_updates_buf:"cursor-2",longpolling_timeout_ms:35000}),
    json({ret:0}),
    new Response(Buffer.from("ciphertext"),{headers:{"content-type":"application/octet-stream","content-length":"10"}})
  ];
  const api=createWechatApi({
    baseUrl:BASE_URL,token:TOKEN,uIn:UIN,
    fetchImpl:async (url,options)=>{calls.push({url:String(url),options:structuredClone(options)});return responses.shift();}
  });

  assert.deepEqual(await api.getQrCode(),{
    qrcode:"test-qr-key",qrcode_img_content:"https://weixin.qq.com/test-qr"
  });
  assert.equal((await api.pollQrStatus({qrCode:"test-qr-key"})).status,"confirmed");
  assert.deepEqual(await api.getUpdates({cursor:"cursor-1"}),{
    ret:0,msgs:[],get_updates_buf:"cursor-2",longpolling_timeout_ms:35000
  });
  await api.sendMessage({
    toUserId:"wx-owner",contextToken:"test-context",text:"处理完成",clientId:"client-1"
  });
  assert.deepEqual(
    await api.downloadEncryptedMedia({url:"https://media.weixin.qq.com/test-media",maxBytes:20}),
    Buffer.from("ciphertext")
  );

  assert.equal(calls[0].url,`${BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`);
  assert.equal(calls[0].options.method,"POST");
  assert.equal(calls[0].options.headers.Authorization,undefined);
  assert.deepEqual(JSON.parse(calls[0].options.body),{local_token_list:[]});
  assert.equal(calls[1].url,`${BASE_URL}/ilink/bot/get_qrcode_status?qrcode=test-qr-key`);
  assert.equal(calls[1].options.method,"GET");
  assert.equal(calls[1].options.headers.Authorization,undefined);
  assert.equal(calls[2].url,`${BASE_URL}/ilink/bot/getupdates`);
  assert.equal(calls[2].options.headers.Authorization,`Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(calls[2].options.body),{
    get_updates_buf:"cursor-1",
    base_info:{channel_version:"2.4.6",bot_agent:"LLWAssistant/1.0"}
  });
  assert.equal(calls[3].url,`${BASE_URL}/ilink/bot/sendmessage`);
  assert.deepEqual(JSON.parse(calls[3].options.body),{
    msg:{
      to_user_id:"wx-owner",client_id:"client-1",message_type:2,message_state:2,
      context_token:"test-context",item_list:[{type:1,text_item:{text:"处理完成"}}]
    },
    base_info:{channel_version:"2.4.6",bot_agent:"LLWAssistant/1.0"}
  });
  assert.equal(calls[4].url,"https://media.weixin.qq.com/test-media");
  assert.equal(calls[4].options.headers?.Authorization,undefined);
  assert.equal(JSON.stringify(calls.slice(0,4)).includes(TOKEN),true);
  assert.equal(JSON.stringify(calls.map(call=>call.options.body||"")).includes(TOKEN),false);
});

test("preserves only getUpdates numeric message_id source text as exact strings",async () => {
  const api=createWechatApi({
    baseUrl:BASE_URL,token:TOKEN,uIn:UIN,
    fetchImpl:async()=>rawJson(
      '{"ret":0,"msgs":['+
      '{"message_id":9007199254740992,"seq":9007199254740993},'+
      '{"message_id":9007199254740993},'+
      '{"message_id":1001},'+
      '{"message_id":"9007199254740993"}'+
      '],"get_updates_buf":"cursor-2"}'
    )
  });

  const value=await api.getUpdates();
  assert.deepEqual(value.msgs.map(message=>message.message_id),[
    "9007199254740992",
    "9007199254740993",
    "1001",
    "9007199254740993"
  ]);
  assert.equal(typeof value.msgs[0].seq,"number");
});

test("maps invalid numeric message_id source forms to null without changing composite values",async () => {
  const api=createWechatApi({
    baseUrl:BASE_URL,token:TOKEN,uIn:UIN,
    fetchImpl:async()=>rawJson(
      '{"ret":0,"msgs":['+
      '{"message_id":1.5},'+
      '{"message_id":1e3},'+
      '{"message_id":-1},'+
      '{"message_id":0},'+
      '{"message_id":11111111111111111111111111111111},'+
      '{"message_id":null},'+
      '{"message_id":[]},'+
      '{"message_id":{}}'+
      '],"get_updates_buf":"cursor-2"}'
    )
  });

  const value=await api.getUpdates();
  assert.deepEqual(value.msgs.map(message=>message.message_id),[
    null,null,null,null,null,null,[],{}
  ]);
});

test("fails closed for a numeric message_id when JSON.parse source text is unavailable",{
  concurrency:false
},async () => {
  const originalParse=JSON.parse;
  JSON.parse=(text,reviver)=>{
    if (typeof reviver!=="function") return originalParse(text);
    return originalParse(text,(key,value)=>reviver(key,value,undefined));
  };
  try {
    const api=createWechatApi({
      baseUrl:BASE_URL,token:TOKEN,uIn:UIN,
      fetchImpl:async()=>rawJson(
        '{"ret":0,"msgs":[{"message_id":9007199254740993}],"get_updates_buf":"cursor-2"}'
      )
    });
    const value=await api.getUpdates();
    assert.equal(value.msgs[0].message_id,null);
  } finally {
    JSON.parse=originalParse;
  }
});

test("maps unsafe, failed, non-JSON and oversized responses to value-free errors",async () => {
  assert.throws(
    ()=>createWechatApi({baseUrl:"http://ilinkai.weixin.qq.com",token:TOKEN,uIn:UIN,fetchImpl:async()=>{}}),
    error=>error.message==="wechat_configuration_invalid"
  );
  assert.throws(
    ()=>createWechatApi({baseUrl:"https://127.0.0.1",token:TOKEN,uIn:UIN,fetchImpl:async()=>{}}),
    error=>error.message==="wechat_configuration_invalid"
  );
  assert.throws(
    ()=>createWechatApi({baseUrl:"https://intranet",token:TOKEN,uIn:UIN,fetchImpl:async()=>{}}),
    error=>error.message==="wechat_configuration_invalid"
  );

  for (const [response,code] of [
    [new Response("secret detail",{status:503,headers:{"content-type":"text/plain"}}),"wechat_http_error"],
    [new Response("not-json",{headers:{"content-type":"text/plain"}}),"wechat_response_not_json"],
    [new Response("not-json secret detail",{headers:{"content-type":"application/octet-stream"}}),"wechat_response_not_json"],
    [new Response("x".repeat(1_048_577),{headers:{"content-type":"application/json"}}),"wechat_response_too_large"],
    [new Response("x".repeat(1_048_577),{headers:{"content-type":"application/octet-stream"}}),"wechat_response_too_large"],
    [new Response("{}",{headers:{"content-type":"text/html"}}),"wechat_response_not_json"]
  ]) {
    const api=createWechatApi({baseUrl:BASE_URL,token:TOKEN,uIn:UIN,fetchImpl:async()=>response});
    await assert.rejects(()=>api.getUpdates(),error=>error.message===code&&!error.message.includes(TOKEN));
  }

  const timed=createWechatApi({
    baseUrl:BASE_URL,token:TOKEN,uIn:UIN,
    fetchImpl:async()=>{throw new DOMException("secret detail","AbortError");}
  });
  await assert.rejects(()=>timed.getUpdates(),error=>error.message==="wechat_timeout");

  const redirected=createWechatApi({
    baseUrl:BASE_URL,token:TOKEN,uIn:UIN,
    fetchImpl:async()=>{throw new TypeError(`redirect ${TOKEN}`);}
  });
  await assert.rejects(
    ()=>redirected.getUpdates(),
    error=>error.message==="wechat_network_error"&&!error.message.includes(TOKEN)
  );

  const brokenBody=createWechatApi({
    baseUrl:BASE_URL,token:TOKEN,uIn:UIN,
    fetchImpl:async()=>new Response(new ReadableStream({
      start(controller) { controller.error(new Error(`stream ${TOKEN}`)); }
    }),{headers:{"content-type":"application/json"}})
  });
  await assert.rejects(
    ()=>brokenBody.getUpdates(),
    error=>error.message==="wechat_network_error"&&!error.message.includes(TOKEN)
  );

  const media=createWechatApi({
    baseUrl:BASE_URL,token:TOKEN,uIn:UIN,
    fetchImpl:async()=>new Response(Buffer.alloc(21),{
      headers:{"content-type":"application/octet-stream","content-length":"21"}
    })
  });
  await assert.rejects(
    ()=>media.downloadEncryptedMedia({url:"https://media.weixin.qq.com/file",maxBytes:20}),
    error=>error.message==="wechat_response_too_large"
  );
  const paddedMedia=createWechatApi({
    baseUrl:BASE_URL,token:TOKEN,uIn:UIN,
    fetchImpl:async()=>new Response(Buffer.alloc(16),{
      headers:{"content-type":"application/octet-stream","content-length":"16"}
    })
  });
  assert.equal((await paddedMedia.downloadEncryptedMedia({
    url:"https://media.weixin.qq.com/file",maxBytes:20*1024*1024+16
  })).length,16);
  await assert.rejects(
    ()=>media.downloadEncryptedMedia({url:"https://localhost/file",maxBytes:20}),
    error=>error.message==="wechat_media_invalid"
  );
});

test("decrypts only one valid AES-128-ECB media value",() => {
  const key=randomBytes(16);
  const plaintext=Buffer.from("%PDF-test");
  const cipher=createCipheriv("aes-128-ecb",key,null);
  const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);
  assert.deepEqual(decryptWechatMedia(ciphertext,key.toString("base64")),plaintext);
  assert.deepEqual(decryptWechatMedia(ciphertext,key.toString("hex")),plaintext);
  assert.throws(()=>decryptWechatMedia(ciphertext,"bad-key"),/wechat_media_decrypt_failed/);
  assert.throws(()=>decryptWechatMedia(Buffer.alloc(15),key),/wechat_media_decrypt_failed/);
});
