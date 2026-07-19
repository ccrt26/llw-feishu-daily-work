export function createDailyWorkCapability({service}) {
  return {
    name: "daily-work",
    match: event => event.messageType === "text" && event.content.trim().length > 0,
    handle: event => service.handleEvent({
      message_id: event.messageId,
      create_time: event.createTimeMs,
      content: event.content,
      sender_id: event.senderId,
      chat_id: event.chatId,
      chat_type: event.chatType,
      message_type: event.messageType
    })
  };
}
