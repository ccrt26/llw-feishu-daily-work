import {rm} from "node:fs/promises";
import {validateKnowledgeDecision} from "./decision-validator.mjs";
import {
  formatKnowledgeAttachmentNeedsRequest,formatKnowledgeCodexOnly,
  formatKnowledgeCommit,formatKnowledgeFailure,
  formatKnowledgeExtractionPartial,formatKnowledgeFolder,
  formatKnowledgePending,formatKnowledgeQuestion,
  formatKnowledgeReject
} from "./receipt.mjs";

const FAILURE_CODES=new Set([
  "knowledge_source_prepare_failed",
  "knowledge_library_catalog_failed",
  "knowledge_decision_failed",
  "knowledge_decision_copy_failed",
  "knowledge_decision_spawn_failed",
  "knowledge_decision_timeout",
  "knowledge_decision_process_failed",
  "knowledge_decision_output_failed",
  "knowledge_decision_validation_failed",
  "knowledge_writer_failed",
  "knowledge_state_failed",
  "knowledge_receipt_failed"
]);

export function createKnowledgeIngestCapability({
  decide,writer,catalog,sourcePreparer,filePreparer,download,
  documentExporter,cleanup=defaultCleanup,skillVersion,onFailureStage=()=>{}
}) {
  async function processPrepared({
    request,source,content,sourceBytes,libraries,state,startedAt,allowPending,
    channel,ingestedAt,confirmedTarget=null
  }) {
    const raw=await runStage("knowledge_decision_failed",()=>decide({
      model:"codex",request,source,sourceContent:content,
      allowedLibraries:libraries,taskSummary:null,
      ...(confirmedTarget?{confirmedTarget}: {})
    }));
    const decision=await runStage(
      "knowledge_decision_validation_failed",
      ()=>validateKnowledgeDecision(raw,{libraries})
    );
    const library=libraries.find(item=>item.libraryKey===decision.libraryKey);
    if (decision.action==="commit") {
      const result=await runStage("knowledge_writer_failed",()=>writer.commit({
        libraryKey:decision.libraryKey,
        folderSegments:[...decision.target.segments],
        title:decision.title,
        summary:decision.summary,
        tags:[...decision.tags],
        knowledgeSections:structuredClone(decision.knowledgeSections),
        source:sourceBytes
          ?{...source,content,sourceBytes}
          :{...source,content},
        skillVersion,ingestedAt
      }));
      await runStage(
        "knowledge_state_failed",()=>state.clearKnowledgePending(channel)
      );
      return runStage(
        "knowledge_receipt_failed",
        ()=>formatKnowledgeCommit(decision,result,library)
      );
    }
    if (decision.action==="create_folder") {
      const result=await runStage("knowledge_writer_failed",()=>writer.createFolder({
        libraryKey:decision.libraryKey,
        segments:[...decision.target.segments]
      }));
      await runStage(
        "knowledge_state_failed",()=>state.clearKnowledgePending(channel)
      );
      return runStage(
        "knowledge_receipt_failed",
        ()=>formatKnowledgeFolder(result,library)
      );
    }
    if (decision.action==="await_file") {
      if (allowPending) {
        await runStage("knowledge_state_failed",()=>state.setKnowledgePending({
          source:channel,startedAt,model:"codex",
          libraryKey:decision.libraryKey,
          target:structuredClone(decision.target)
        }));
        return runStage("knowledge_receipt_failed",()=>formatKnowledgePending());
      }
      return runStage(
        "knowledge_receipt_failed",
        ()=>formatKnowledgeReject("source_incomplete")
      );
    }
    if (decision.action==="ask_user") {
      return runStage(
        "knowledge_receipt_failed",
        ()=>formatKnowledgeQuestion(decision,library,libraries)
      );
    }
    await runStage(
      "knowledge_state_failed",()=>state.clearKnowledgePending(channel)
    );
    return runStage(
      "knowledge_receipt_failed",
      ()=>formatKnowledgeReject(decision.reasonCode)
    );
  }

  return {
    name:"knowledge-ingest",
    async handle(message,{state,model="codex",knowledgePending=null}={}) {
      if (model!=="codex") return formatKnowledgeCodexOnly();
      const documentRequest=feishuDocumentRequest(message);
      if (documentRequest) {
        let exported,stage="knowledge_source_prepare_failed";
        try {
          exported=await documentExporter({url:documentRequest.url});
          const preparedFile=await filePreparer({
            file:exported.file,
            displayName:exported.displayName,
            extension:exported.extension
          });
          const {content,sourceBytes,...source}=preparedFile;
          source.sourceKind="feishu_document";
          source.safeSourceReference=exported.safeSourceReference;
          if (source.extractionIntegrity!=="complete") {
            return formatKnowledgeExtractionPartial(
              source.extractionLimitations
            );
          }
          stage="knowledge_library_catalog_failed";
          const libraries=await catalog();
          return await processPrepared({
            request:documentRequest.safeRequest,source,content,sourceBytes,
            libraries,state,startedAt:message.receivedAt,allowPending:false,
            channel:message.source,ingestedAt:message.receivedAt
          });
        } catch (error) {
          return reportFailure(onFailureStage,error,stage);
        } finally {
          if (exported?.tempDir) {
            try { await cleanup(exported.tempDir); } catch { /* scavenger retries */ }
          }
        }
      }
      if (validDirectTextMessage(message)) {
        let stage="knowledge_source_prepare_failed";
        try {
          const request=message.text.trim();
          const source=await sourcePreparer({text:request});
          stage="knowledge_library_catalog_failed";
          const libraries=await catalog();
          return await processPrepared({
            request,source,content:request,libraries,state,
            startedAt:message.receivedAt,allowPending:true,
            channel:message.source,ingestedAt:message.receivedAt
          });
        } catch (error) {
          return reportFailure(onFailureStage,error,stage);
        }
      }
      if (!validKnowledgeFileMessage(message)) {
        return formatKnowledgeReject("unsupported_format");
      }
      let downloaded,stage="knowledge_state_failed";
      try {
        const nowMs=Date.parse(message.receivedAt);
        const pending=knowledgePending||
          await state.getKnowledgePending(message.source,nowMs);
        if (pending?.source!==message.source) {
          return formatKnowledgeAttachmentNeedsRequest();
        }
        if (!pending) return formatKnowledgeAttachmentNeedsRequest();
        const attachment=message.attachments[0];
        stage="knowledge_source_prepare_failed";
        downloaded=await download({
          source:message.source,
          sourceMessageId:message.sourceMessageId,
          attachment:structuredClone(attachment)
        });
        const preparedFile=await filePreparer({
          file:downloaded.file,
          displayName:attachment.displayName,
          extension:attachment.extension
        });
        const {content,sourceBytes,...source}=preparedFile;
        if (source.extractionIntegrity!=="complete") {
          return formatKnowledgeExtractionPartial(
            source.extractionLimitations
          );
        }
        stage="knowledge_library_catalog_failed";
        const libraries=await catalog();
        return await processPrepared({
          request:"将当前附件导入已确认的知识库目标。",
          source,content,sourceBytes,libraries,state,
          startedAt:pending.startedAt,allowPending:false,
          channel:message.source,ingestedAt:message.receivedAt,
          confirmedTarget:{
            libraryKey:pending.libraryKey,
            target:structuredClone(pending.target)
          }
        });
      } catch (error) {
        return reportFailure(onFailureStage,error,stage);
      } finally {
        if (downloaded?.tempDir) {
          try { await cleanup(downloaded.tempDir); } catch { /* scavenger retries */ }
        }
      }
    }
  };
}

