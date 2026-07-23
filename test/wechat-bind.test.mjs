import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,rm,stat,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {runWechatBind} from "../src/wechat-bind.mjs";

const TOKEN="test-secret-token";

function config(stateFile) {
  return {
    version:4,
    vaultRoot:"/Volumes/test/LLW",
    stateFile:join(stateFile,"state.json"),
    heartbeatFile:join(stateFile,"heartbeat.json"),
    modelStateFile:join(stateFile,"model-state"),
    deepseekEnabled:false,
    deepseekModel:"deepseek-v4-pro",
    deepseekKeychainService:"com.llw.deepseek-api",
    deepseekKeychainAccount:"llw-assistant",
    wechatEnabled:false,
    wechatStateFile:join(stateFile,"wechat-state.json"),
    wechatKeychainService:"com.llw.wechat-ilink",
    wechatKeychainAccount:"llw-assistant",
    cliPath:"/Users/test/bin/lark-cli",
    codexPath:"/Users/test/bin/codex",
    profile:"llw-private",
    senderId:"user-1",
    chatId:"chat-1",
    capabilities:{
      "daily-work":{enabled:true,skillRoot:"/Volumes/test/LLW/.agents/skills/feishu-daily-work"},
      invoice:{
        enabled:true,skillRoot:"/Volumes/test/LLW/.agents/skills/filing-invoices",
        tempRoot:"/Users/test/tmp/invoices",
        archiveRoot:"/Volumes/test/LLW/亚信工作/日常发票/餐饮发票",
        maxFileBytes:20971520,aiTimeoutMs:120000,
        pdfInfoPath:"/Users/test/bin/pdfinfo",pdfToTextPath:"/Users/test/bin/pdftotext",pdfToPpmPath:"/Users/test/bin/pdftoppm",
        maxPdfPages:10,maxPdfTextBytes:262144,maxPdfRenderBytes:104857600,pdfPrepareTimeoutMs:60000
      }
    }
  };
}

function json(value) {
  return new Response(JSON.stringify(value),{headers:{"content-type":"application/json"}});
}

async function fixture() {
  const dir=await mkdtemp(join(tmpdir(),"llw-wechat-bind-"));
  const configFile=join(dir,"config.json");
  await writeFile(configFile,`${JSON.stringify(config(dir))}\n`,{mode:0o600});
  return {dir,configFile};
}

test("writes the confirmed token only to Keychain and an exact mode-0600 token-free state",async () => {
  const {dir,configFile}=await fixture();
  const opened=[],keychain=[];
  const responses=[
    json({qrcode:"test-qr-key",qrcode_img_content:"https://weixin.qq.com/test-qr"}),
    json({status:"confirmed",bot_token:TOKEN,ilink_bot_id:"bot-test",ilink_user_id:"wx-owner",baseurl:"https://ilink2.weixin.qq.com"})
  ];
  try {
    assert.deepEqual(await runWechatBind({
      configFile,
      fetchImpl:async()=>responses.shift(),
      openQr:async value=>opened.push(value),
      keychainWrite:async value=>keychain.push(value)
    }),{bindOk:true,p2pOwnerOk:true});
    assert.deepEqual(opened,["https://weixin.qq.com/test-qr"]);
    assert.deepEqual(keychain,[{
      service:"com.llw.wechat-ilink",account:"llw-assistant",token:TOKEN
    }]);
    const statePath=join(dir,"wechat-state.json");
    const stateText=await readFile(statePath,"utf8");
    assert.deepEqual(JSON.parse(stateText),{
      version:1,
      apiBaseUrl:"https://ilink2.weixin.qq.com",
      botId:"bot-test",
      ownerUserId:"wx-owner",
      syncCursor:""
    });
    assert.equal((await stat(statePath)).mode&0o777,0o600);
    for (const forbidden of [TOKEN,"test-qr-key","test-qr","bot_token","qrcode"]) {
      assert.equal(stateText.includes(forbidden),false);
    }
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("rejects malicious redirects and missing confirmation values before protected writes",async () => {
  for (const status of [
    {status:"scaned_but_redirect",redirect_host:"127.0.0.1"},
    {status:"expired"},
    {status:"confirmed",ilink_bot_id:"bot-test",ilink_user_id:"wx-owner",baseurl:"https://ilink2.weixin.qq.com"}
  ]) {
    const {dir,configFile}=await fixture();
    let writes=0;
    const responses=[
      json({qrcode:"test-qr-key",qrcode_img_content:"https://weixin.qq.com/test-qr"}),
      json(status)
    ];
    try {
      await assert.rejects(()=>runWechatBind({
        configFile,fetchImpl:async()=>responses.shift(),openQr:async()=>{},
        keychainWrite:async()=>{writes++;},stateWrite:async()=>{writes++;}
      }),error=>["wechat_redirect_invalid","wechat_qr_expired","wechat_binding_invalid"].includes(error.message)&&!error.message.includes(TOKEN));
      assert.equal(writes,0);
    } finally { await rm(dir,{recursive:true,force:true}); }
  }
});

test("keeps token and platform values out of an atomic state-write failure",async () => {
  const {dir,configFile}=await fixture();
  const responses=[
    json({qrcode:"test-qr-key",qrcode_img_content:"https://weixin.qq.com/test-qr"}),
    json({status:"confirmed",bot_token:TOKEN,ilink_bot_id:"bot-test",ilink_user_id:"wx-owner",baseurl:"https://ilink2.weixin.qq.com"})
  ];
  let keychainWrites=0;
  try {
    await assert.rejects(()=>runWechatBind({
      configFile,fetchImpl:async()=>responses.shift(),openQr:async()=>{},
      keychainWrite:async()=>{keychainWrites++;},
      stateWrite:async()=>{throw new Error(`disk ${TOKEN} bot-test`);}
    }),error=>error.message==="wechat_state_write_failed");
    assert.equal(keychainWrites,1);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
