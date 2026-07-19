import {extname} from "node:path";

export function createRouterMessage(event) {
  const beijingTime=new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).format(new Date(event.createTimeMs));
  if (event.messageType==="text") return {type:"text",text:event.content,beijingTime};
  if (event.messageType==="image") {
    if (!/^!\[Image\]\(img_[A-Za-z0-9_-]+\)$/.test(event.content.trim())) throw new Error("invalid_router_message");
    return {type:"image",attachment:{displayName:"飞书图片",extension:"",resourceType:"image"},beijingTime};
  }
  if (event.messageType==="file") {
    const content=event.content.trim();
    if (!/^<file\b[^<>]*\/>$/.test(content) || !/\bkey="file_[A-Za-z0-9_-]+"/.test(content)) throw new Error("invalid_router_message");
    const names=[...content.matchAll(/\bname="([^"]*)"/g)].map(match=>match[1]);
    const rawName=names.length===1?decodeXml(names[0]):"飞书文件";
    const displayName=rawName.split(/[\\/]/).at(-1).slice(0,255) || "飞书文件";
    const extension=extname(displayName).slice(1).toLowerCase().slice(0,20);
    return {type:"file",attachment:{displayName,extension,resourceType:"file"},beijingTime};
  }
  throw new Error("invalid_router_message");
}

function decodeXml(value) { return value.replaceAll("&quot;",'"').replaceAll("&amp;","&").replaceAll("&lt;","<").replaceAll("&gt;",">"); }
