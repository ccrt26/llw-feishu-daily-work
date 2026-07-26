import {validateKnowledgeDecision} from "./decision-validator.mjs";
import {
  formatKnowledgeCodexOnly,formatKnowledgeCommit,formatKnowledgeFailure,
  formatKnowledgeFolder,formatKnowledgePending,formatKnowledgeQuestion,
  formatKnowledgeReject
} from "./receipt.mjs";

export function createKnowledgeIngestCapability({
  decide,writer,catalog,sourcePreparer,skillVersion
}) {
  return {
    name:"knowledge-ingest",
    async handle(message,{state,model="codex"}={}) {
      if (model!=="codex") return formatKnowledgeCodexOnly();
      if (!validDirectTextMessage(message)) return formatKnowledgeReject("unsupported_format");
      try {
        const request=message.text.trim();
        const [source,libraries]=await Promise.all([
          sourcePreparer({text:request}),
          catalog()
        ]);
        const raw=await decide({
          model:"codex",request,source,sourceContent:request,
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
            source:{...source,content:request},
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
          if (decision.reason_code==="source_incomplete") {
            await state.setKnowledgePending({
              request,
              startedAt:message.receivedAt,
              model:"codex"
            });
            return formatKnowledgePending();
          }
          return formatKnowledgeQuestion(decision,library,libraries);
        }
        await state.clearKnowledgePending();
        return formatKnowledgeReject(decision.reason_code);
      } catch {
        return formatKnowledgeFailure();
      }
    }
  };
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
