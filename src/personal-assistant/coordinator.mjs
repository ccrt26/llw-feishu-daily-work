import {assertContentSafe} from "./content-safety.mjs";
import {buildAgentTurnContext} from "./context-builder.mjs";
import {getModelToolDeclarations} from "./tool-definitions.mjs";
import {executeSaveKnowledge} from "./tools/save-knowledge.mjs";
import {executeRecordDailyWork} from "./tools/record-daily-work.mjs";
import {executeArchiveDiningInvoice} from "./tools/archive-dining-invoice.mjs";
import {executeCreateDocument} from "./tools/create-document.mjs";
import {createHash} from "node:crypto";
import {isConversationCancellation} from "./conversation.mjs";
import {
  extractFeishuDocumentRequests
} from "../core/feishu-document-link.mjs";
import {publicTaskContext} from "./task-session.mjs";

export class PersonalAssistantCoordinator {
  constructor({
    prepareSource,assistant,writer,dailyWriter,invoiceWriter,
    documentWorkspace,artifactGenerator,outcomeStore,messenger,
    conversationStore=null,loadDailyCandidates=async()=>[],
    personalRules,personalRulesStore=null,model,selectModel=null,skillVersion,
    sourceReader=null,maxSourceReadRounds=3,
    releasePreparedSource=null,
    taskManager=null,taskWorkspace=null
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
    this.sourceReader=sourceReader;
    this.maxSourceReadRounds=maxSourceReadRounds;
    this.releasePreparedSource=releasePreparedSource;
    this.taskManager=taskManager;
    this.taskWorkspace=taskWorkspace;
  }

  async handleTask(snapshot) {
    if (!this.taskManager||!this.taskWorkspace||
        !snapshot?.session||!snapshot?.message||
        !Array.isArray(snapshot.inputKeys)) {
      throw new Error("task_execution_invalid");
    }
    const source=snapshot.session.source;
    let phase="task_source_preparation_failed";
    try {
      let session=snapshot.session;
      let turnMessage=snapshot.message;
      let prepared;
      const hasNewSources=turnMessage.attachments.length>0||
        Boolean(extractFeishuDocumentRequests(turnMessage));
      if (session.model==="deepseek"&&hasNewSources) {
        return this.commitTaskResult(snapshot,{
          status:"rejected",
          reply:"当前 DeepSeek 仅支持纯文字每日工作；附件任务请先切换为 Codex。",
          artifacts:[],
          replyFiles:[],
          noReplyRequired:false,
          waiting:null,
          taskUpdate:null
        });
      }
      if (hasNewSources) {
        prepared=await this.taskWorkspace.prepareAndMerge({
          session,message:turnMessage
        });
        session=await this.taskManager.attachSources(snapshot,{
          addedSourceIds:prepared.addedSourceIds
        });
        if (!await this.taskManager.isCurrent(snapshot)) {
          return {status:"stale"};
        }
        if (typeof prepared.instructionText==="string") {
          turnMessage={
            ...turnMessage,
            instructionText:prepared.instructionText
          };
        }
      } else if (session.sourceIds.length) {
        prepared=await this.taskWorkspace.load({
          taskId:session.taskId,
          expectedSourceIds:session.sourceIds
        });
      } else {
        prepared={workspaceDir:null,sources:[]};
      }
      phase="content_safety_rejected";
      const task=publicTaskContext(session);
      assertContentSafe({
        instructionText:turnMessage.instructionText,
        sources:prepared.sources.map(source=>
          source.handle??source
        ),
        conversation:task,
        limits:{maxContextBytes:512*1024}
      });
      phase="personal_rules_load_failed";
      const personalRules=this.personalRulesStore
        ?await this.personalRulesStore.load()
        :this.personalRules;
      phase="daily_candidates_load_failed";
      const dailyCandidates=await this.loadDailyCandidates();
      const imageFiles=prepared.sources
        .filter(source=>
          (source.handle??source).mediaClass==="image"
        )
        .map(source=>source.absolutePath);
      let decision;
      let sourceObservations=[];
      let sourceReadRounds=0;
      while (true) {
        phase="agent_turn_context_invalid";
        const context=buildAgentTurnContext({
          message:turnMessage,
          sources:prepared.sources,
          sourceObservations,
          task,
          personalRules,
          model:session.model,
          toolDeclarations:getModelToolDeclarations(),
          dailyCandidates
        });
        phase="assistant_model_failed";
        decision=await this.assistant.decide(context,{
          workspaceDir:prepared.workspaceDir,
          imageFiles
        });
        if (decision.kind!=="source_read") break;
        if (!this.sourceReader||
            sourceReadRounds>=this.maxSourceReadRounds) {
          decision={
            kind:"reply",
            text:"当前只读环境无法继续取得足够的媒体观察，本次没有执行保存或其他写入。"
          };
          break;
        }
        phase="source_read_failed";
        const evidence=await this.sourceReader.read({
          requests:decision.requests,
          sources:prepared.sources,
          workspaceDir:prepared.workspaceDir,
          signal:prepared.signal
        });
        sourceObservations=[
          ...sourceObservations,...(evidence?.observations||[])
        ];
        sourceReadRounds+=1;
      }
      if (!await this.taskManager.isCurrent(snapshot)) {
        return {status:"stale"};
      }
      let result;
      if (decision.kind==="reply") {
        result={
          status:"committed",
          reply:decision.text,
          artifacts:[],
          waiting:null
        };
      } else if (decision.kind==="ask") {
        result={
          status:"awaiting_clarification",
          reply:decision.question,
          artifacts:[],
          waiting:{
            type:decision.waitingType??"waiting_answer",
            question:decision.question,
            preparedTool:decision.preparedTool??null,
            confirmed:decision.preparedRule
              ?{ruleProposal:decision.preparedRule}
              :{}
          }
        };
      } else if (decision.kind==="tool") {
        phase=`${decision.toolCall.name}_writer_reservation_failed`;
        const reserved=await this.taskManager.reserveWriter({
          source,
          taskId:snapshot.taskId,
          revision:snapshot.revision,
          updatedAt:snapshot.session.updatedAt,
          toolName:decision.toolCall.name
        });
        if (!reserved) return {status:"stale"};
        result=await this.executeTaskTool({
          decision,snapshot,message:turnMessage,prepared
        });
      } else {
        result={
          status:"rejected",
          reply:"当前任务暂时没有可安全执行的工具。",
          artifacts:[],
          waiting:null
        };
      }
      if (!await this.taskManager.isCommitCompatible(snapshot)) {
        return {status:"stale"};
      }
      return this.commitTaskResult(snapshot,{
        ...result,
        replyFiles:result.replyFile
          ?[structuredClone(result.replyFile)]
          :[],
        noReplyRequired:result.reply===null,
        taskUpdate:decision.taskUpdate??null
      });
    } catch (error) {
      if (error&&typeof error==="object") {
        error.failurePhase=phase;
      }
      throw error;
    }
  }

  async executeTaskTool({decision,snapshot,message,prepared}) {
    const name=decision.toolCall.name;
    if (name==="save_knowledge") {
      return executeSaveKnowledge({
        toolCall:decision.toolCall,
        sourceBindings:prepared.sources,
        instructionText:message.instructionText,
        writer:this.writer,
        skillVersion:this.skillVersion,
        ingestedAt:message.receivedAt
      });
    }
    if (name==="record_daily_work") {
      return executeRecordDailyWork({
        toolCall:decision.toolCall,
        messageId:message.sourceMessageId,
        createTime:Date.parse(message.receivedAt),
        writer:this.dailyWriter
      });
    }
    if (name==="archive_dining_invoice") {
      return executeArchiveDiningInvoice({
        toolCall:decision.toolCall,
        sourceBindings:prepared.sources,
        taskKey:`task:${snapshot.taskId}:${snapshot.revision}`,
        writer:this.invoiceWriter,
        currentInstruction:message.instructionText
      });
    }
    if (name==="create_document") {
      return executeCreateDocument({
        toolCall:decision.toolCall,
        sourceBindings:prepared.sources,
        sessionId:createHash("sha256")
          .update(`task-document:${snapshot.taskId}`)
          .digest("hex").slice(0,32),
        draftVersion:snapshot.revision,
        workspace:this.documentWorkspace,
        generate:this.artifactGenerator
      });
    }
    return {
      status:"rejected",
      reply:"当前任务暂时没有可安全执行的工具。",
      artifacts:[]
    };
  }

  async commitTaskResult(snapshot,result) {
    const publicResult={
      status:result.status,
      reply:result.reply,
      artifacts:result.artifacts||[],
      replyFiles:result.replyFiles||[],
      noReplyRequired:result.noReplyRequired===true,
      waiting:result.waiting??null,
      taskUpdate:result.taskUpdate??null,
      ...(result.status==="partial"
        ?{reasonCode:"writer_partial"}
        :result.status==="failed"
          ?{reasonCode:result.failureCode??"tool_execution_failed"}
          :{})
    };
    const committed=await this.taskManager.completeStage(
      snapshot,publicResult
    );
    if (!committed) return {status:"stale"};
    const key=snapshot.inputKeys.at(-1);
    const outcome=await this.outcomeStore.get(key);
    if (!outcome) throw new Error("task_outcome_missing");
    if (outcome.reply) {
      await this.sendOutcome(key,outcome,outcome.replyTarget);
    }
    return {status:"committed",outcome};
  }

  async handle(message) {
    const key=`${message.source}:${message.sourceMessageId}`;
    let active,turnMessage,model;
    let preflightPhase="outcome_lookup_failed";
    try {
      const existing=await this.outcomeStore.get(key);
      if (existing) {
        if (existing.reply&&existing.replied!==true) {
          preflightPhase="reply_recovery_failed";
          await this.sendOutcome(key,existing,message.replyTarget);
        }
        return existing;
      }
      preflightPhase="conversation_lookup_failed";
      active=await this.conversationStore?.get(
        message.source,message.receivedAt
      )??null;
      if (isConversationCancellation(message.instructionText)) {
        preflightPhase="conversation_state_failed";
        await this.conversationStore?.clear(message.source);
        if (active?.preparedSourceSetId&&this.releasePreparedSource) {
          await this.releasePreparedSource({
            preparedSourceSetId:active.preparedSourceSetId,
            source:message.source,userId:message.userId,
            conversationId:message.conversationId
          });
        }
        const outcome={
          status:"ignored",reply:null,artifacts:[],noReplyRequired:true,
          replyTarget:structuredClone(message.replyTarget)
        };
        preflightPhase="outcome_persist_failed";
        await this.outcomeStore.save(outcome,key);
        return outcome;
      }
      if (active?.waitingType==="waiting_confirmation"&&
          typeof active.confirmed?.ruleProposal==="string"&&
          isExactConfirmation(message.instructionText)) {
        preflightPhase="personal_rule_confirmation_failed";
        return await this.confirmPersonalRule({
          key,message,rule:active.confirmed.ruleProposal
        });
      }
      turnMessage=active?.waitingType==="waiting_file"&&
        message.attachments.length>=1&&!message.instructionText.trim()
        ?{...message,instructionText:active.instructionText}
        :message;
      preflightPhase="model_selection_failed";
      model=active?.model||
        (this.selectModel?await this.selectModel():this.model);
      if (model==="deepseek"&&(
        turnMessage.attachments.length||
        extractFeishuDocumentRequests(turnMessage)
      )) {
        preflightPhase="conversation_state_failed";
        await this.conversationStore?.clear(message.source);
        const outcome={
          status:"rejected",
          reply:"当前 DeepSeek 仅支持纯文字每日工作；附件任务请先切换为 Codex。",
          artifacts:[],replyFiles:[],noReplyRequired:false,
          replyTarget:structuredClone(message.replyTarget)
        };
        preflightPhase="outcome_persist_failed";
        await this.outcomeStore.save(outcome,key);
        preflightPhase="reply_delivery_failed";
        await this.sendOutcome(key,outcome,message.replyTarget);
        return outcome;
      }
    } catch (error) {
      if (error&&typeof error==="object") {
        error.failurePhase=preflightPhase;
      }
      throw error;
    }
    let prepared,retainPrepared=false;
    let failurePhase="source_preparation_failed";
    try {
      prepared=await this.prepareSource(turnMessage);
      if (typeof prepared?.instructionText==="string") {
        turnMessage={
          ...turnMessage,instructionText:prepared.instructionText
        };
      }
      failurePhase="content_safety_rejected";
      assertContentSafe({
        instructionText:turnMessage.instructionText,
        sources:(prepared?.sources||[]).map(source=>source.handle??source),
        conversation:active,
        limits:{maxContextBytes:512*1024}
      });
      failurePhase="personal_rules_load_failed";
      const personalRules=this.personalRulesStore
        ?await this.personalRulesStore.load()
        :this.personalRules;
      failurePhase="daily_candidates_load_failed";
      const dailyCandidates=await this.loadDailyCandidates();
      const imageFiles=(prepared?.sources||[])
        .filter(source=>(source.handle??source).mediaClass==="image")
        .map(source=>source.absolutePath);
      let decision,sourceObservations=[],sourceReadRounds=0;
      while (true) {
        failurePhase="agent_turn_context_invalid";
        const context=buildAgentTurnContext({
          message:turnMessage,
          sources:prepared?.sources||[],
          sourceObservations,
          conversation:active,
          personalRules,
          model,
          toolDeclarations:getModelToolDeclarations(),
          dailyCandidates
        });
        failurePhase="assistant_model_failed";
        decision=await this.assistant.decide(context,{
          workspaceDir:prepared?.workspaceDir,
          imageFiles
        });
        if (decision.kind!=="source_read") break;
        if (!this.sourceReader||
            sourceReadRounds>=this.maxSourceReadRounds) {
          decision={
            kind:"reply",
            text:"当前只读环境无法继续取得足够的媒体观察，本次没有执行保存或其他写入。"
          };
          break;
        }
        failurePhase="source_read_failed";
        const evidence=await this.sourceReader.read({
          requests:decision.requests,
          sources:prepared?.sources||[],
          workspaceDir:prepared?.workspaceDir,
          signal:prepared?.signal
        });
        sourceObservations=[
          ...sourceObservations,...(evidence?.observations||[])
        ];
        sourceReadRounds+=1;
      }
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
        failurePhase="save_knowledge_execution_failed";
        result=await executeSaveKnowledge({
          toolCall:decision.toolCall,
          sourceBindings:prepared.sources,
          instructionText:turnMessage.instructionText,
          writer:this.writer,
          skillVersion:this.skillVersion,
          ingestedAt:turnMessage.receivedAt
        });
      } else if (decision.toolCall.name==="record_daily_work") {
        failurePhase="record_daily_work_execution_failed";
        result=await executeRecordDailyWork({
          toolCall:decision.toolCall,
          messageId:turnMessage.sourceMessageId,
          createTime:Date.parse(turnMessage.receivedAt),
          writer:this.dailyWriter
        });
      } else if (decision.toolCall.name==="archive_dining_invoice") {
        failurePhase="archive_dining_invoice_execution_failed";
        result=await executeArchiveDiningInvoice({
          toolCall:decision.toolCall,
          sourceBindings:prepared.sources,
          taskKey:key,
          writer:this.invoiceWriter,
          currentInstruction:turnMessage.instructionText
        });
      } else if (decision.toolCall.name==="create_document") {
        failurePhase="create_document_execution_failed";
        result=await executeCreateDocument({
          toolCall:decision.toolCall,
          sourceBindings:prepared.sources,
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
      failurePhase="conversation_state_failed";
      if (result.status==="awaiting_clarification") {
        if (prepared?.preparedSourceSetId) {
          await prepared.retain?.("awaiting_clarification");
        }
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
          ...(prepared?.preparedSourceSetId
            ?{preparedSourceSetId:prepared.preparedSourceSetId}
            :{}),
          startedAt:active?.startedAt??message.receivedAt,
          updatedAt:message.receivedAt
        });
        retainPrepared=Boolean(prepared?.preparedSourceSetId);
      } else {
        await this.conversationStore?.clear(message.source);
      }
      const {failureCode,...publicResult}=result;
      const outcome={
        ...publicResult,
        ...(result.status==="partial"
          ?{reasonCode:"writer_partial"}
          :result.status==="failed"
            ?{reasonCode:failureCode??"tool_execution_failed"}
            :{}),
        replyFiles:result.replyFile?[structuredClone(result.replyFile)]:[],
        noReplyRequired:result.reply===null,
        replyTarget:structuredClone(message.replyTarget)
      };
      failurePhase="outcome_persist_failed";
      await this.outcomeStore.save(outcome,key);
      failurePhase="reply_delivery_failed";
      if (outcome.reply) await this.sendOutcome(key,outcome,message.replyTarget);
      return outcome;
    } catch (error) {
      if (error&&typeof error==="object") {
        error.failurePhase=failurePhase;
      }
      throw error;
    } finally {
      if (!retainPrepared) {
        const release=typeof prepared?.release==="function"
          ?prepared.release
          :typeof prepared?.cleanup==="function"
            ?prepared.cleanup
            :null;
        if (release) {
          try {
            await release.call(prepared,"turn_finished");
          } catch {
            // Cleanup is best effort after the durable outcome path.
          }
        }
      }
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
