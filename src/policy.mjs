export function checkDailyWorkMessage(message) {
  if (!message||typeof message!=="object"||Array.isArray(message)||typeof message.sourceMessageId!=="string"||!message.sourceMessageId) return reject("invalid_message");
  if (!Array.isArray(message.attachments)) return reject("invalid_message");
  if (message.attachments.length>0||typeof message.text!=="string") return reject("unsupported_message_type",true);
  const createTime=Date.parse(message.receivedAt);
  if (!Number.isFinite(createTime)||createTime<=0) return reject("invalid_message");
  const text=message.text.trim();
  if (!text) return reject("empty_text");
  if (text.length > 12000) return reject("text_too_long", true);
  return {ok:true,messageId:message.sourceMessageId,createTime,text};
}

function reject(reason, notify = false) {
  return {ok: false, reason, notify};
}
