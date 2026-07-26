import {validateAssistantWorkDecision} from "./decision-validator.mjs";

const DEEPSEEK_REPLY=[
  "当前助手工作能力仅支持 Codex。",
  "系统没有自动切换模型，也没有创建或修改任务工作稿。",
  "如需继续，请先发送：/llw-model codex"
].join("\n");
const FAILURE_REPLY="助手工作本次处理失败，未写入长期知识库，也未生成或发送文件；请重试。";

export function createAssistantWorkCapability({
  decide,search,workspace,sessionManager,allowedOutputFormats=[]
}) {
  if (typeof decide!=="function"||typeof search!=="function"||!workspace||
      !sessionManager||!Array.isArray(allowedOutputFormats)) {
    throw new Error("invalid_assistant_work_capability");
  }
  return {
    name:"assistant-work",
    async handle(message,{model}) {
      try {
        validateMessage(message);
        let session=sessionManager.getOpen();
        if (!session&&model!=="codex") {
          return {status:"rejected",reply:DEEPSEEK_REPLY,artifacts:[]};
        }
        const effectiveModel=session?.model||model;
        if (effectiveModel!=="codex") {
          return {status:"rejected",reply:DEEPSEEK_REPLY,artifacts:[]};
        }
        const groundingMode=session?.grounding_mode||selectGroundingMode(message.text);
        const sources=await search({
          query:message.text,sourcePaths:session?.source_paths||[]
        });
        validateSources(sources);
        if (!session) {
          session=await sessionManager.create({
            goal:boundedBytes(message.text,1000),model:effectiveModel,groundingMode,
            sourcePaths:sources.map(item=>item.path),startedAt:message.receivedAt
          });
        }
        const working=await loadWorkingDraft(workspace,session);
        const baseVersion=requestedBaseVersion(
          message.text,working.currentDraftVersion
        );
        const decision=validateAssistantWorkDecision(await decide({
          message:{text:message.text,received_at:message.receivedAt},
          session:publicSession(session),
          currentDraft:working.currentDraftVersion===0?null:{
            version:working.currentDraftVersion,text:working.currentDraft
          },
          baseVersion,
          sources:sources.map(item=>({
            path:item.path,excerpt:item.excerpt,score:item.score
          })),
          allowedOutputFormats:[...allowedOutputFormats],
          verifiedArtifact:null,entrySupportsFileReply:false,model:effectiveModel
        }),{
          verifiedSourcePaths:sources.map(item=>item.path),
          groundingMode:session.grounding_mode,
          allowedOutputFormats,verifiedArtifact:null
        });
        return applyDecision({
          decision,message,session,working,workspace,sessionManager
        });
      } catch {
        return {status:"failed",reply:FAILURE_REPLY,artifacts:[]};
      }
    }
  };
}

async function applyDecision({
  decision,message,session,working,workspace,sessionManager
}) {
  let draftVersion=working.currentDraftVersion;
  const artifacts=[];
  if (new Set(["create_draft","revise_draft"]).has(decision.action)) {
    if (decision.action==="create_draft"&&working.currentDraftVersion!==0) {
      throw new Error("invalid_draft_action");
    }
    if (decision.action==="revise_draft"&&working.currentDraftVersion===0) {
      throw new Error("invalid_draft_action");
    }
    const saved=await workspace.saveDraft({
      sessionId:session.session_id,baseVersion:working.currentDraftVersion,
      text:decision.reply,sourcePaths:decision.source_paths,
      updatedAt:message.receivedAt
    });
    draftVersion=saved.version;
    artifacts.push(
      `task-session/${session.session_id}/draft-v${draftVersion}.md`
    );
  }
  if (decision.action==="reply_file") throw new Error("file_output_not_enabled");
  if (decision.action==="complete") {
    await sessionManager.close("completed",message.receivedAt);
    artifacts.push(`task-session/${session.session_id}/session.json`);
    return {status:"committed",reply:decision.reply,artifacts};
  }
  if (decision.action==="cancel") {
    await sessionManager.close("cancelled",message.receivedAt);
    artifacts.push(`task-session/${session.session_id}/session.json`);
    return {status:"committed",reply:decision.reply,artifacts};
  }
  const sourcePaths=decision.action==="ask_user"
    ?session.source_paths:decision.source_paths;
  await sessionManager.update({
    session,userText:message.text,
    assistantText:decision.question||decision.reply,
    sourcePaths,draftVersion,updatedAt:message.receivedAt
  });
  if (decision.action==="ask_user") {
    return {
      status:"awaiting_clarification",reply:decision.question,artifacts:[]
    };
  }
  if (decision.action!=="not_found"&&!artifacts.length) {
    artifacts.push(`task-session/${session.session_id}/session.json`);
  }
  return {
    status:decision.action==="not_found"?"rejected":"committed",
    reply:decision.reply,artifacts
  };
}

async function loadWorkingDraft(workspace,session) {
  const working=await workspace.load(session.session_id);
  if (working.currentDraftVersion!==session.current_draft_version) {
    throw new Error("draft_state_mismatch");
  }
  return working;
}

function publicSession(session) {
  return {
    session_id:session.session_id,goal:session.goal,
    task_summary:session.task_summary,
    confirmed_requirements:[...session.confirmed_requirements],
    rejected_directions:[...session.rejected_directions],
    source_paths:[...session.source_paths],
    current_draft_version:session.current_draft_version,
    recent_turns:structuredClone(session.recent_turns),
    grounding_mode:session.grounding_mode,model:session.model
  };
}

function validateSources(value) {
  if (!Array.isArray(value)||value.length>20||
      new Set(value.map(item=>item?.path)).size!==value.length) {
    throw new Error("invalid_sources");
  }
  for (const item of value) {
    if (!item||typeof item!=="object"||Array.isArray(item)||
        Object.keys(item).length!==3||
        !new Set(["path","excerpt","score"]).isSupersetOf(
          new Set(Object.keys(item))
        )||
        typeof item.path!=="string"||!item.path||
        typeof item.excerpt!=="string"||!item.excerpt.trim()||
        !Number.isInteger(item.score)||item.score<1) {
      throw new Error("invalid_sources");
    }
  }
}

function selectGroundingMode(text) {
  if (/(?:纯创意|头脑风暴|发散|虚构|脑暴)/u.test(text)) return "creative";
  if (/(?:只能根据|严格根据|根据.*资料|查(?:一下|找)|总结.*(?:资料|材料)|精确)/u
    .test(text)) return "source_strict";
  return "hybrid";
}

function requestedBaseVersion(text,current) {
  const match=text.match(/(?:\bv|版本)\s*(\d{1,6})\b/iu);
  return match?Number(match[1]):current;
}

function validateMessage(message) {
  if (!message||typeof message!=="object"||Array.isArray(message)||
      typeof message.text!=="string"||!message.text.trim()||
      [...message.text].length>12_000||
      !Array.isArray(message.attachments)||message.attachments.length!==0||
      typeof message.receivedAt!=="string"||
      !Number.isFinite(Date.parse(message.receivedAt))||
      new Date(message.receivedAt).toISOString()!==message.receivedAt) {
    throw new Error("invalid_message");
  }
}

function boundedBytes(value,maxBytes) {
  const characters=[...value.trim()];
  while (characters.length&&
      Buffer.byteLength(characters.join(""),"utf8")>maxBytes) {
    characters.pop();
  }
  return characters.join("");
}
