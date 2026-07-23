import {extname} from "node:path";

const SOURCES=new Set(["feishu","wechat"]);
const IMAGE_MARKER=/^!\[Image\]\((img_[A-Za-z0-9_-]+)\)$/;
const FILE_MARKER=/^<file\b[^<>]*\/>$/;

export function createReplyTarget({source,sourceMessageId,conversationId}) {
  if (!SOURCES.has(source)||!nonempty(sourceMessageId)||!nonempty(conversationId)) throw new Error("invalid_reply_target");
  return {source,sourceMessageId,conversationId};
}

export function createFeishuIncomingMessage(event) {
  validateEvent(event);
  const replyTarget=createReplyTarget({source:"feishu",sourceMessageId:event.messageId,conversationId:event.chatId});
  const base={
    source:"feishu",
    sourceMessageId:event.messageId,
    userId:event.senderId,
    conversationId:event.chatId,
    receivedAt:new Date(event.createTimeMs).toISOString()
  };
  if (event.messageType==="text") return {...base,text:event.content,attachments:[],replyTarget};
  return {...base,attachments:[createAttachment(event)],replyTarget};
}

function createAttachment(event) {
  const content=event.content.trim();
  if (event.messageType==="image") {
    const match=IMAGE_MARKER.exec(content);
    if (!match) throw new Error("invalid_incoming_message");
    return {type:"image",sourceAttachmentId:match[1],displayName:"飞书图片",extension:""};
  }
  if (event.messageType==="file") {
    if (!FILE_MARKER.test(content)) throw new Error("invalid_incoming_message");
    const keys=[...content.matchAll(/\bkey="([^"]*)"/g)].map(match=>match[1]);
    if (keys.length!==1||!/^file_[A-Za-z0-9_-]+$/.test(keys[0])) throw new Error("invalid_incoming_message");
    const names=[...content.matchAll(/\bname="([^"]*)"/g)].map(match=>match[1]);
    const rawName=names.length===1?decodeXml(names[0]):"飞书文件";
    const displayName=rawName.split(/[\\/]/).at(-1).slice(0,255)||"飞书文件";
    return {type:"file",sourceAttachmentId:keys[0],displayName,extension:extname(displayName).slice(1).toLowerCase().slice(0,20)};
  }
  throw new Error("invalid_incoming_message");
}

function validateEvent(event) {
  if (!event||typeof event!=="object"||Array.isArray(event)) throw new Error("invalid_incoming_message");
  for (const field of ["messageId","senderId","chatId","messageType","content"]) if (!nonempty(event[field])) throw new Error("invalid_incoming_message");
  if (!Number.isFinite(event.createTimeMs)||event.createTimeMs<=0||!new Set(["text","image","file"]).has(event.messageType)) throw new Error("invalid_incoming_message");
}

function nonempty(value) { return typeof value==="string"&&value.length>0; }
function decodeXml(value) { return value.replaceAll("&quot;",'"').replaceAll("&amp;","&").replaceAll("&lt;","<").replaceAll("&gt;",">"); }
