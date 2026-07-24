import {createDecipheriv} from "node:crypto";
import {isIP} from "node:net";

const MAX_JSON_BYTES=1024*1024;
const MAX_MEDIA_BYTES=20*1024*1024+16;
const BASE_INFO={channel_version:"2.4.6",bot_agent:"LLWAssistant/1.0"};
const CLIENT_VERSION=132102;
const QR_STATUSES=new Set(["wait","scaned","scaned_but_redirect","confirmed","expired"]);

export function createWechatApi({fetchImpl=fetch,baseUrl,token,uIn}) {
  if (typeof fetchImpl!=="function"||!validUin(uIn)||!validToken(token,true)) throw safeError("wechat_configuration_invalid");
  const apiBase=validateBaseUrl(baseUrl,"wechat_configuration_invalid");

  async function getQrCode({botType="3",timeoutMs=15_000}={}) {
    if (!/^[1-9][0-9]{0,2}$/.test(botType)) throw safeError("wechat_protocol_error");
    const value=await requestJson(
      new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,`${apiBase}/`),
      {method:"POST",headers:headers(false),body:JSON.stringify({local_token_list:[]})},
      timeoutMs
    );
    if ((value.ret!==undefined&&value.ret!==0)||!bounded(value.qrcode,4096)||!bounded(value.qrcode_img_content,4096)) throw safeError("wechat_protocol_error");
    validateRemoteUrl(value.qrcode_img_content,"wechat_protocol_error");
    return {qrcode:value.qrcode,qrcode_img_content:value.qrcode_img_content};
  }

  async function pollQrStatus({qrCode,verifyCode,timeoutMs=35_000}={}) {
    if (!bounded(qrCode,4096)||verifyCode!==undefined&&!bounded(verifyCode,64)) throw safeError("wechat_protocol_error");
    const url=new URL("ilink/bot/get_qrcode_status",`${apiBase}/`);
    url.searchParams.set("qrcode",qrCode);
    if (verifyCode!==undefined) url.searchParams.set("verify_code",verifyCode);
    const value=await requestJson(url,{method:"GET",headers:commonHeaders()},timeoutMs);
    if (!QR_STATUSES.has(value.status)) throw safeError("wechat_protocol_error");
    return value;
  }

  async function getUpdates({cursor="",timeoutMs=40_000,signal}={}) {
    requireToken(token);
    if (typeof cursor!=="string"||cursor.length>1024*1024) throw safeError("wechat_protocol_error");
    const value=await requestJson(
      new URL("ilink/bot/getupdates",`${apiBase}/`),
      {
        method:"POST",headers:headers(true),
        body:JSON.stringify({get_updates_buf:cursor,base_info:BASE_INFO}),
        signal
      },
      timeoutMs,
      reviveWechatMessageId
    );
    if (!value||typeof value!=="object"||Array.isArray(value)) throw safeError("wechat_protocol_error");
    return value;
  }

  async function sendMessage({toUserId,contextToken,text,clientId,timeoutMs=15_000}={}) {
    requireToken(token);
    if (!bounded(toUserId,512)||!bounded(contextToken,4096)||!bounded(text,32_768)||!bounded(clientId,128)) throw safeError("wechat_protocol_error");
    const value=await requestJson(
      new URL("ilink/bot/sendmessage",`${apiBase}/`),
      {
        method:"POST",headers:headers(true),
        body:JSON.stringify({
          msg:{
            to_user_id:toUserId,
            client_id:clientId,
            message_type:2,
            message_state:2,
            context_token:contextToken,
            item_list:[{type:1,text_item:{text}}]
          },
          base_info:BASE_INFO
        })
      },
      timeoutMs
    );
    if (value?.ret!==undefined&&value.ret!==0) throw safeError("wechat_protocol_error");
  }

  async function downloadEncryptedMedia({url,maxBytes=MAX_MEDIA_BYTES,timeoutMs=30_000}={}) {
    const mediaUrl=validateRemoteUrl(url,"wechat_media_invalid");
    if (!Number.isSafeInteger(maxBytes)||maxBytes<=0||maxBytes>MAX_MEDIA_BYTES) throw safeError("wechat_media_invalid");
    const response=await request(mediaUrl,{method:"GET",headers:{}},timeoutMs);
    const declaredContentType=response.headers.get("content-type");
    if (declaredContentType!==null) {
      const contentType=declaredContentType.split(";",1)[0].trim().toLowerCase();
      if (!(contentType==="application/octet-stream"||contentType==="application/pdf"||contentType.startsWith("image/"))) throw safeError("wechat_media_invalid");
    }
    return safeReadBounded(response,maxBytes);
  }

  function commonHeaders() {
    return {
      "iLink-App-Id":"bot",
      "iLink-App-ClientVersion":String(CLIENT_VERSION)
    };
  }

  function headers(authenticated) {
    const value={
      "Content-Type":"application/json",
      "AuthorizationType":"ilink_bot_token",
      "X-WECHAT-UIN":uIn,
      ...commonHeaders()
    };
    if (authenticated) value.Authorization=`Bearer ${token}`;
    return value;
  }

  async function requestJson(url,options,timeoutMs,reviver) {
    const response=await request(url,options,timeoutMs);
    const contentType=response.headers.get("content-type")?.toLowerCase()||"";
    if (!/^application\/(?:json|[a-z0-9.+-]+\+json|octet-stream)(?:;|$)/.test(contentType)) throw safeError("wechat_response_not_json");
    const bytes=await safeReadBounded(response,MAX_JSON_BYTES);
    let value;
    try { value=JSON.parse(bytes.toString("utf8"),reviver); }
    catch { throw safeError("wechat_response_not_json"); }
    if (!value||typeof value!=="object"||Array.isArray(value)) throw safeError("wechat_protocol_error");
    return value;
  }

  async function request(url,options,timeoutMs) {
    if (!Number.isSafeInteger(timeoutMs)||timeoutMs<=0||timeoutMs>120_000) throw safeError("wechat_protocol_error");
    const controller=new AbortController();
    const external=options.signal;
    const onAbort=()=>controller.abort();
    if (external?.aborted) controller.abort();
    else external?.addEventListener?.("abort",onAbort,{once:true});
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    let response;
    try {
      response=await fetchImpl(url,{
        ...options,
        signal:controller.signal,
        redirect:"error"
      });
    } catch (error) {
      if (error?.name==="AbortError") throw safeError("wechat_timeout");
      throw safeError("wechat_network_error");
    } finally {
      clearTimeout(timer);
      external?.removeEventListener?.("abort",onAbort);
    }
    if (!response||typeof response!=="object"||typeof response.ok!=="boolean"||!response.headers) throw safeError("wechat_network_error");
    if (!response.ok) throw safeError("wechat_http_error");
    return response;
  }

  return {getQrCode,pollQrStatus,getUpdates,sendMessage,downloadEncryptedMedia};
}

