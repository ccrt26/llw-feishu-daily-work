import {normalizeEvent} from "./event-normalizer.mjs";
import {checkIncomingSecurity,checkSecurity} from "./security-gate.mjs";
import {createRouterMessage} from "./router-message.mjs";
import {createFeishuIncomingMessage,createReplyTarget} from "./incoming-message.mjs";
import {effectiveModel,handleModelCommand} from "./model-command.mjs";
import {classifyAiFailure} from "./ai-failure.mjs";
import {failure as invoiceFailure} from "../capabilities/invoice/receipt.mjs";

export class Dispatcher {
  constructor({binding,bindings,state,capabilities,intentRouter,withPreparedVisual,messenger,modelMode,deepseekEnabled}) {
    this.binding=binding;
    this.bindings=bindings||{
      feishu:{userId:binding?.senderId,conversationId:binding?.chatId}
    };
    this.state=state; this.capabilities=capabilities; this.intentRouter=intentRouter; this.withPreparedVisual=withPreparedVisual; this.messenger=messenger; this.modelMode=modelMode; this.deepseekEnabled=deepseekEnabled; this.queue=Promise.resolve();
  }

  handleRawEvent(raw) { const next=this.queue.then(()=>this.processRawEvent(raw)); this.queue=next.catch(()=>{}); return next; }

  handleIncomingMessage(message) {
    const next=this.queue.then(()=>this.processIncomingMessage(message));
    this.queue=next.catch(()=>{});
    return next;
  }

  async processRawEvent(raw) {
    let event;
    try { event=normalizeEvent(raw); } catch { return this.handleMalformed(raw); }
    const security=checkSecurity(event,this.binding);
    if (!security.ok) return {handled:false,reason:security.reason};
    if (event.messageType==="text"&&!event.content.trim()) return {handled:false,reason:"empty_text"};
    if (this.state.hasOutcome(event.messageId)) return {handled:false,reason:"duplicate"};
    let message;
    try { message=createFeishuIncomingMessage(event); }
    catch {
      return this.persistAndSend(fallbackMessage(event),"router",{
        status:"failed",
        reply:"暂时无法判断你希望进行的操作，请告诉我你希望我处理什么。",
        artifacts:[]
      });
    }
    return this.processIncomingMessage(message);
  }

  async processIncomingMessage(message) {
    const security=checkIncomingSecurity(message,this.bindings);
    if (!security.ok) return {handled:false,reason:security.reason};
    if (typeof message.text==="string"&&!message.text.trim()) return {handled:false,reason:"empty_text"};
    const key=outcomeKey(message);
    if (this.state.hasOutcome(key)) return {handled:false,reason:"duplicate"};
    if (typeof message.text==="string") {
      const command=await handleModelCommand(message.text,{modelMode:this.modelMode,deepseekEnabled:this.deepseekEnabled});
      if (command) return this.persistAndSend(message,"model",command);
    }
    const conversation=await this.state.getRouterConversation(Date.parse(message.receivedAt));
    const dailyConversation=this.state.getConversation();
    const activeSnapshot=conversation?.model||dailyConversation?.model||null;
    let globalModel;
    const readGlobalModel=async()=>globalModel||=effectiveModel(await this.modelMode.read(),this.deepseekEnabled);
    const imageTask=isSingleImage(message),pdfTask=isSinglePdf(message),visualTask=imageTask||pdfTask;
    let capabilityName="router",draft,model;
    try {
      const attachmentTask=message.attachments.length===1;
      if (visualTask) {
        const resourceType=imageTask?"image":"file";
        const visualCapabilities=this.capabilities.filter(item=>item.routingContract.accepts.includes(resourceType));
        if (!visualCapabilities.length) {
          draft=visualUnsupported(message);
        } else {
          model=await readGlobalModel();
          if (model==="deepseek") {
            if (pdfTask) capabilityName="invoice";
            draft=pdfTask?deepseekInvoiceUnsupported():deepseekImageUnsupported();
          }
          else {
            if (typeof this.withPreparedVisual!=="function"||typeof this.intentRouter.decideVisual!=="function") throw new Error("visual_router_unavailable");
            const routerMessage=createRouterMessage(message);
            await this.withPreparedVisual(message,async preparedVisual=>{
              let decision;
              try {
                decision=await this.intentRouter.decideVisual({
                  model,preparedVisual,beijingTime:routerMessage.beijingTime,
                  capabilities:visualCapabilities.map(item=>structuredClone(item.routingContract))
                });
              } catch (error) { draft={...classifyAiFailure(error,model),artifacts:[]}; }
              if (decision?.action==="clarify") draft=visualClarification(message);
              else if (decision?.action==="unsupported") draft=visualUnsupported(message);
              else if (decision) {
                ({capabilityName,draft}=await this.applyDecision(
                  message,conversation,decision,model,
                  {dailyActive:!!dailyConversation,readGlobalModel,preparedVisual}
                ));
              }
            });
          }
        }
      } else {
        model=attachmentTask?await readGlobalModel():(activeSnapshot?effectiveModel(activeSnapshot,this.deepseekEnabled):await readGlobalModel());
        if (attachmentTask&&model==="deepseek") {
          capabilityName="invoice";
          draft=deepseekInvoiceUnsupported();
        } else {
          let decision;
          try { decision=await this.intentRouter.decide({message:createRouterMessage(message),conversation:conversation?publicConversation(conversation):null,capabilities:this.capabilities.map(item=>structuredClone(item.routingContract)),model}); }
          catch (error) { draft={...classifyAiFailure(error,model),artifacts:[]}; }
          if (decision) ({capabilityName,draft}=await this.applyDecision(message,conversation,decision,model,{dailyActive:!!dailyConversation,readGlobalModel}));
        }
      }
    } catch (error) {
      draft=visualTask
        ?visualPreparationFailure(message,error)
        :{status:"failed",reply:"暂时无法判断你希望进行的操作，请告诉我你希望我处理什么。",artifacts:[]};
    }
    return this.persistAndSend(message,capabilityName,draft);
  }

