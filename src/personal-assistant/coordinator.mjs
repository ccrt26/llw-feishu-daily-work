import {assertContentSafe} from "./content-safety.mjs";
import {buildAgentTurnContext} from "./context-builder.mjs";
import {getModelToolDeclarations} from "./tool-definitions.mjs";
import {executeSaveKnowledge} from "./tools/save-knowledge.mjs";
import {executeRecordDailyWork} from "./tools/record-daily-work.mjs";
import {executeArchiveDiningInvoice} from "./tools/archive-dining-invoice.mjs";
import {executeCreateDocument} from "./tools/create-document.mjs";
import {createHash} from "node:crypto";
import {isConversationCancellation} from "./conversation.mjs";

export class PersonalAssistantCoordinator {
  constructor({
    prepareSource,assistant,writer,dailyWriter,invoiceWriter,
    documentWorkspace,artifactGenerator,outcomeStore,messenger,
    conversationStore=null,loadDailyCandidates=async()=>[],
    personalRules,personalRulesStore=null,model,selectModel=null,skillVersion
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
    this.personalRulesStore=personalRulesStore;
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
    if (isConversationCancellation(message.instructionText)) {
      await this.conversationStore?.clear(message.source);
      const outcome={
        status:"ignored",reply:null,artifacts:[],noReplyRequired:true,
        replyTarget:structuredClone(message.replyTarget)
      };
      await this.outcomeStore.save(outcome,key);
      return outcome;
    }
    if (active?.waitingType==="waiting_confirmation"&&
        typeof active.confirmed?.ruleProposal==="string"&&
        isExactConfirmation(message.instructionText)) {
      return this.confirmPersonalRule({
        key,message,rule:active.confirmed.ruleProposal
      });
    }
    const turnMessage=active?.waitingType==="waiting_file"&&
      message.attachments.length>=1&&!message.instructionText.trim()
      ?{...message,instructionText:active.instructionText}
      :message;
    const model=active?.model||
      (this.selectModel?await this.selectModel():this.model);
    if (model==="deepseek"&&turnMessage.attachments.length) {
      await this.conversationStore?.clear(message.source);
      const outcome={
        status:"rejected",
        reply:"当前 DeepSeek 仅支持纯文字每日工作；附件任务请先切换为 Codex。",
        artifacts:[],replyFiles:[],noReplyRequired:false,
        replyTarget:structuredClone(message.replyTarget)
      };
      await this.outcomeStore.save(outcome,key);
      await this.sendOutcome(key,outcome,message.replyTarget);
      return outcome;
    }
    let prepared;
    try {
      prepared=await this.prepareSource(turnMessage);
      assertContentSafe({
        instructionText:turnMessage.instructionText,
        sources:(prepared?.sources||[]).map(source=>source.handle??source),
        conversation:active,
        limits:{maxContextBytes:512*1024}
      });
      const context=buildAgentTurnContext({
        message:turnMessage,
        sources:prepared?.sources||[],
        conversation:active,
        personalRules:this.personalRulesStore
          ?await this.personalRulesStore.load()
          :this.personalRules,
        model,
        toolDeclarations:getModelToolDeclarations(),
        dailyCandidates:await this.loadDailyCandidates()
      });
      const imageFiles=(prepared?.sources||[])
        .filter(source=>(source.handle??source).mediaClass==="image")
        .map(source=>source.absolutePath);
      const decision=await this.assistant.decide(context,{
        workspaceDir:prepared?.workspaceDir,
        imageFiles
      });
      let result;
      if (decision.kind==="reply") {
        result={status:"committed",reply:decision.text,artifacts:[]};
      } else if (decision.kind==="ask") {
        result={
          status:"awaiting_clarification",reply:decision.question,artifacts:[],
          waitingType:decision.waitingType??"waiting_answer",
          preparedTool:decision.preparedTool??null,
          preparedRule:decision.preparedRule??null
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
          confirmed:{
            ...(active?.confirmed??{}),
            ...(result.preparedRule
              ?{ruleProposal:result.preparedRule}
              :{})
          },
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

  async confirmPersonalRule({key,message,rule}) {
    let result;
    try {
      if (!this.personalRulesStore) throw new Error("rules_disabled");
      const receipt=await this.personalRulesStore.confirm(rule);
      result={
        status:receipt.status==="created"?"committed":"existing",
        reply:receipt.status==="created"
          ?"长期个人规则已保存。"
          :"这条长期个人规则已经保存过。",
        artifacts:[]
      };
    } catch {
      result={
        status:"failed",
        reply:"本次长期个人规则没有保存，请稍后重试。",
        artifacts:[]
      };
    }
    await this.conversationStore?.clear(message.source);
    const outcome={
      ...result,replyFiles:[],noReplyRequired:false,
      replyTarget:structuredClone(message.replyTarget)
    };
    await this.outcomeStore.save(outcome,key);
    await this.sendOutcome(key,outcome,message.replyTarget);
    return outcome;
  }
}

function isExactConfirmation(value) {
  return typeof value==="string"&&
    /^确认(?:保存(?:为长期规则)?)?[。！!\s]*$/u.test(value.trim());
}

function boundedTurns(active,message,reply) {
  return [
    ...(active?.turns||[]),
    {role:"user",text:message.instructionText||"（已发送一个附件）"},
    {role:"assistant",text:reply}
  ].slice(-8);
}