export function decryptWechatMedia(ciphertext,aesKey) {
  try {
    const encrypted=Buffer.isBuffer(ciphertext)?ciphertext:Buffer.from(ciphertext);
    const key=decodeAesKey(aesKey);
    if (!encrypted.length||encrypted.length%16!==0||encrypted.length>MAX_MEDIA_BYTES) throw new Error("invalid");
    const decipher=createDecipheriv("aes-128-ecb",key,null);
    return Buffer.concat([decipher.update(encrypted),decipher.final()]);
  } catch {
    throw safeError("wechat_media_decrypt_failed");
  }
}

async function readBounded(response,maxBytes) {
  const declared=response.headers.get("content-length");
  if (declared!==null) {
    if (!/^[0-9]+$/.test(declared)||Number(declared)>maxBytes) throw safeError("wechat_response_too_large");
  }
  const reader=response.body?.getReader?.();
  if (!reader) {
    const value=Buffer.from(await response.arrayBuffer());
    if (value.length>maxBytes) throw safeError("wechat_response_too_large");
    return value;
  }
  const chunks=[];
  let length=0;
  while (true) {
    const {done,value}=await reader.read();
    if (done) break;
    length+=value.byteLength;
    if (length>maxBytes) {
      await reader.cancel();
      throw safeError("wechat_response_too_large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks,length);
}

async function safeReadBounded(response,maxBytes) {
  try { return await readBounded(response,maxBytes); }
  catch (error) {
    if (error?.message==="wechat_response_too_large") throw error;
    throw safeError("wechat_network_error");
  }
}

function validateBaseUrl(value,code) {
  const url=validateRemoteUrl(value,code);
  if ((url.pathname!=="/"&&url.pathname!=="")||url.search||url.hash) throw safeError(code);
  return url.origin;
}

function validateRemoteUrl(value,code) {
  let url;
  try { url=new URL(value); } catch { throw safeError(code); }
  if (url.protocol!=="https:"||url.username||url.password||url.hash||!publicHostname(url.hostname)||(url.port&&url.port!=="443")) throw safeError(code);
  return url;
}

function publicHostname(hostname) {
  const value=hostname.toLowerCase();
  if (!value||value==="localhost"||value.endsWith(".localhost")||value.endsWith(".local")) return false;
  const version=isIP(value);
  if (version===4) {
    const parts=value.split(".").map(Number);
    const [a,b]=parts;
    return !(
      a===0||a===10||a===127||a>=224||
      a===100&&b>=64&&b<=127||
      a===169&&b===254||
      a===172&&b>=16&&b<=31||
      a===192&&b===0||
      a===192&&b===168||
      a===198&&[18,19,51].includes(b)||
      a===203&&b===0
    );
  }
  if (version===6) {
    return !(value==="::"||value==="::1"||value.startsWith("fc")||value.startsWith("fd")||/^fe[89ab]/.test(value)||value.startsWith("::ffff:"));
  }
  return /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(value)&&value.includes(".")&&value.includes("..")===false;
}

function decodeAesKey(value) {
  if (Buffer.isBuffer(value)&&value.length===16) return value;
  if (typeof value!=="string") throw new Error("invalid");
  if (/^[a-fA-F0-9]{32}$/.test(value)) return Buffer.from(value,"hex");
  if (!/^[A-Za-z0-9+/]{22}==$/.test(value)) throw new Error("invalid");
  const decoded=Buffer.from(value,"base64");
  if (decoded.length!==16) throw new Error("invalid");
  return decoded;
}

function validUin(value) { return typeof value==="string"&&/^[A-Za-z0-9+/=]{4,128}$/.test(value)&&!value.includes("\n"); }
function validToken(value,optional=false) { return optional&&value===undefined||bounded(value,4096)&&!value.includes("\n")&&!value.includes("\r"); }
function requireToken(value) { if (!validToken(value)) throw safeError("wechat_auth_required"); }
function reviveWechatMessageId(key,value,context) {
  if (key!=="message_id") return value;
  if (typeof value==="string") return value;
  if (typeof value!=="number") return value;
  const source=context?.source;
  return typeof source==="string"&&/^[1-9][0-9]{0,30}$/.test(source)?source:null;
}
function nonempty(value) { return typeof value==="string"&&value.length>0; }
function bounded(value,max) { return nonempty(value)&&Buffer.byteLength(value,"utf8")<=max; }
function safeError(code) { return new Error(code); }