  async applyDecision(message,conversation,decision,model,{dailyActive,readGlobalModel,preparedVisual}) {
    if (decision.action==="unsupported") {
      if (decision.reason==="cancelled") {
        if (conversation) {
          await this.state.closeRouterConversation("cancelled");
          if (conversation.capability==="daily-work") await this.state.clearConversation();
          return {capabilityName:"router",draft:{status:"ignored",reply:null,artifacts:[]}};
        }
        return {capabilityName:"router",draft:{status:"rejected",reply:"当前没有待取消任务。",artifacts:[]}};
      }
      await this.state.clearRouterConversation();
      return {capabilityName:"router",draft:{status:"rejected",reply:decision.reason,artifacts:[]}};
    }
    if (decision.action==="clarify") return {capabilityName:"router",draft:await this.routeClarification(message,conversation,decision.question,conversation?.model||model)};
    if (decision.action!=="route"||decision.confidence!=="high") throw new Error("invalid_route");
    const capability=this.capabilities.find(item=>item.name===decision.capability);
    if (!capability) throw new Error("unknown_capability");
    const newTask=decision.reasonCode==="new_task"||(conversation?.capability&&decision.capability!==conversation.capability);
    const taskModel=newTask?await readGlobalModel():model;
    if (conversation&&newTask) {
      await this.state.closeRouterConversation("superseded");
      if (conversation.capability==="daily-work") await this.state.clearConversation();
    }
    else if (newTask&&dailyActive) await this.state.clearConversation();
    const context={state:this.state,model:taskModel};
    if (preparedVisual) context.preparedVisual=preparedVisual;
    let draft=await capability.handle(createBusinessMessage(message),context);
    if (draft?.status==="not_applicable") draft={status:"awaiting_clarification",reply:"我暂时无法确定你希望进行的操作，请告诉我你希望我处理什么。",artifacts:[]};
    if (draft?.status==="awaiting_clarification") {
      await this.state.setRouterConversation({capability:capability.name,question:draft.reply,startedAt:conversation?.startedAt||message.receivedAt,attempts:1,status:"open",model:taskModel});
    } else await this.state.clearRouterConversation();
    return {capabilityName:capability.name,draft};
  }

  async routeClarification(message,conversation,question,model) {
    if (conversation) {
      await this.state.clearRouterConversation();
      if (conversation.capability==="daily-work") await this.state.clearConversation();
      const lines=["当前可用能力：",...this.capabilities.map(item=>`- ${item.name}：${item.routingContract.purpose}`)];
      return {status:"awaiting_clarification",reply:lines.join("\n"),artifacts:[]};
    }
    await this.state.setRouterConversation({capability:null,question,startedAt:message.receivedAt,attempts:1,status:"open",model});
    return {status:"awaiting_clarification",reply:question,artifacts:[]};
  }

  async resumeReplies() {
    for (const outcome of this.state.unreplied()) {
      const replyTarget=outcome.replyTarget
        ?createReplyTarget(outcome.replyTarget)
        :createReplyTarget({source:"feishu",sourceMessageId:outcome.messageId,conversationId:this.binding.chatId});
      const message={source:replyTarget.source,sourceMessageId:replyTarget.sourceMessageId,replyTarget};
      await this.send(message,outcome.capability||"daily-work",outcome.reply);
      await this.state.markReplied(outcome.messageId);
    }
  }

  async handleMalformed(raw) {
    if (!isBoundMalformed(raw,this.binding)) return {handled:false,reason:"invalid_event"};
    if (this.state.hasOutcome(raw.message_id)) return {handled:false,reason:"duplicate"};
    return this.persistAndSend({source:"feishu",sourceMessageId:raw.message_id,replyTarget:createReplyTarget({source:"feishu",sourceMessageId:raw.message_id,conversationId:raw.chat_id})},"core",{status:"failed",reply:"消息结构无效，本条未处理；请重新发送。",artifacts:[]});
  }

