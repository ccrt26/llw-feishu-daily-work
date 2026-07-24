import {execFile} from "node:child_process";
import {randomBytes,randomUUID} from "node:crypto";
import {lstat,mkdir,open,rename} from "node:fs/promises";
import {dirname,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import {createWechatApi} from "./adapters/wechat-api.mjs";
import {loadConfig} from "./config.mjs";

const run=promisify(execFile);
const INITIAL_BASE_URL="https://ilinkai.weixin.qq.com";

export async function runWechatBind({
  configFile,
  fetchImpl=fetch,
  keychainWrite=writeWechatToken,
  openQr=openQrUrl,
  stateWrite=writeWechatState
}={}) {
  if (typeof configFile!=="string"||!configFile) throw safeError("wechat_binding_invalid");
  let config;
  try { config=await loadConfig(configFile); }
  catch { throw safeError("wechat_binding_invalid"); }
  if (config.wechatEnabled) throw safeError("wechat_binding_invalid");

  const uIn=Buffer.from(String(randomBytes(4).readUInt32BE(0)),"utf8").toString("base64");
  let api=createWechatApi({fetchImpl,baseUrl:INITIAL_BASE_URL,token:undefined,uIn});
  let baseUrl=INITIAL_BASE_URL;
  const qr=await api.getQrCode();
  try { await openQr(qr.qrcode_img_content); }
  catch { throw safeError("wechat_qr_open_failed"); }

  let confirmed;
  for (let attempt=0;attempt<20;attempt++) {
    const status=await api.pollQrStatus({qrCode:qr.qrcode});
    if (status.status==="wait"||status.status==="scaned") continue;
    if (status.status==="expired") throw safeError("wechat_qr_expired");
    if (status.status==="scaned_but_redirect") {
      baseUrl=redirectBase(status.redirect_host);
      api=createWechatApi({fetchImpl,baseUrl,token:undefined,uIn});
      continue;
    }
    if (status.status==="confirmed") {
      confirmed=status;
      break;
    }
    throw safeError("wechat_binding_invalid");
  }
  if (!confirmed) throw safeError("wechat_binding_timeout");
  if (!bounded(confirmed.bot_token,4096)||!bounded(confirmed.ilink_bot_id,512)||!bounded(confirmed.ilink_user_id,512)) throw safeError("wechat_binding_invalid");
  if (confirmed.bot_token.includes("\n")||confirmed.bot_token.includes("\r")) throw safeError("wechat_binding_invalid");
  if (confirmed.baseurl!==undefined) baseUrl=redirectBase(confirmed.baseurl);

  try {
    await keychainWrite({
      service:config.wechatKeychainService,
      account:config.wechatKeychainAccount,
      token:confirmed.bot_token
    });
  } catch {
    throw safeError("wechat_keychain_write_failed");
  }

  const state={
    version:1,
    apiBaseUrl:baseUrl,
    botId:confirmed.ilink_bot_id,
    ownerUserId:confirmed.ilink_user_id,
    syncCursor:""
  };
  try { await stateWrite(config.wechatStateFile,state); }
  catch { throw safeError("wechat_state_write_failed"); }
  return {bindOk:true,p2pOwnerOk:true};
}

async function writeWechatToken({service,account,token}) {
  if (!keychainName(service)||!keychainName(account)||!bounded(token,4096)) throw safeError("wechat_keychain_write_failed");
  try {
    await run("/usr/bin/security",[
      "add-generic-password","-U","-s",service,"-a",account,"-w",token
    ],{encoding:"utf8",maxBuffer:8192});
  } catch {
    throw safeError("wechat_keychain_write_failed");
  }
}

async function openQrUrl(value) {
  let url;
  try { url=new URL(value); } catch { throw safeError("wechat_qr_open_failed"); }
  if (url.protocol!=="https:"||url.username||url.password) throw safeError("wechat_qr_open_failed");
  try { await run("/usr/bin/open",[url.toString()],{encoding:"utf8",maxBuffer:8192}); }
  catch { throw safeError("wechat_qr_open_failed"); }
}

async function writeWechatState(file,state) {
  validateState(state);
  const parent=dirname(file);
  await mkdir(parent,{recursive:true,mode:0o700});
  const parentInfo=await lstat(parent);
  if (!parentInfo.isDirectory()||parentInfo.isSymbolicLink()||parentInfo.uid!==process.getuid()||(parentInfo.mode&0o077)!==0) throw safeError("wechat_state_write_failed");
  try {
    const current=await lstat(file);
    if (!current.isFile()||current.isSymbolicLink()||current.uid!==process.getuid()||(current.mode&0o077)!==0) throw safeError("wechat_state_write_failed");
  } catch (error) {
    if (error.code!=="ENOENT") throw error;
  }
  const temporary=`${file}.${randomUUID()}.tmp`;
  const handle=await open(temporary,"wx",0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state,null,2)}\n`,"utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary,file);
}

function validateState(value) {
  const fields=new Set(["version","apiBaseUrl","botId","ownerUserId","syncCursor"]);
  if (!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).length!==fields.size||Object.keys(value).some(key=>!fields.has(key))) throw safeError("wechat_state_write_failed");
  if (value.version!==1||value.syncCursor!==""||!bounded(value.botId,512)||!bounded(value.ownerUserId,512)) throw safeError("wechat_state_write_failed");
  if (redirectBase(value.apiBaseUrl)!==value.apiBaseUrl) throw safeError("wechat_state_write_failed");
}

function redirectBase(value) {
  if (typeof value!=="string"||!value) throw safeError("wechat_redirect_invalid");
  const candidate=value.startsWith("https://")?value:`https://${value}`;
  let url;
  try {
    createWechatApi({fetchImpl:async()=>{},baseUrl:candidate,token:undefined,uIn:"MTIzNA=="});
    url=new URL(candidate);
  } catch {
    throw safeError("wechat_redirect_invalid");
  }
  return url.origin;
}

function keychainName(value) { return typeof value==="string"&&/^[A-Za-z0-9._@-]{1,128}$/.test(value); }
function bounded(value,max) { return typeof value==="string"&&value.length>0&&Buffer.byteLength(value,"utf8")<=max; }
function safeError(code) { return new Error(code); }

if (process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  runWechatBind({configFile:process.argv[2]}).then(result=>{
    process.stdout.write(`bind_ok=${result.bindOk}\np2p_owner_ok=${result.p2pOwnerOk}\n`);
  }).catch(()=>{
    process.stderr.write("bind_ok=false\n");
    process.exitCode=1;
  });
}
