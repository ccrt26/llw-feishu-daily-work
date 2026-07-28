import {normalizeEvent} from "../core/event-normalizer.mjs";
import {
  checkIncomingSecurity,checkSecurity
} from "../core/security-gate.mjs";
import {createFeishuIncomingMessage} from "../core/incoming-message.mjs";
import {handleModelCommand} from "../core/model-command.mjs";

export class PersonalAssistantDispatcher {
  constructor({
    binding,bindings,state,coordinator,modelMode,deepseekEnabled,messenger,
    onFailure=()=>{},coalesceWindowMs=0
  }) {
    this.binding=binding;
    this.bindings=bindings;
    this.state=state;
    this.coordinator=coordinator;
    this.modelMode=modelMode;
    this.deepseekEnabled=deepseekEnabled;
    this.messenger=messenger;
    this.onFailure=typeof onFailure==="function"?onFailure:()=>{};
    if (!Number.isSafeInteger(coalesceWindowMs)||
        coalesceWindowMs<0||coalesceWindowMs>5_000) {
      throw new Error("invalid_coalesce_window");
    }
    this.coalesceWindowMs=coalesceWindowMs;
    this.pendingBySource=new Map();
    this.acceptedTasks=new Set();
    this.queue=Promise.resolve();
  }

  handleRawEvent(raw) {
    return this.enqueue(()=>this.processRawEvent(raw));
  }

  handleIncomingMessage(message) {
    return this.enqueue(()=>this.processIncomingMessage(message));
  }

  acceptRawEvent(raw) {
    let event;
    try {
      event=normalizeEvent(raw);
    } catch {
      return Promise.resolve({handled:false,reason:"invalid_event"});
    }
    const security=checkSecurity(event,this.binding);
    if (!security.ok) return Promise.resolve({
      handled:false,reason:security.reason
    });
    let message;
    try {
      message=createFeishuIncomingMessage(event);
    } catch {
      return Promise.resolve({handled:false,reason:"invalid_message"});
    }
    return this.acceptIncomingMessage(message);
  }

  acceptIncomingMessage(message) {
    const security=checkIncomingSecurity(message,this.bindings);
    if (!security.ok) return Promise.resolve({
      handled:false,reason:security.reason
    });
    if (!validTurnShape(message)) {
      return Promise.resolve({handled:false,reason:"invalid_message"});
    }
    if (!message.instructionText.trim()&&!message.attachments.length) {
      return Promise.resolve({handled:false,reason:"empty_message"});
    }
    if (this.state.hasOutcome(personalOutcomeKey(message))) {
      return Promise.resolve({handled:false,reason:"duplicate"});
    }
    if (!this.coalesceWindowMs||!isSplitTurnPart(message)) {
      this.scheduleAccepted(message);
      return Promise.resolve({handled:true,status:"accepted"});
    }
    const pending=this.pendingBySource.get(message.source);
    if (!pending) {
      this.holdAccepted(message);
      return Promise.resolve({handled:true,status:"accepted"});
    }
    if (canCoalesce(pending.message,message)) {
      clearTimeout(pending.timer);
      this.pendingBySource.delete(message.source);
      const {combined,alias}=combineSplitTurn(pending.message,message);
      this.scheduleAccepted(combined,alias);
      return Promise.resolve({handled:true,status:"accepted"});
    }
    this.flushAcceptedSlot(message.source,pending);
    this.holdAccepted(message);
    return Promise.resolve({handled:true,status:"accepted"});
  }

  async flushAcceptedMessages() {
    for (const [source,pending] of [...this.pendingBySource]) {
      clearTimeout(pending.timer);
      this.pendingBySource.delete(source);
      this.scheduleAccepted(pending.message);
    }
    while (this.acceptedTasks.size) {
      await Promise.allSettled([...this.acceptedTasks]);
    }
    await this.queue;
  }

  enqueue(operation) {
    const next=this.queue.then(operation);
    this.queue=next.catch(()=>{});
    return next;
  }

