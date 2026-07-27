import {assertContentSafe} from "./content-safety.mjs";
import {buildAgentTurnContext} from "./context-builder.mjs";
import {getModelToolDeclarations} from "./tool-definitions.mjs";
import {executeSaveKnowledge} from "./tools/save-knowledge.mjs";
import {executeRecordDailyWork} from "./tools/record-daily-work.mjs";
import {executeArchiveDiningInvoice} from "./tools/archive-dining-invoice.mjs";
import {executeCreateDocument} from "./tools/create-document.mjs";
import {createHash} from "node:crypto";

export class PersonalAssistantCoordinator {
  constructor({
    prepareSource,assistant,writer,dailyWriter,invoiceWriter,
    documentWorkspace,artifactGenerator,outcomeStore,messenger,
    conversationStore=null,loadDailyCandidates=async()=>[],
    personalRules,model,selectModel=null,skillVersion
  }) {
    this.prepareSource=prepareSource;
    this.assistant=assistant;
    this.writer=writer;
    this.dailyWriter=dailyWriter;
    this.invoiceWriter=invoiceWriter;
    this.documentWorkspace=documentWorkspace;
    this.artifactGenerator=artifactGenerator;
    this.outcomeStore=outcomeStore;
    this.messenger=messenger;
    this.conversationStore=conversationStore;
    this.loadDailyCandidates=loadDailyCandidates;
    this.personalRules=[...personalRules];
    this.model=model;
    this.selectModel=selectModel;
    this.skillVersion=skillVersion;
  }

  async handle(message) {
    const key=`${message.source}:${message.sourceMessageId}`;
    const existing=await this.outcomeStore.get(key);
    if (existing) {
      if (existing.reply&&existing.replied!==true) {
        await this.sendOutcome(key,existing,message.replyTarget);
      }
      return existing;
    }
    const active=await this.conversationStore?.get(
      message.source,message.receivedAt
    )??null;
    if (isCancellation(message.instructionText)) {
      await this.conversationStore?.clear(message.source);
      const outcome={
        status:"ignored",reply:null,artifacts:[],noReplyRequired:true,
        replyTarget:structuredClone(message.replyTarget)
      };
      await this.outcomeStore.save(outcome,key);
      return outcome;
    }
    const turnMessage=active?.waitingType==="waiting_file"&&
      message.attachments.length===1&&!message.instructionText.trim()
      ?{...message,instructionText:active.instructionText}
      :message;
    const model=active?.model||
      (this.selectModel?await this.selectModel():this.model);
    let prepared;
    try {
      prepared=await this.prepareSource(turnMessage);
      assertContentSafe({
        instructionText:turnMessage.instructionText,
        evidence:prepared?.evidence??null,
        conversation:active,
        limits:{maxContextBytes:512*1024}
      });
      const context=buildAgentTurnContext({
        message:turnMessage,
        evidence:prepared?.evidence??null,
        conversation:active,
        personalRules:this.personalRules,
        model,
        toolDeclarations:getModelToolDeclarations(),
        dailyCandidates:await this.loadDailyCandidates()
      });
      const decision=await this.assistant.decide(context,{
        imageFiles:[...(prepared?.imageFiles||[])]
      });
      let result;
      if (decision.kind==="reply") {
        result={status:"committed",reply:decision.text,artifacts:[]};
      } else if (decision.kind==="ask") {
        result={
          status:"awaiting_clarification",reply:decision.question,artifacts:[],
          waitingType:decision.waitingType??"waiting_answer",
          preparedTool:decision.preparedTool??null
        };
      } else if (decision.toolCall.name==="save_knowledge") {
        result=await executeSaveKnowledge({
          toolCall:decision.toolCall,
          preparedSource:prepared.preparedSource,
          writer:this.writer,
          skillVersion:this.skillVersion,
          ingestedAt:turnMessage.receivedAt
        });
      } else if (decision.toolCall.name==="record_daily_work") {
        result=await executeRecordDailyWork({
          toolCall:decision.toolCall,
          messageId:turnMessage.sourceMessageId,
          createTime:Date.parse(turnMessage.receivedAt),
          writer:this.dailyWriter
        });
      } else if (decision.toolCall.name==="archive_dining_invoice") {
        result=await executeArchiveDiningInvoice({
          toolCall:decision.toolCall,
          analysisInput:prepared.analysisInput,
          transactionId:createHash("sha256")
            .update(`invoice:${turnMessage.source}:${turnMessage.sourceMessageId}`)
            .digest("hex").slice(0,32),
          writer:this.invoiceWriter,
          currentInstruction:turnMessage.instructionText
        });
      } else if (decision.toolCall.name==="create_document") {
        result=await executeCreateDocument({
          toolCall:decision.toolCall,
          sessionId:createHash("sha256")
            .update(`document:${turnMessage.source}:${turnMessage.sourceMessageId}`)
            .digest("hex").slice(0,32),
          draftVersion:1,
          workspace:this.documentWorkspace,
          generate:this.artifactGenerator
        });
      } else {
        result={
          status:"rejected",
          reply:"当前任务暂时没有可安全执行的工具。",
          artifacts:[]
        };
      }
      if (result.status==="awaiting_clarification") {
        await this.conversationStore?.set(message.source,{
          waitingType:result.waitingType,
          question:result.reply,
          instructionText:turnMessage.instructionText,
          preparedTool:result.preparedTool,
          confirmed:active?.confirmed??{},
          turns:boundedTurns(active,turnMessage,result.reply),
          model,
          startedAt:active?.startedAt??message.receivedAt,
          updatedAt:message.receivedAt
        });
      } else {
        await this.conversationStore?.clear(message.source);
      }
      const outcome={
        ...result,
        replyFiles:result.replyFile?[structuredClone(result.replyFile)]:[],
        noReplyRequired:result.reply===null,
        replyTarget:structuredClone(message.replyTarget)
      };
      await this.outcomeStore.save(outcome,key);
      if (outcome.reply) await this.sendOutcome(key,outcome,message.replyTarget);
      return outcome;
    } finally {
      await prepared?.cleanup?.().catch(()=>{});
    }
  }

  async sendOutcome(key,outcome,fallbackTarget) {
    await this.messenger.send({
      capability:"personal-assistant",
      replyTarget:outcome.replyTarget||fallbackTarget,
      text:outcome.reply,
      idempotencyKey:`reply:${key}`,
      replyFiles:structuredClone(
        outcome.replyFiles||
        (outcome.replyFile?[outcome.replyFile]:[])
      )
    });
    await this.outcomeStore.markReplied?.(key);
  }
}

function isCancellation(value) {
  return typeof value==="string"&&
    /^(?:不用了[，,。\s]*)?(?:取消|算了|不用了)[。！!\s]*$/u.test(value.trim());
}

function boundedTurns(active,message,reply) {
  return [
    ...(active?.turns||[]),
    {role:"user",text:message.instructionText||"（已发送一个附件）"},
    {role:"assistant",text:reply}
  ].slice(-8);
}
