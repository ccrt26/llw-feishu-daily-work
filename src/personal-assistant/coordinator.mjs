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
    personalRules,model,skillVersion
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
    this.personalRules=[...personalRules];
    this.model=model;
    this.skillVersion=skillVersion;
  }

  async handle(message) {
    const key=`${message.source}:${message.sourceMessageId}`;
    const existing=await this.outcomeStore.get(key);
    if (existing) {
      if (existing.reply) {
        await this.messenger.send(
          existing.replyTarget||message.replyTarget,
          existing.reply
        );
      }
      return existing;
    }
    const prepared=await this.prepareSource(message);
    assertContentSafe({
      instructionText:message.instructionText,
      evidence:prepared?.evidence??null,
      conversation:null,
      limits:{maxContextBytes:512*1024}
    });
    const context=buildAgentTurnContext({
      message,
      evidence:prepared?.evidence??null,
      conversation:null,
      personalRules:this.personalRules,
      model:this.model,
      toolDeclarations:getModelToolDeclarations()
    });
    const decision=await this.assistant.decide(context);
    let result;
    if (decision.kind==="reply") {
      result={status:"committed",reply:decision.text,artifacts:[]};
    } else if (decision.kind==="ask") {
      result={status:"awaiting_clarification",reply:decision.question,artifacts:[]};
    } else if (decision.toolCall.name==="save_knowledge") {
      result=await executeSaveKnowledge({
        toolCall:decision.toolCall,
        preparedSource:prepared.preparedSource,
        writer:this.writer,
        skillVersion:this.skillVersion,
        ingestedAt:message.receivedAt
      });
    } else if (decision.toolCall.name==="record_daily_work") {
      result=await executeRecordDailyWork({
        toolCall:decision.toolCall,
        messageId:message.sourceMessageId,
        createTime:Date.parse(message.receivedAt),
        writer:this.dailyWriter
      });
    } else if (decision.toolCall.name==="archive_dining_invoice") {
      result=await executeArchiveDiningInvoice({
        toolCall:decision.toolCall,
        analysisInput:prepared.analysisInput,
        transactionId:createHash("sha256")
          .update(`invoice:${message.source}:${message.sourceMessageId}`)
          .digest("hex").slice(0,32),
        writer:this.invoiceWriter,
        currentInstruction:message.instructionText
      });
    } else if (decision.toolCall.name==="create_document") {
      result=await executeCreateDocument({
        toolCall:decision.toolCall,
        sessionId:createHash("sha256")
          .update(`document:${message.source}:${message.sourceMessageId}`)
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
    const outcome={
      ...result,
      replyTarget:structuredClone(message.replyTarget)
    };
    await this.outcomeStore.save(outcome,key);
    if (outcome.reply) {
      await this.messenger.send(
        outcome.replyTarget,outcome.reply,outcome.replyFile??null
      );
    }
    return outcome;
  }
}
