import {rm} from "node:fs/promises";
import {validateKnowledgeDecision} from "./decision-validator.mjs";
import {
  formatKnowledgeAttachmentNeedsRequest,formatKnowledgeCodexOnly,
  formatKnowledgeCommit,formatKnowledgeFailure,
  formatKnowledgeFolder,formatKnowledgePending,formatKnowledgeQuestion,
  formatKnowledgeReject
} from "./receipt.mjs";

export function createKnowledgeIngestCapability({
  decide,writer,catalog,sourcePreparer,filePreparer,download,
  cleanup=defaultCleanup,skillVersion
}) {
  async function processPrepared({request,source,content,libraries,state,startedAt,allowPending}) {
    const raw=await decide({
      model:"codex",request,source,sourceContent:content,
      allowedLibraries:libraries,taskSummary:null
    });
    const decision=validateKnowledgeDecision(raw,{libraries});
    const library=libraries.find(item=>item.libraryKey===decision.library_key);
    if (decision.action==="commit") {
      const result=await writer.commit({
        libraryKey:decision.library_key,
        folderSegments:[...decision.folder_plan.segments],
        title:decision.title,
        summary:decision.summary,
        tags:[...decision.tags],
        source:{...source,content},
        skillVersion,
        preserveSource:decision.preserve_source
      });
      await state.clearKnowledgePending();
      return formatKnowledgeCommit(decision,result,library);
    }
    if (decision.action==="create_folder") {
      const result=await writer.createFolder({
        libraryKey:decision.library_key,
        segments:[...decision.folder_plan.segments]
      });
      await state.clearKnowledgePending();
      return formatKnowledgeFolder(result,library);
    }
    if (decision.action==="ask_user") {
      if (decision.reason_code==="source_incomplete"&&allowPending) {
        await state.setKnowledgePending({
          request,
          startedAt,
          model:"codex"
        });
        return formatKnowledgePending();
      }
      return formatKnowledgeQuestion(decision,library,libraries);
    }
    await state.clearKnowledgePending();
    return formatKnowledgeReject(decision.reason_code);
  }

  return {
    name:"knowledge-ingest",
    async handle(message,{state,model="codex"}={}) {
      if (model!=="codex") return formatKnowledgeCodexOnly();
      if (validDirectTextMessage(message)) {
        try {
          const request=message.text.trim();
          const [source,libraries]=await Promise.all([
            sourcePreparer({text:request}),
            catalog()
          ]);
          return await processPrepared({
            request,source,content:request,libraries,state,
            startedAt:message.receivedAt,allowPending:true
          });
        } catch {
          return formatKnowledgeFailure();
        }
      }
      if (!validKnowledgeFileMessage(message)) {
        return formatKnowledgeReject("unsupported_format");
      }
      let downloaded;
      try {
        const nowMs=Date.parse(message.receivedAt);
        const pending=await state.getKnowledgePending(nowMs);
        if (!pending) return formatKnowledgeAttachmentNeedsRequest();
        const attachment=message.attachments[0];
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
        const {content,...source}=preparedFile;
        const libraries=await catalog();
        return await processPrepared({
          request:pending.request,source,content,libraries,state,
          startedAt:pending.startedAt,allowPending:false
        });
      } catch {
        return formatKnowledgeFailure();
      } finally {
        if (downloaded?.tempDir) {
          try { await cleanup(downloaded.tempDir); } catch { /* scavenger retries */ }
        }
      }
    }
  };
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
    new Set(["txt","md"]).has(attachment.extension)&&
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