  async persistAndSend(message,capability,draft) {
    validateDraft(draft);
    const key=outcomeKey(message);
    const noReplyRequired=draft.reply===null;
    await this.state.saveOutcome(key,{
      capability,status:draft.status,reply:draft.reply,artifacts:[...draft.artifacts],
      noReplyRequired,replyTarget:message.replyTarget,createdAt:new Date().toISOString()
    });
    if (noReplyRequired) return {handled:true,status:draft.status};
    await this.send(message,capability,draft.reply); await this.state.markReplied(key);
    return {handled:true,status:draft.status};
  }

  async send(message,capability,text) {
    const key=outcomeKey(message);
    const idempotencyKey=capability==="invoice"?`invoice-reply:${key}`:`reply:${key}`;
    try { await this.messenger.send({capability,replyTarget:message.replyTarget,text,idempotencyKey}); } catch { throw new Error("message_send_failed"); }
  }
}

export function outcomeKey(message) {
  if (message?.source==="feishu") return message.sourceMessageId;
  if (message?.source==="wechat") return `wechat:${message.sourceMessageId}`;
  throw new Error("invalid_incoming_message");
}

function publicConversation(value) { return {capability:value.capability,question:value.question,startedAt:value.startedAt}; }
function fallbackMessage(event) {
  if (event?.source&&event?.replyTarget) return event;
  return {
    source:"feishu",
    sourceMessageId:event.messageId,
    replyTarget:createReplyTarget({source:"feishu",sourceMessageId:event.messageId,conversationId:event.chatId})
  };
}
function createBusinessMessage(message) {
  if (message.source!=="wechat") return message;
  const value=structuredClone(message);
  value.replyTarget={
    source:value.replyTarget.source,
    sourceMessageId:value.replyTarget.sourceMessageId,
    conversationId:value.replyTarget.conversationId
  };
  return value;
}
function visualClarification(message) {
  if (isSinglePdf(message)) return {status:"awaiting_clarification",reply:"无法可靠判断这份 PDF 属于哪个已启用能力。\n本次文件未保存、未交给业务Skill。\n请重新发送内容清晰、完整的原始 PDF。",artifacts:[]};
  return {status:"awaiting_clarification",reply:"无法可靠判断这张图片属于哪个已启用能力。\n本次图片未保存、未交给业务Skill。\n请重新发送一张更清晰、内容完整的图片。",artifacts:[]};
}
function visualUnsupported(message) {
  return isSinglePdf(message)
    ?{status:"rejected",reply:"当前没有可处理这类 PDF 的已启用能力。",artifacts:[]}
    :{status:"rejected",reply:"当前没有可处理这类图片的已启用能力。",artifacts:[]};
}
function visualPreparationFailure(message,error) {
  if (isSinglePdf(message)) {
    if (typeof error?.code==="string"&&error.code.startsWith("pdf_")) return invoiceFailure("prepare_pdf",error.code);
    if (typeof error?.code==="string"&&error.code.startsWith("download")) return invoiceFailure("download",error.code);
    return invoiceFailure("inspect",error?.code);
  }
  return {status:"failed",reply:"图片准备失败，本次未交给 AI 或业务Skill、未写入 Obsidian；请重新发送受支持的原始图片。",artifacts:[]};
}
function deepseekInvoiceUnsupported() { return {status:"rejected",reply:"当前模型为 DeepSeek，但发票 PDF 需要 Codex 视觉判断。\n本次未调用模型、未归档文件、未写入 Obsidian。\n请先发送：/llw-model codex\n然后重新提交发票。",artifacts:[]}; }
function deepseekImageUnsupported() { return {status:"rejected",reply:"当前模型为 DeepSeek，但图片需要 Codex 进行视觉路由。\n本次未下载图片、未调用模型、未调用业务Skill、未写入 Obsidian。\n请先发送：/llw-model codex\n然后重新提交图片。",artifacts:[]}; }
function isSingleImage(message) { return message?.attachments?.length===1&&message.attachments[0]?.type==="image"; }
function isSinglePdf(message) { return message?.attachments?.length===1&&message.attachments[0]?.type==="file"&&message.attachments[0]?.extension==="pdf"; }
function isBoundMalformed(raw,binding) { return raw&&typeof raw==="object"&&raw.sender_id===binding.senderId&&raw.chat_id===binding.chatId&&raw.chat_type==="p2p"&&typeof raw.message_id==="string"&&raw.message_id.length>0; }
function validateDraft(draft) {
  const statuses=new Set(["committed","existing","awaiting_clarification","rejected","failed","ignored"]);
  if (!draft||!statuses.has(draft.status)||!Array.isArray(draft.artifacts)) throw new Error("invalid_outcome_draft");
  if (draft.status==="ignored") { if (draft.reply!==null||draft.artifacts.length) throw new Error("invalid_outcome_draft"); return; }
  if (typeof draft.reply!=="string"||!draft.reply.trim()) throw new Error("invalid_outcome_draft");
  if (draft.status==="committed"&&!draft.artifacts.length) throw new Error("invalid_outcome_draft");
}