async function runStage(code,operation) {
  try { return await operation(); }
  catch (error) { throw sanitizedFailure(error,code); }
}

function sanitizedFailure(error,fallbackCode) {
  const code=FAILURE_CODES.has(error?.code)?error.code:fallbackCode;
  const failure=new Error("knowledge_stage_failed");
  failure.code=code;
  if (Number.isSafeInteger(error?.stderrBytes)&&error.stderrBytes>=0) {
    failure.stderrBytes=error.stderrBytes;
  }
  if (Number.isSafeInteger(error?.retryCount)&&
      error.retryCount>=0&&error.retryCount<=1) {
    failure.retryCount=error.retryCount;
  }
  return failure;
}

function reportFailure(onFailureStage,error,fallbackCode) {
  const failure=sanitizedFailure(error,fallbackCode);
  const details={code:failure.code};
  if (failure.stderrBytes!==undefined) details.stderrBytes=failure.stderrBytes;
  if (failure.retryCount!==undefined) details.retryCount=failure.retryCount;
  try { onFailureStage(details); } catch { /* diagnostics never change replies */ }
  return formatKnowledgeFailure();
}

function validKnowledgeFileMessage(message) {
  if (!message||typeof message!=="object"||Array.isArray(message)||
      !Array.isArray(message.attachments)||message.attachments.length!==1||
      typeof message.receivedAt!=="string"||
      !Number.isFinite(Date.parse(message.receivedAt))) {
    return false;
  }
  const attachment=message.attachments[0];
  return Boolean(
    attachment&&attachment.type==="file"&&
    new Set(["txt","md","docx","pptx","xlsx"]).has(attachment.extension)&&
    typeof attachment.displayName==="string"&&attachment.displayName
  );
}

function defaultCleanup(tempDir) {
  return rm(tempDir,{recursive:true,force:true});
}

function validDirectTextMessage(message) {
  return Boolean(
    message&&typeof message==="object"&&!Array.isArray(message)&&
    typeof message.text==="string"&&message.text.trim()&&
    [...message.text.trim()].length<=12_000&&
    Array.isArray(message.attachments)&&message.attachments.length===0&&
    typeof message.receivedAt==="string"&&
    Number.isFinite(Date.parse(message.receivedAt))
  );
}

function feishuDocumentRequest(message) {
  if (!validDirectTextMessage(message)) return null;
  const urls=[...message.text.matchAll(/https:\/\/[^\s<>()]+/gu)]
    .map(match=>match[0]);
  if (urls.length!==1) return null;
  try {
    const url=new URL(urls[0]);
    const host=url.hostname.toLowerCase();
    if (!(host==="feishu.cn"||host.endsWith(".feishu.cn")||
          host==="larksuite.com"||host.endsWith(".larksuite.com"))||
        !/^\/(?:docx?|sheets|slides|wiki|base|bitable)\/[A-Za-z0-9_-]+\/?$/u
          .test(url.pathname)) {
      return null;
    }
    return {
      url:urls[0],
      safeRequest:message.text.replace(urls[0],"[飞书文档快照]").trim()
    };
  } catch {
    return null;
  }
}
