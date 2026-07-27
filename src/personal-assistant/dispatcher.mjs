import {normalizeEvent} from "../core/event-normalizer.mjs";
import {
  checkIncomingSecurity,checkSecurity
} from "../core/security-gate.mjs";
import {createFeishuIncomingMessage} from "../core/incoming-message.mjs";
import {handleModelCommand} from "../core/model-command.mjs";

export class PersonalAssistantDispatcher {
  constructor({
    binding,bindings,state,coordinator,modelMode,deepseekEnabled,messenger
  }) {
    this.binding=binding;
    this.bindings=bindings;
    this.state=state;
    this.coordinator=coordinator;
    this.modelMode=modelMode;
    this.deepseekEnabled=deepseekEnabled;
    this.messenger=messenger;
    this.queue=Promise.resolve();
  }

  handleRawEvent(raw) {
    return this.enqueue(()=>this.processRawEvent(raw));
  }

  handleIncomingMessage(message) {
    return this.enqueue(()=>this.processIncomingMessage(message));
  }

  enqueue(operation) {
    const next=this.queue.then(operation);
    this.queue=next.catch(()=>{});
    return next;
  }

  async processRawEvent(raw) {
    let event;
    try {
      event=normalizeEvent(raw);
    } catch {
      return {handled:false,reason:"invalid_event"};
    }
    const security=checkSecurity(event,this.binding);
    if (!security.ok) return {handled:false,reason:security.reason};
    let message;
    try {
      message=createFeishuIncomingMessage(event);
    } catch {
      return {handled:false,reason:"invalid_message"};
    }
    return this.processIncomingMessage(message);
  }

  async processIncomingMessage(message) {
    const security=checkIncomingSecurity(message,this.bindings);
    if (!security.ok) return {handled:false,reason:security.reason};
    if (!message.instructionText.trim()&&!message.attachments.length) {
      return {handled:false,reason:"empty_message"};
    }
    const key=personalOutcomeKey(message);
    if (this.state.hasOutcome(key)) {
      return {handled:false,reason:"duplicate"};
    }
    if (!message.attachments.length) {
      const command=await handleModelCommand(message.instructionText,{
        modelMode:this.modelMode,deepseekEnabled:this.deepseekEnabled
      });
      if (command) {
        await this.persistAndSendCommand(key,message,command);
        return {handled:true,status:command.status};
      }
    }
    try {
      const outcome=await this.coordinator.handle(message);
      return {handled:true,status:outcome.status};
    } catch (error) {
      if (this.state.hasOutcome(key)) throw error;
      await this.persistAndSendCommand(key,message,{
        status:"failed",
        reply:"本次处理失败，系统没有确认任何写入；请稍后重试。"
      });
      return {handled:true,status:"failed"};
    }
  }

  async persistAndSendCommand(key,message,draft) {
    const outcome={
      capability:"personal-assistant",
      status:draft.status,reply:draft.reply,artifacts:[],
      replyFiles:[],noReplyRequired:false,
      replyTarget:structuredClone(message.replyTarget),
      createdAt:new Date().toISOString()
    };
    await this.state.saveOutcome(key,outcome);
    await this.messenger.send({
      capability:"personal-assistant",
      replyTarget:message.replyTarget,text:draft.reply,
      idempotencyKey:`reply:${key}`,replyFiles:[]
    });
    await this.state.markReplied(key);
  }

  async resumeReplies() {
    for (const outcome of this.state.unreplied()) {
      await this.coordinator.sendOutcome(
        outcome.messageId,outcome,outcome.replyTarget
      );
    }
  }
}

export function personalOutcomeKey(message) {
  if (!new Set(["feishu","wechat"]).has(message?.source)||
      typeof message.sourceMessageId!=="string"||
      !message.sourceMessageId) {
    throw new Error("invalid_incoming_message");
  }
  return `${message.source}:${message.sourceMessageId}`;
}
