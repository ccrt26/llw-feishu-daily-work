import {assertContentSafe} from "./content-safety.mjs";
import {buildAgentTurnContext} from "./context-builder.mjs";
import {getModelToolDeclarations} from "./tool-definitions.mjs";
import {executeSaveKnowledge} from "./tools/save-knowledge.mjs";
import {executeRecordDailyWork} from "./tools/record-daily-work.mjs";
import {executeArchiveDiningInvoice} from "./tools/archive-dining-invoice.mjs";
import {executeCreateDocument} from "./tools/create-document.mjs";
import {createHash} from "node:crypto";
import {
  extractFeishuDocumentRequests
} from "../core/feishu-document-link.mjs";
import {publicTaskContext} from "./task-session.mjs";
import {
  extractPublicVideoRequest
} from "./public-video-link.mjs";
import {
  MODEL_VISUAL_EVIDENCE_SPLIT_REPLY,
  planModelVisualEvidence
} from "./model-visual-evidence-plan.mjs";

export class PersonalAssistantCoordinator {
  constructor({
    assistant,writer,dailyWriter,invoiceWriter,
    documentWorkspace,artifactGenerator,outcomeStore,messenger,
    loadDailyCandidates=async()=>[],
    personalRules,personalRulesStore=null,skillVersion,
    sourceReader=null,maxSourceReadRounds=3,pdfReader=null,
    docxReader=null,docxAiTimeoutMs=600_000,docxProgressMs=300_000,
    publicVideoReader=null,
    taskManager=null,taskWorkspace=null,
    setTimer=globalThis.setTimeout,clearTimer=globalThis.clearTimeout
  }) {
    this.assistant=assistant;
    this.writer=writer;
    this.dailyWriter=dailyWriter;
    this.invoiceWriter=invoiceWriter;
    this.documentWorkspace=documentWorkspace;
    this.artifactGenerator=artifactGenerator;
    this.outcomeStore=outcomeStore;
    this.messenger=messenger;
    this.loadDailyCandidates=loadDailyCandidates;
    this.personalRules=[...personalRules];
    this.personalRulesStore=personalRulesStore;
    this.skillVersion=skillVersion;
    this.sourceReader=sourceReader;
    this.maxSourceReadRounds=maxSourceReadRounds;
    this.pdfReader=pdfReader;
    this.docxReader=docxReader;
    this.docxAiTimeoutMs=docxAiTimeoutMs;
    this.docxProgressMs=docxProgressMs;
    this.publicVideoReader=publicVideoReader;
    this.taskManager=taskManager;
    this.taskWorkspace=taskWorkspace;
    this.setTimer=setTimer;
    this.clearTimer=clearTimer;
    this.taskControllers=new Map();
  }

