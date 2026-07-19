export function checkEvent(event, binding) {
  if (!event || typeof event !== "object" || !binding?.senderId || !binding?.chatId) {
    return reject("invalid_event");
  }
  if (event.sender_id !== binding.senderId) return reject("sender_not_allowed");
  if (event.chat_id !== binding.chatId) return reject("chat_not_allowed");
  if (event.chat_type !== "p2p") return reject("chat_not_p2p");
  if (event.message_type !== "text") return reject("unsupported_message_type", true);
  if (typeof event.message_id !== "string" || !event.message_id) return reject("invalid_event");
  const createTime = Number(event.create_time);
  if (!Number.isFinite(createTime) || createTime <= 0) return reject("invalid_event");
  if (typeof event.content !== "string") return reject("invalid_event");
  const text = event.content.trim();
  if (!text) return reject("empty_text");
  if (text.length > 12000) return reject("text_too_long", true);
  return {ok: true, messageId: event.message_id, createTime, text};
}

function reject(reason, notify = false) {
  return {ok: false, reason, notify};
}
