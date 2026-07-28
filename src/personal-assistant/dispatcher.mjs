import {normalizeEvent} from "../core/event-normalizer.mjs";
import {
  checkIncomingSecurity,checkSecurity
} from "../core/security-gate.mjs";
import {createFeishuIncomingMessage} from "../core/incoming-message.mjs";
import {handleModelCommand} from "../core/model-command.mjs";
import {isConversationCancellation} from "./conversation.mjs";
import {SourceBurstCollector} from "./source-burst-collector.mjs";

export class PersonalAssistantDispatcher {
  constructor({
    binding,bindings,state,coordinator,modelMode,deepseekEnabled,messenger,
    onFailure=()=>{},coalesceWindowMs=0,
    sourceBurstQuietMs=coalesceWindowMs,
    sourceBurstMaxMs=sourceBurstQuietMs?15_000:0,
    maxSourcesPerTurn=8,
    now=Date.now,setTimer=globalThis.setTimeout,
    clearTimer=globalThis.clearTimeout
  }) {
    this.binding=binding;
    this.bindings=bindings;
    this.state=state;
    this.coordinator=coordinator;
    this.modelMode=modelMode;
    this.deepseekEnabled=deepseekEnabled;
    this.messenger=messenger;
    this.onFailure=typeof onFailure==="function"?onFailure:()=>{};
    if (!Number.isSafeInteger(sourceBurstQuietMs)||
        sourceBurstQuietMs<0||sourceBurstQuietMs>5_000||
        (sourceBurstQuietMs===0&&sourceBurstMaxMs!==0)) {
      throw new Error("invalid_coalesce_window");
    }
    this.acceptedTasks=new Set();
    this.acceptedMessageKeys=new Set();
    this.queue=Promise.resolve();
    this.sourceCollector=sourceBurstQuietMs
      ?new SourceBurstCollector({
        quietMs:sourceBurstQuietMs,maxMs:sourceBurstMaxMs,
        maxSources:maxSourcesPerTurn,now,setTimer,clearTimer,
        onReady:({message,aliases})=>this.scheduleAccepted(message,aliases)
      })
      :null;
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
    const key=personalOutcomeKey(message);
    if (this.state.hasOutcome(key)||this.acceptedMessageKeys.has(key)) {
      return Promise.resolve({handled:false,reason:"duplicate"});
    }
    if (!this.sourceCollector) {
      this.scheduleAccepted(message);
      return Promise.resolve({handled:true,status:"accepted"});
    }
    if (isConversationCancellation(message.instructionText)) {
      const cancelled=this.sourceCollector.cancel(message);
      if (cancelled.messages.length) {
        this.scheduleAliasOutcomes(cancelled.messages,"cancelled");
      }
      this.scheduleAccepted(message);
      return Promise.resolve({handled:true,status:"accepted"});
    }
    const collected=this.sourceCollector.accept(message);
    if (collected.status==="rejected") {
      this.scheduleRejectedSource(message);
      return Promise.resolve({handled:true,status:"rejected"});
    }
    if (collected.reason==="duplicate") {
      return Promise.resolve({handled:false,reason:"duplicate"});
    }
    return Promise.resolve({handled:true,status:"accepted"});
  }

  scheduleRejectedSource(message) {
    const key=personalOutcomeKey(message);
    const task=this.enqueue(()=>this.persistAndSendCommand(key,message,{
      status:"rejected",
      reply:"一次最多处理 8 个文件；超出的文件未加入本轮，请分开发送。",
      reasonCode:"too_many_sources"
    }));
    this.trackTask(task,[key]);
  }

  scheduleAliasOutcomes(messages,reasonCode) {
    const keys=messages.map(personalOutcomeKey);
    const task=this.enqueue(async()=>{
      for (let index=0;index<messages.length;index+=1) {
        const key=keys[index];
        if (this.state.hasOutcome(key)) continue;
        await this.state.saveOutcome(key,{
          capability:"personal-assistant",
          status:"ignored",reply:null,artifacts:[],replyFiles:[],
          noReplyRequired:true,reasonCode,
          createdAt:new Date().toISOString()
        });
      }
    });
    this.trackTask(task,keys);
  }

