import {sendLarkFile,sendLarkReply,sendLarkText} from "../lark-runtime.mjs";

export function createLarkMessenger({cliPath,profile,boundChatId,environment=process.env}) {
  return {
    async send({
      capability,replyTarget,text,idempotencyKey,replyFiles=[]
    }) {
      if (replyTarget?.source!=="feishu"||replyTarget.conversationId!==boundChatId) throw new Error("invalid_reply_target");
      if (!Array.isArray(replyFiles)||replyFiles.length>1) {
        throw new Error("invalid_reply_files");
      }
      if (capability === "invoice") {
        await sendLarkReply({
          cliPath,profile,messageId:replyTarget.sourceMessageId,text,
          idempotencyKey,environment
        });
      } else {
        await sendLarkText({
          cliPath,profile,chatId:replyTarget.conversationId,text,
          idempotencyKey,environment
        });
      }
      for (const replyFile of replyFiles) {
        await sendLarkFile({
          cliPath,profile,messageId:replyTarget.sourceMessageId,
          replyFile,environment
        });
      }
    }
  };
}
