import {normalizeEvent} from "./event-normalizer.mjs";
import {checkSecurity} from "./security-gate.mjs";
import {createRouterMessage} from "./router-message.mjs";

export class Dispatcher {
  constructor({binding,state,capabilities,intentRouter,messenger}) {
    this.binding=binding; this.state=state; this.capabilities=capabilities; this.intentRouter=intentRouter; this.messenger=messenger; this.queue=Promise.resolve();
  }

  handleRawEvent(raw) { const next=this.queue.then(()=>this.processRawEvent(raw)); this.queue=next.catch(()=>{}); return next; }

  async processRawEvent(raw) {
    let event;
    try { event=normalizeEvent(raw); } catch { return this.handleMalformed(raw); }
    const security=checkSecurity(event,this.binding);
    if (!security.ok) return {handled:false,reason:security.reason};
    if (event.messageType==="text"&&!event.content.trim()) return {handled:false,reason:"empty_text"};
    if (this.state.hasOutcome(event.messageId)) return {handled:false,reason:"duplicate"};
    let capabilityName="router",draft;
    try {
      const conversation=await this.state.getRouterConversation(event.createTimeMs);
      const decision=await this.intentRouter.decide({message:createRouterMessage(event),conversation:conversation?publicConversation(conversation):null,capabilities:this.capabilities.map(item=>structuredClone(item.routingContract))});
      ({capabilityName,draft}=await this.applyDecision(event,conversation,decision));
    } catch {
      draft={status:"failed",reply:"暂时无法判断你希望进行的操作，请告诉我你希望我处理什么。",artifacts:[]};
    }
    return this.persistAndSend(event,capabilityName,draft);
  }

  async applyDecision(event,conversation,decision) {
    if (decision.action==="unsupported") {
      if (decision.reason==="cancelled"&&conversation) {
        await this.state.closeRouterConversation("cancelled");
        if (conversation.capability==="daily-work") await this.state.clearConversation();
        return {capabilityName:"router",draft:{status:"ignored",reply:null,artifacts:[]}};
      }
      await this.state.clearRouterConversation();
      return {capabilityName:"router",draft:{status:"rejected",reply:decision.reason,artifacts:[]}};
    }
    if (decision.action==="clarify") return {capabilityName:"router",draft:await this.routeClarification(event,conversation,decision.question)};
    if (decision.action!=="route"||decision.confidence!=="high") throw new Error("invalid_route");
    const capability=this.capabilities.find(item=>item.name===decision.capability);
    if (!capability) throw new Error("unknown_capability");
    if (conversation&&(decision.reasonCode==="new_task"||decision.capability!==conversation.capability)) {
      await this.state.closeRouterConversation("superseded");
      if (conversation.capability==="daily-work") await this.state.clearConversation();
    }
    let draft=await capability.handle(event,{state:this.state});
    if (draft?.status==="not_applicable") draft={status:"awaiting_clarification",reply:"我暂时无法确定你希望进行的操作，请告诉我你希望我处理什么。",artifacts:[]};
    if (draft?.status==="awaiting_clarification") {
      await this.state.setRouterConversation({capability:capability.name,question:draft.reply,startedAt:conversation?.startedAt||new Date(event.createTimeMs).toISOString(),attempts:1,status:"open"});
    } else await this.state.clearRouterConversation();
    return {capabilityName:capability.name,draft};
  }

  async routeClarification(event,conversation,question) {
    if (conversation) {
      await this.state.clearRouterConversation();
      if (conversation.capability==="daily-work") await this.state.clearConversation();
      const lines=["当前可用能力：",...this.capabilities.map(item=>`- ${item.name}：${item.routingContract.purpose}`)];
      return {status:"awaiting_clarification",reply:lines.join("\n"),artifacts:[]};
    }
    await this.state.setRouterConversation({capability:null,question,startedAt:new Date(event.createTimeMs).toISOString(),attempts:1,status:"open"});
    return {status:"awaiting_clarification",reply:question,artifacts:[]};
  }

  async resumeReplies() {
    for (const outcome of this.state.unreplied()) {
      const event={messageId:outcome.messageId,chatId:this.binding.chatId};
      await this.send(event,outcome.capability||"daily-work",outcome.reply);
      await this.state.markReplied(outcome.messageId);
    }
  }

  async handleMalformed(raw) {
    if (!isBoundMalformed(raw,this.binding)) return {handled:false,reason:"invalid_event"};
    if (this.state.hasOutcome(raw.message_id)) return {handled:false,reason:"duplicate"};
    return this.persistAndSend({messageId:raw.message_id,chatId:raw.chat_id},"core",{status:"failed",reply:"消息结构无效，本条未处理；请重新发送。",artifacts:[]});
  }

  async persistAndSend(event,capability,draft) {
    validateDraft(draft);
    const noReplyRequired=draft.reply===null;
    await this.state.saveOutcome(event.messageId,{capability,status:draft.status,reply:draft.reply,artifacts:[...draft.artifacts],noReplyRequired,createdAt:new Date().toISOString()});
    if (noReplyRequired) return {handled:true,status:draft.status};
    await this.send(event,capability,draft.reply); await this.state.markReplied(event.messageId);
    return {handled:true,status:draft.status};
  }

  async send(event,capability,text) {
    const idempotencyKey=capability==="invoice"?`invoice-reply:${event.messageId}`:`reply:${event.messageId}`;
    try { await this.messenger.send({capability,event,text,idempotencyKey}); } catch { throw new Error("message_send_failed"); }
  }
}

function publicConversation(value) { return {capability:value.capability,question:value.question,startedAt:value.startedAt}; }
function isBoundMalformed(raw,binding) { return raw&&typeof raw==="object"&&raw.sender_id===binding.senderId&&raw.chat_id===binding.chatId&&raw.chat_type==="p2p"&&typeof raw.message_id==="string"&&raw.message_id.length>0; }
function validateDraft(draft) {
  const statuses=new Set(["committed","existing","awaiting_clarification","rejected","failed","ignored"]);
  if (!draft||!statuses.has(draft.status)||!Array.isArray(draft.artifacts)) throw new Error("invalid_outcome_draft");
  if (draft.status==="ignored") { if (draft.reply!==null||draft.artifacts.length) throw new Error("invalid_outcome_draft"); return; }
  if (typeof draft.reply!=="string"||!draft.reply.trim()) throw new Error("invalid_outcome_draft");
  if (draft.status==="committed"&&!draft.artifacts.length) throw new Error("invalid_outcome_draft");
}