  trackTask(task,keys=[]) {
    for (const key of keys) this.acceptedMessageKeys.add(key);
    this.acceptedTasks.add(task);
    task.catch(()=>{
      try { this.onFailure("personal_assistant_failed"); } catch {}
    }).finally(()=>{
      this.acceptedTasks.delete(task);
      for (const key of keys) this.acceptedMessageKeys.delete(key);
    });
  }

  async flushAcceptedMessages() {
    this.sourceCollector?.flushAll();
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

  scheduleAccepted(message,aliases=[]) {
    const messages=[message,...aliases];
    const keys=messages.map(personalOutcomeKey);
    const task=this.enqueue(async()=>{
      const result=await this.processIncomingMessage(message);
      if (aliases.length) {
        await this.saveCoalescedAliases(aliases);
      }
      return result;
    });
    this.trackTask(task,keys);
  }

  async saveCoalescedAliases(messages) {
    for (const message of messages) {
      const key=personalOutcomeKey(message);
      if (this.state.hasOutcome(key)) continue;
      await this.state.saveOutcome(key,{
        capability:"personal-assistant",
        status:"ignored",reply:null,artifacts:[],replyFiles:[],
        noReplyRequired:true,reasonCode:"coalesced_into_turn",
        createdAt:new Date().toISOString()
      });
    }
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
        reply:failureReply(reasonCode),
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
  "source_receive_failed","source_security_rejected",
  "source_limit_exceeded",
  "content_safety_rejected","agent_turn_context_invalid",
  "personal_rules_invalid","assistant_model_failed",
  "assistant_model_unsupported","provider_result_invalid",
  "tool_call_invalid","tool_execution_failed","writer_partial",
  "reply_delivery_failed"
]);
const SAFE_FAILURE_PHASES=new Set([
  "source_preparation_failed","personal_rules_load_failed",
  "daily_candidates_load_failed","save_knowledge_execution_failed",
  "record_daily_work_execution_failed",
  "archive_dining_invoice_execution_failed",
  "create_document_execution_failed","conversation_state_failed",
  "outcome_persist_failed","reply_delivery_failed"
]);

function boundedFailureCode(error) {
  if (SAFE_FAILURE_CODES.has(error?.message)) return error.message;
  if (SAFE_FAILURE_PHASES.has(error?.failurePhase)) {
    return error.failurePhase;
  }
  if (error?.message==="assistant_source_invalid") {
    return "source_security_rejected";
  }
  if (error?.message==="assistant_source_too_large") {
    return "source_limit_exceeded";
  }
  return "tool_execution_failed";
}

function failureReply(code) {
  return new Map([
    [
      "source_receive_failed",
      "文件未能安全接收，本次没有调用 AI，也没有写入。请重新发送该文件。"
    ],
    [
      "source_security_rejected",
      "文件未通过安全检查，本次没有调用 AI，也没有写入。请确认文件未加密、未损坏且格式正确。"
    ],
    [
      "source_limit_exceeded",
      "文件数量或大小超过本轮上限，本次没有调用 AI，也没有写入。请分开发送。"
    ],
    [
      "assistant_model_unsupported",
      "当前尚未支持这种文件格式，本次没有调用 Writer，也没有写入。"
    ],
    [
      "assistant_model_failed",
      "AI 本次未能完成分析，系统没有确认任何写入；请稍后重试。"
    ],
    [
      "tool_call_invalid",
      "AI 返回的操作请求未通过安全校验，系统没有写入；请重试。"
    ]
  ]).get(code)||
    "本次工具执行失败，系统没有确认新的写入；请稍后重试。";
}

function validTurnShape(message) {
  return message&&typeof message==="object"&&!Array.isArray(message)&&
    typeof message.instructionText==="string"&&
    Array.isArray(message.attachments)&&message.attachments.length<=8;
}

export function personalOutcomeKey(message) {
  if (!new Set(["feishu","wechat"]).has(message?.source)||
      typeof message.sourceMessageId!=="string"||
      !message.sourceMessageId) {
    throw new Error("invalid_incoming_message");
  }
  return `${message.source}:${message.sourceMessageId}`;
}
