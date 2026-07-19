import {sendLarkReply,sendLarkText} from "../lark-runtime.mjs";

export function createLarkMessenger({cliPath,profile,boundChatId,environment=process.env}) {
  return {
    async send({capability,event,text,idempotencyKey}) {
      if (capability === "invoice") return sendLarkReply({cliPath,profile,messageId:event.messageId,text,idempotencyKey,environment});
      return sendLarkText({cliPath,profile,chatId:boundChatId,text,idempotencyKey,environment});
    }
  };
}
