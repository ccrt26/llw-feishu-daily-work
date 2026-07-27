export function normalizeEvent(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_event");
  for (const field of ["event_id", "message_id", "sender_id", "chat_id", "message_type"]) {
    if (typeof raw[field] !== "string" || !raw[field]) throw new Error("invalid_event");
  }
  if (!new Set(["p2p", "group"]).has(raw.chat_type)) throw new Error("invalid_event");
  if (typeof raw.content !== "string") throw new Error("invalid_event");
  const createTimeMs = Number(raw.create_time);
  if (!Number.isFinite(createTimeMs) || createTimeMs <= 0) throw new Error("invalid_event");
  const event={
    eventId: raw.event_id,
    messageId: raw.message_id,
    senderId: raw.sender_id,
    chatId: raw.chat_id,
    chatType: raw.chat_type,
    messageType: raw.message_type,
    content: raw.content,
    createTimeMs
  };
  if (raw.instruction_text!==undefined) {
    if (typeof raw.instruction_text!=="string"||
        Buffer.byteLength(raw.instruction_text,"utf8")>32_768) {
      throw new Error("invalid_event");
    }
    event.instructionText=raw.instruction_text;
  }
  return event;
}
