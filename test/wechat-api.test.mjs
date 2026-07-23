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
    [new Response("x".repeat(1_048_577),{headers:{"content-type":"application/json"}}),"wechat_response_too_large"]
  ]) {
    const api=createWechatApi({baseUrl:BASE_URL,token:TOKEN,uIn:UIN,fetchImpl:async()=>response});
    await assert.rejects(()=>api.getUpdates(),error=>error.message===code&&!error.message.includes(TOKEN));
  }

  const timed=createWechatApi({
    baseUrl:BASE_URL,token:TOKEN,uIn:UIN,
    fetchImpl:async()=>{throw new DOMException("secret detail","AbortError");}
  });
  await assert.rejects(()=>timed.getUpdates(),error=>error.message==="wechat_timeout");

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
