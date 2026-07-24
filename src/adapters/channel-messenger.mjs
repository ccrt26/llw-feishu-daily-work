export function createChannelMessenger({feishu,wechat}) {
  if (!feishu||typeof feishu.send!=="function"||wechat!==null&&wechat!==undefined&&typeof wechat.send!=="function") throw new Error("invalid_channel_messenger");
  return {
    send(message) {
      if (message?.replyTarget?.source==="feishu") return feishu.send(message);
      if (message?.replyTarget?.source==="wechat"&&wechat) return wechat.send(message);
      throw new Error("invalid_reply_target");
    }
  };
}
