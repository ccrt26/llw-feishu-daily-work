import {createHash,randomUUID} from "node:crypto";
import {extname} from "node:path";
import {createWechatIncomingMessage} from "../core/incoming-message.mjs";

const MAX_CURSOR_BYTES=1024*1024;
const MAX_SEEN=2000;
const MAX_RESOURCES=100;

export async function startWechatListener({
  api,state,binding,onMessage,onError=()=>{},retryDelayMs=1000
}) {
  if (!api||typeof api.getUpdates!=="function"||!state||typeof state.readCursor!=="function"||typeof state.writeCursor!=="function"||
      !binding||!nonempty(binding.userId)||!nonempty(binding.conversationId)||typeof onMessage!=="function"||
      typeof onError!=="function"||!Number.isSafeInteger(retryDelayMs)||retryDelayMs<0||retryDelayMs>60_000) {
    throw new Error("invalid_wechat_runtime");
  }
  let stopped=false;
  let controller;
  const seen=new Map();
  const done=(async()=>{
    let cursor;
    try { cursor=await state.readCursor(); }
    catch {
      await report(onError,"wechat_state_unavailable");
      return;
    }
    if (typeof cursor!=="string"||Buffer.byteLength(cursor,"utf8")>MAX_CURSOR_BYTES) {
      await report(onError,"wechat_state_invalid");
      return;
    }
    let failures=0;
    while (!stopped) {
      controller=new AbortController();
      let response;
      try {
        response=await api.getUpdates({cursor,signal:controller.signal});
      } catch (error) {
        if (stopped) break;
        const code=error?.message==="wechat_timeout"?"wechat_timeout":"wechat_network_error";
        if (code!=="wechat_timeout") await report(onError,code);
        failures++;
        if (failures>=5) break;
        await delay(retryDelayMs);
        continue;
      }
      if (stopped) break;
      failures=0;
      const validResponse=response&&typeof response==="object"&&!Array.isArray(response);
      if (validResponse&&response.errcode===-14) {
        await report(onError,"wechat_auth_expired");
        break;
      }
      const retOk=validResponse&&(!Object.hasOwn(response,"ret")||
        typeof response.ret==="number"&&response.ret===0);
      const errcodeOk=validResponse&&(!Object.hasOwn(response,"errcode")||
        typeof response.errcode==="number"&&response.errcode===0);
      const nextCursor=validResponse?response.get_updates_buf:undefined;
      if (!validResponse||!retOk||!errcodeOk||!Array.isArray(response.msgs)||
          typeof nextCursor!=="string"||Buffer.byteLength(nextCursor,"utf8")>MAX_CURSOR_BYTES) {
        await report(onError,"wechat_protocol_error");
        break;
      }
      let failed=false;
      for (const raw of response.msgs) {
        const id=messageId(raw);
        if (!id) continue;
        const fingerprint=messageFingerprint(raw);
        const previous=seen.get(id);
        if (previous!==undefined) {
          if (previous!==fingerprint) {
            await report(
              onError,
              "wechat_message_id_collision",
              "wechat_intake"
            );
          }
          continue;
        }
        const intake=toIncoming(raw,binding,state.resources);
        if (!intake.message) {
          if (intake.code) await report(onError,intake.code,"wechat_intake");
          continue;
        }
        try {
          await onMessage(intake.message);
          remember(seen,id,fingerprint);
        } catch {
          failed=true;
          await report(onError,"wechat_message_failed");
        }
      }
      if (failed) continue;
      try { await state.writeCursor(nextCursor); }
      catch {
        await report(onError,"wechat_state_write_failed");
        break;
      }
      cursor=nextCursor;
    }
  })().catch(async()=>{
    await report(onError,"wechat_runtime_failed");
  });
  return {
    stop() {
      stopped=true;
      controller?.abort();
    },
    done
  };
}

function toIncoming(raw,binding,resources) {
  if (!raw||typeof raw!=="object"||Array.isArray(raw)||raw.message_type!==1||raw.message_state!==2) return {};
  if (raw.group_id!==undefined&&raw.group_id!==null&&raw.group_id!=="") return {};
  if (raw.from_user_id!==binding.userId||binding.conversationId!==binding.userId||!nonempty(raw.context_token)) return {};
  if (!Number.isFinite(raw.create_time_ms)||raw.create_time_ms<=0||!Array.isArray(raw.item_list)||raw.item_list.length<1) return {};
  if (raw.item_list.length>1) return {code:"wechat_item_batch_unsupported"};
  const id=messageId(raw);
  if (!id) return {};
  const item=raw.item_list[0];
  if (!item||typeof item!=="object"||Array.isArray(item)) return {};
  if (item.type===1&&nonempty(item.text_item?.text)) {
    return {message:createWechatIncomingMessage({
      messageId:id,
      userId:raw.from_user_id,
      conversationId:binding.conversationId,
      createTimeMs:raw.create_time_ms,
      type:"text",
      text:item.text_item.text,
      contextToken:raw.context_token
    })};
  }
  if (![2,4].includes(item.type)||!(resources instanceof Map)) return {};
  const type=item.type===2?"image":"file";
  const detail=type==="image"?item.image_item:item.file_item;
  const media=detail?.media;
  const url=media?.full_url;
  const aesKey=detail?.aeskey||media?.aes_key;
  if (!nonempty(url)||!nonempty(aesKey)) {
    return {code:"wechat_file_metadata_incomplete"};
  }
  const rawName=type==="image"?"微信图片":detail?.file_name;
  if (!nonempty(rawName)) return {};
  const displayName=rawName.split(/[\\/]/).at(-1).slice(0,255);
  const extension=type==="image"?"":extname(displayName).slice(1).toLowerCase();
  if (!displayName||extension.length>20||
      type==="file"&&!new Set([
        "pdf","txt","md","docx","pptx","xlsx"
      ]).has(extension)) return {};
  const resourceId=`wxr_${randomUUID().replaceAll("-","")}`;
  while (resources.size>=MAX_RESOURCES) resources.delete(resources.keys().next().value);
  resources.set(resourceId,{url,aesKey,type,displayName,extension});
  return {message:createWechatIncomingMessage({
    messageId:id,
    userId:raw.from_user_id,
    conversationId:binding.conversationId,
    createTimeMs:raw.create_time_ms,
    type,
    attachment:{type,sourceAttachmentId:resourceId,displayName,extension},
    contextToken:raw.context_token
  })};
}

function messageId(value) {
  if (Number.isSafeInteger(value?.message_id)&&value.message_id>0) return String(value.message_id);
  if (typeof value?.message_id==="string"&&/^[1-9][0-9]{0,30}$/.test(value.message_id)) return value.message_id;
  return null;
}

function remember(seen,id,fingerprint) {
  seen.set(id,fingerprint);
  while (seen.size>MAX_SEEN) seen.delete(seen.keys().next().value);
}

function messageFingerprint(raw) {
  return createHash("sha256")
    .update(JSON.stringify({
      messageType:raw.message_type,
      messageState:raw.message_state,
      itemList:raw.item_list
    }))
    .digest("hex");
}

async function report(onError,code,stage="wechat_poll") {
  try { await onError({stage,code}); } catch {}
}

function delay(milliseconds) {
  if (!milliseconds) return Promise.resolve();
  return new Promise(resolve=>setTimeout(resolve,milliseconds));
}

function nonempty(value) { return typeof value==="string"&&value.length>0; }
