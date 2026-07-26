import {createHash} from "node:crypto";

export function createWechatMessenger({api,boundUserId}) {
  if (!api||typeof api.sendMessage!=="function"||!nonempty(boundUserId)) throw new Error("invalid_wechat_messenger");
  return {
    async send({replyTarget,text,idempotencyKey,replyFiles=[]}) {
      if (!Array.isArray(replyFiles)||replyFiles.length) {
        throw new Error("wechat_file_reply_unsupported");
      }
      if (!replyTarget||replyTarget.source!=="wechat"||replyTarget.conversationId!==boundUserId||
          !nonempty(replyTarget.sourceMessageId)||!nonempty(replyTarget.contextToken)||
          !nonempty(text)||!nonempty(idempotencyKey)) {
        throw new Error("invalid_reply_target");
      }
      const clientId=`llw-${createHash("sha256").update(idempotencyKey,"utf8").digest("hex").slice(0,32)}`;
      await api.sendMessage({
        toUserId:boundUserId,
        contextToken:replyTarget.contextToken,
        text,
        clientId
      });
    }
  };
}

function nonempty(value) { return typeof value==="string"&&value.length>0; }
