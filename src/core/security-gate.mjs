export function checkSecurity(event, binding) {
  if (!binding?.senderId || !binding?.chatId) return reject("invalid_binding");
  if (event.senderId !== binding.senderId) return reject("sender_not_allowed");
  if (event.chatId !== binding.chatId) return reject("chat_not_allowed");
  if (event.chatType !== "p2p") return reject("chat_not_p2p");
  return {ok: true};
}

export function checkIncomingSecurity(message, bindings) {
  if (!message||typeof message!=="object"||!["feishu","wechat"].includes(message.source)) return reject("invalid_message");
  const binding=bindings?.[message.source];
  if (!binding?.userId||!binding?.conversationId) return reject("invalid_binding");
  if (message.userId!==binding.userId) return reject("sender_not_allowed");
  if (message.conversationId!==binding.conversationId) return reject("chat_not_allowed");
  return {ok:true};
}

function reject(reason) {
  return {ok: false, reason, notify: false};
}
