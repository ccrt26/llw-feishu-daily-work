export function createRouterMessage(message) {
  const beijingTime=new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).format(new Date(message.receivedAt));
  if (typeof message.text==="string"&&message.attachments?.length===0) return {type:"text",text:message.text,beijingTime};
  if (message.attachments?.length===1) {
    const attachment=message.attachments[0];
    if (!new Set(["image","file"]).has(attachment.type)) throw new Error("invalid_router_message");
    return {type:attachment.type,attachment:{displayName:attachment.displayName,extension:attachment.extension,resourceType:attachment.type},beijingTime};
  }
  throw new Error("invalid_router_message");
}