  holdAccepted(message) {
    const pending={message,timer:null};
    pending.timer=setTimeout(()=>{
      if (this.pendingBySource.get(message.source)!==pending) return;
      this.pendingBySource.delete(message.source);
      this.scheduleAccepted(message);
    },this.coalesceWindowMs);
    pending.timer.unref?.();
    this.pendingBySource.set(message.source,pending);
  }

  flushAcceptedSlot(source,pending) {
    clearTimeout(pending.timer);
    if (this.pendingBySource.get(source)===pending) {
      this.pendingBySource.delete(source);
    }
    this.scheduleAccepted(pending.message);
  }

  scheduleAccepted(message,alias=null) {
    const task=this.enqueue(async()=>{
      const result=await this.processIncomingMessage(message);
      if (alias) await this.saveCoalescedAlias(alias);
      return result;
    });
    this.acceptedTasks.add(task);
    task.catch(()=>{
      try { this.onFailure("personal_assistant_failed"); } catch {}
    }).finally(()=>this.acceptedTasks.delete(task));
  }

  async saveCoalescedAlias(message) {
    const key=personalOutcomeKey(message);
    if (this.state.hasOutcome(key)) return;
    await this.state.saveOutcome(key,{
      capability:"personal-assistant",
      status:"ignored",reply:null,artifacts:[],replyFiles:[],
      noReplyRequired:true,reasonCode:"coalesced_into_attachment",
      createdAt:new Date().toISOString()
    });
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
      const reasonCode=boundedFailureCode(error);
      try { this.onFailure(reasonCode); } catch {}
      await this.persistAndSendCommand(key,message,{
        status:"failed",
        reply:"本次处理失败，系统没有确认任何写入；请稍后重试。",
        reasonCode
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
      createdAt:new Date().toISOString(),
      ...(draft.reasonCode?{reasonCode:draft.reasonCode}:{})
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

const SAFE_FAILURE_CODES=new Set([
  "assistant_source_invalid","assistant_source_unsupported",
  "content_safety_rejected","agent_turn_context_invalid",
  "personal_rules_invalid","assistant_model_failed",
  "assistant_model_unsupported","provider_result_invalid",
  "tool_call_invalid"
]);

function boundedFailureCode(error) {
  return SAFE_FAILURE_CODES.has(error?.message)
    ?error.message
    :"personal_assistant_failed";
}

function validTurnShape(message) {
  return message&&typeof message==="object"&&!Array.isArray(message)&&
    typeof message.instructionText==="string"&&
    Array.isArray(message.attachments)&&message.attachments.length<=1;
}

function isSplitTurnPart(message) {
  return message.attachments.length===1&&!message.instructionText.trim()||
    message.attachments.length===0&&!!message.instructionText.trim();
}

function canCoalesce(first,second) {
  if (first.source!==second.source||
      first.userId!==second.userId||
      first.conversationId!==second.conversationId) return false;
  const firstTime=Date.parse(first.receivedAt);
  const secondTime=Date.parse(second.receivedAt);
  if (!Number.isFinite(firstTime)||!Number.isFinite(secondTime)||
      Math.abs(secondTime-firstTime)>10_000) return false;
  return first.attachments.length+second.attachments.length===1&&
    (!!first.instructionText.trim()!==!!second.instructionText.trim());
}

function combineSplitTurn(first,second) {
  const attachment=first.attachments.length?first:second;
  const instruction=first.attachments.length?second:first;
  const latest=Date.parse(first.receivedAt)>Date.parse(second.receivedAt)
    ?first:second;
  return {
    combined:{
      ...attachment,
      instructionText:instruction.instructionText,
      receivedAt:latest.receivedAt,
      replyTarget:structuredClone(latest.replyTarget)
    },
    alias:instruction
  };
}

export function personalOutcomeKey(message) {
  if (!new Set(["feishu","wechat"]).has(message?.source)||
      typeof message.sourceMessageId!=="string"||
      !message.sourceMessageId) {
    throw new Error("invalid_incoming_message");
  }
  return `${message.source}:${message.sourceMessageId}`;
}
