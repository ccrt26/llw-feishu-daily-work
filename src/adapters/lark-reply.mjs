import {sendLarkReply,sendLarkText} from "../lark-runtime.mjs";

export function createLarkMessenger({cliPath,profile,boundChatId,environment=process.env}) {
  return {
    async send({capability,replyTarget,text,idempotencyKey}) {
      if (replyTarget?.source!=="feishu"||replyTarget.conversationId!==boundChatId) throw new Error("invalid_reply_target");
      if (capability === "invoice") return sendLarkReply({cliPath,profile,messageId:replyTarget.sourceMessageId,text,idempotencyKey,environment});
      return sendLarkText({cliPath,profile,chatId:replyTarget.conversationId,text,idempotencyKey,environment});
    }
  };
}