  async handleTask(snapshot) {
    if (!this.taskManager||!this.taskWorkspace||
        !snapshot?.session||!snapshot?.message||
        !Array.isArray(snapshot.inputKeys)) {
      throw new Error("task_execution_invalid");
    }
    const source=snapshot.session.source;
    const taskController=new AbortController();
    this.trackTaskController(snapshot.taskId,taskController);
    let phase="task_source_preparation_failed";
    try {
      let session=snapshot.session;
      let turnMessage=snapshot.message;
      let prepared;
      const publicVideoRequest=this.publicVideoReader
        ?extractPublicVideoRequest(turnMessage.instructionText)
        :null;
      if (publicVideoRequest) {
        phase="public_video_source_preparation_failed";
      }
      const hasNewSources=turnMessage.attachments.length>0||
        Boolean(extractFeishuDocumentRequests(turnMessage))||
        Boolean(publicVideoRequest);
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
          session,message:turnMessage,
          signal:taskController.signal
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
        prepared=await this.taskWorkspace.ensure({session});
      }
      const sourceHandles=prepared.sources.map(source=>source.handle??source);
      const hasDocx=sourceHandles.some(handle=>handle.format==="docx");
      const hasPublicVideo=sourceHandles.some(handle=>
        handle.mediaClass==="video"&&
        handle.representationIndexPath===`${handle.sourceId}.manifest.json`
      );
      if (hasDocx&&hasPublicVideo) {
        return this.commitTaskResult(snapshot,{
          status:"rejected",
          reply:"Word 文档和公开视频需要分成两个任务处理；本次没有调用 AI 或 Writer，也没有写入。请分别发送。",
          artifacts:[],replyFiles:[],noReplyRequired:false,
          waiting:null,taskUpdate:null
        });
      }
      if (hasDocx&&session.model!=="codex") {
        return this.commitTaskResult(snapshot,{
          status:"rejected",
          reply:"Word 文档分析需要使用 Codex；本次没有调用 AI 或 Writer，也没有写入。请先切换为 Codex。",
          artifacts:[],replyFiles:[],noReplyRequired:false,
          waiting:null,taskUpdate:null
        });
      }
      let docxEvidence={
        observations:[],modelImageFiles:[],coverageBySource:{}
      };
      if (hasDocx) {
        phase="docx_prepare_failed";
        if (!this.docxReader) throw new Error("docx_prepare_failed");
        docxEvidence=await this.docxReader.prepare({
          workspaceDir:prepared.workspaceDir,
          sources:prepared.sources,
          signal:taskController.signal,
          now:turnMessage.receivedAt
        });
      }
      let pdfEvidence={
        observations:[],
        modelImageFiles:[]
      };
      if (this.pdfReader) {
        phase="pdf_prepare_failed";
        pdfEvidence=await this.pdfReader.prepare({
          workspaceDir:prepared.workspaceDir,
          sources:prepared.sources,
          signal:taskController.signal,
          now:turnMessage.receivedAt
        });
      }
      let publicVideoEvidence={
        observations:[],
        modelImageFiles:[]
      };
      if (this.publicVideoReader) {
        phase="public_video_prepare_failed";
        publicVideoEvidence=await this.publicVideoReader.prepare({
          workspaceDir:prepared.workspaceDir,
          sources:prepared.sources,
          signal:taskController.signal,
          now:turnMessage.receivedAt,
          onProcessingAccepted:()=>
            this.sendProcessingReceipt(snapshot)
        });
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
      let sourceObservations=[
        ...(docxEvidence.observations||[]),
        ...(pdfEvidence.observations||[]),
        ...(publicVideoEvidence.observations||[])
      ];
      let modelImageFiles=[
        ...(docxEvidence.modelImageFiles||[]),
        ...(pdfEvidence.modelImageFiles||[]),
        ...(publicVideoEvidence.modelImageFiles||[])
      ];
      let sourceReadRounds=0;
      while (true) {
        const visualPlan=planModelVisualEvidence({
          imageFiles,modelImageFiles
        });
        if (visualPlan.kind==="requires_split") {
          return this.commitTaskResult(snapshot,{
            status:"rejected",
            reply:MODEL_VISUAL_EVIDENCE_SPLIT_REPLY,
            artifacts:[],
            replyFiles:[],
            noReplyRequired:false,
            waiting:null,
            taskUpdate:null
          });
        }
        modelImageFiles=visualPlan.modelImageFiles;
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
        const allowSourceRead=Boolean(this.sourceReader)&&
          sourceReadRounds<this.maxSourceReadRounds&&
          imageFiles.length+modelImageFiles.length<16;
        const docxCall=hasDocx;
        let cancelProgress=null;
        try {
          if (docxCall) {
            cancelProgress=this.scheduleDocxProgress(snapshot);
          }
          decision=await this.assistant.decide(context,{
            workspaceDir:prepared.workspaceDir,
            imageFiles,
            modelImageFiles,
            allowSourceRead:docxCall?false:allowSourceRead,
            ...(docxCall?{timeoutMs:this.docxAiTimeoutMs}:{})
          });
        } finally {
          cancelProgress?.();
        }
        if (decision.kind!=="source_read") break;
        if (docxCall||!allowSourceRead) {
          decision={
            kind:"reply",
            text:"本轮可用的视频区间读取次数或图片容量已经用完，本次没有执行保存或其他写入。"
          };
          break;
        }
        phase="source_read_failed";
        let evidence;
        try {
          evidence=await this.sourceReader.read({
            requests:decision.requests,
            sources:prepared.sources,
            workspaceDir:prepared.workspaceDir,
            signal:taskController.signal
          });
        } catch (error) {
          if (error?.name==="AbortError") throw error;
          decision={
            kind:"reply",
            text:"未能取得模型请求的视频时间区间画面；本次仅保留已有证据，没有执行保存或其他写入。"
          };
          break;
        }
        if (!await this.taskManager.isCurrent(snapshot)) {
          return {status:"stale"};
        }
        sourceObservations=[
          ...sourceObservations,...(evidence?.observations||[])
        ];
        modelImageFiles=mergeModelImageFiles(
          modelImageFiles,evidence?.modelImageFiles||[]
        );
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
        const coverageBlock=decision.toolCall.name==="save_knowledge"
          ?selectedDocxCoverageBlock({
            toolCall:decision.toolCall,
            sources:prepared.sources,
            coverageBySource:docxEvidence.coverageBySource||{}
          })
          :null;
        if (coverageBlock) {
          result={
            status:"committed",reply:coverageBlock,
            artifacts:[],waiting:null
          };
        } else {
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
        }
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
    } finally {
      this.releaseTaskController(snapshot.taskId,taskController);
    }
  }

  async sendProcessingReceipt(snapshot) {
    let reserved=false;
    try {
      reserved=await this.taskManager
        .attemptProcessingReceipt(snapshot);
    } catch {
      return false;
    }
    if (!reserved) return false;
    try {
      await this.messenger.send({
        capability:"personal-assistant",
        replyTarget:structuredClone(snapshot.message.replyTarget),
        text:"已收到，正在处理。",
        idempotencyKey:`processing:${snapshot.taskId}`,
        replyFiles:[]
      });
      return true;
    } catch {
      return false;
    }
  }

  scheduleDocxProgress(snapshot) {
    let active=true;
    let attempted=false;
    const timer=this.setTimer(async()=>{
      if (!active||attempted) return false;
      attempted=true;
      try {
        if (!await this.taskManager.isCurrent(snapshot)) return false;
        await this.messenger.send({
          capability:"personal-assistant",
          replyTarget:structuredClone(snapshot.message.replyTarget),
          text:"文档内容较多，我仍在阅读和分析；完成后会直接回复。",
          idempotencyKey:
            `docx-progress:${snapshot.taskId}:${snapshot.revision}`,
          replyFiles:[]
        });
        return true;
      } catch {
        return false;
      }
    },this.docxProgressMs);
    return ()=>{
      if (!active) return;
      active=false;
      this.clearTimer(timer);
    };
  }

  async cancelTaskWork({taskId}) {
    if (typeof taskId!=="string") return;
    for (const controller of this.taskControllers.get(taskId)||[]) {
      controller.abort();
    }
  }

  trackTaskController(taskId,controller) {
    const active=this.taskControllers.get(taskId)??new Set();
    active.add(controller);
    this.taskControllers.set(taskId,active);
  }

  releaseTaskController(taskId,controller) {
    const active=this.taskControllers.get(taskId);
    if (!active) return;
    active.delete(controller);
    if (!active.size) this.taskControllers.delete(taskId);
  }

  async executeTaskTool({decision,snapshot,message,prepared}) {
    const name=decision.toolCall.name;
    if (name==="save_knowledge") {
      return executeSaveKnowledge({
        toolCall:decision.toolCall,
        sourceBindings:prepared.sources,
        workspaceDir:prepared.workspaceDir,
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

function mergeModelImageFiles(current,additional) {
  if (!Array.isArray(additional)) {
    throw new Error("source_reader_result_invalid");
  }
  const result=current.map(value=>structuredClone(value));
  const seen=new Map(result.map(value=>[
    `${value.sourceId}\0${value.relativePath}`,
    JSON.stringify(value)
  ]));
  for (const value of additional) {
    const key=`${value?.sourceId}\0${value?.relativePath}`;
    const serialized=JSON.stringify(value);
    if (seen.has(key)) {
      if (seen.get(key)!==serialized) {
        throw new Error("source_reader_result_invalid");
      }
      continue;
    }
    seen.set(key,serialized);
    result.push(structuredClone(value));
  }
  return result;
}

function selectedDocxCoverageBlock({toolCall,sources,coverageBySource}) {
  const argumentsValue=toolCall?.arguments||{};
  const selected=new Set([
    ...(Array.isArray(argumentsValue.sourceIds)
      ?argumentsValue.sourceIds:[]),
    ...(Array.isArray(argumentsValue.evidenceSourceIds)
      ?argumentsValue.evidenceSourceIds:[])
  ]);
  const bindings=new Map(sources.map(source=>{
    const handle=source?.handle??source;
    return [handle.sourceId,handle];
  }));
  const limitations=new Set();
  let missing=false;
  for (const sourceId of selected) {
    const handle=bindings.get(sourceId);
    if (handle?.format!=="docx") continue;
    const coverage=coverageBySource[sourceId];
    if (!validDocxCoverage(coverage,handle)) {
      missing=true;
      continue;
    }
    if (coverage.status!=="complete") {
      for (const limitation of coverage.limitations) {
        limitations.add(limitation);
      }
    }
  }
  if (!missing&&limitations.size===0) return null;
  if (limitations.size>0) {
    const visible=[...limitations].slice(0,3).map(humanDocxLimitation);
    return `所选 Word 文档仍有未完整表示的内容（${visible.join("、")}），因此本次没有调用 Writer，也没有写入。可以先查看当前总结，但要入库请提供不含这些复杂内容的版本。`;
  }
  return "所选 Word 文档的完整覆盖证据与当前原件不匹配，因此本次没有调用 Writer，也没有写入；来源仍保留，可以直接重试。";
}

function validDocxCoverage(value,handle) {
  return value&&typeof value==="object"&&!Array.isArray(value)&&
    value.sourceId===handle.sourceId&&
    value.originalSha256===handle.sha256&&
    value.indexRelativePath===`${handle.sourceId}.docx-index.json`&&
    /^[a-f0-9]{64}$/u.test(value.indexSha256||"")&&
    new Set(["complete","partial"]).has(value.status)&&
    Array.isArray(value.limitations)&&value.limitations.length<=32&&
    value.limitations.every(item=>
      typeof item==="string"&&/^[a-z0-9_]{1,64}$/u.test(item)
    )&&
    (value.status==="complete")===(value.limitations.length===0);
}

function humanDocxLimitation(value) {
  return new Map([
    ["chart","图表"],["smart_art","SmartArt"],["equation","公式"],
    ["text_box","文本框"],["tracked_changes","修订内容"],
    ["comments","批注"],["unsupported_image_format","非 PNG 图片"],
    ["image_budget_exceeded","图片数量超限"],
    ["text_budget_exceeded","文字内容超限"]
  ]).get(value)||"复杂版式或暂不支持的内容";
}
