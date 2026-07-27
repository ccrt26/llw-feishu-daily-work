import {validateToolCall} from "../tool-definitions.mjs";

export async function executeCreateDocument({
  toolCall,sessionId,draftVersion,workspace,generate
}) {
  const call=validateToolCall(toolCall);
  if (call.name!=="create_document") throw new Error("tool_call_invalid");
  const {format,title,content}=call.arguments;
  if (!safeTitle(title)) throw new Error("tool_call_invalid");
  const displayName=`${title}.${format}`;
  try {
    const artifact=await workspace.generate({
      sessionId,draftVersion,kind:format,displayName,
      draftText:content,generate
    });
    if (!verifiedArtifact(artifact,format,displayName)) {
      throw new Error("artifact_invalid");
    }
    return {
      status:"committed",
      reply:`${displayName} 已生成并通过本地校验。`,
      replyFile:{
        ...structuredClone(artifact),
        idempotencyKey:`assistant-file:${sessionId}:${draftVersion}`
      },
      artifacts:[]
    };
  } catch {
    return {
      status:"failed",
      reply:"内容已理解，但本次文件生成失败；你不需要重新解释内容。",
      artifacts:[]
    };
  }
}

function safeTitle(value) {
  return typeof value==="string"&&value===value.trim()&&value.length>0&&
    !/[\\/\u0000-\u001f\u007f]/u.test(value)&&
    value!=="."&&value!==".."&&!value.startsWith(".");
}

function verifiedArtifact(value,kind,displayName) {
  return value&&value.kind===kind&&value.displayName===displayName&&
    typeof value.path==="string"&&value.path.startsWith("/")&&
    /^[a-f0-9]{64}$/u.test(value.sha256)&&
    Number.isSafeInteger(value.size)&&value.size>0;
}
