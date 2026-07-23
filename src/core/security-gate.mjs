export function checkSecurity(event, binding) {
  if (!binding?.senderId || !binding?.chatId) return reject("invalid_binding");
  if (event.senderId !== binding.senderId) return reject("sender_not_allowed");
  if (event.chatId !== binding.chatId) return reject("chat_not_allowed");
  if (event.chatType !== "p2p") return reject("chat_not_p2p");
  return {ok: true};
}

function reject(reason) {
  return {ok: false, reason, notify: false};
}
