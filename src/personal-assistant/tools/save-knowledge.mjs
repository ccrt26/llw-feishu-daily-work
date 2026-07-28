import {validateToolCall} from "../tool-definitions.mjs";

export async function executeSaveKnowledge({
  toolCall,preparedSource,writer,skillVersion,ingestedAt
}) {
  const call=validateToolCall(toolCall);
  if (call.name!=="save_knowledge") throw new Error("tool_call_invalid");
  if (!completeSource(preparedSource)) {
    return {
      status:"rejected",
      reply:"这份文件有尚未完整读取的内容，本次没有保存。请改发完整 PDF，或处理文件中的复杂图片、图表、批注等内容后重试。",
      artifacts:[]
    };
  }
  const args=call.arguments;
  try {
    const result=await writer.commit({
      libraryKey:args.libraryKey,
      folderSegments:[...args.folderSegments],
      title:args.title,
      summary:args.summary,
      tags:[...args.tags],
      knowledgeSections:structuredClone(args.knowledgeSections),
      source:clonePreparedSource(preparedSource),
      skillVersion,
      ingestedAt
    });
    if (!result||!new Set(["created","existing"]).has(result.status)||
        !safeRelative(result.relativePath)||
        !Array.isArray(result.files)||
        result.files.length<1||
        result.files.some(file=>!safeRelative(file))) {
      throw new Error("writer_result_invalid");
    }
    return {
      status:result.status==="created"?"committed":"existing",
      reply:result.status==="created"
        ?`知识资料已保存。\n位置：${result.relativePath}`
        :`这份知识资料已经保存过，没有重复写入。\n位置：${result.relativePath}`,
      artifacts:[...result.files]
    };
  } catch {
    return {
      status:"failed",
      reply:"内容已理解，但本次保存失败；你不需要重新解释内容。",
      artifacts:[]
    };
  }
}

function completeSource(value) {
  return value&&typeof value==="object"&&!Array.isArray(value)&&
    value.extractionIntegrity==="complete"&&
    Array.isArray(value.extractionLimitations)&&
    value.extractionLimitations.length===0&&
    typeof value.content==="string"&&value.content.trim()&&
    /^[a-f0-9]{64}$/u.test(value.sha256);
}

function clonePreparedSource(value) {
  const clone={...value};
  if (Buffer.isBuffer(value.sourceBytes)) {
    clone.sourceBytes=Buffer.from(value.sourceBytes);
  }
  return clone;
}

function safeRelative(value) {
  return typeof value==="string"&&value.length>0&&!value.startsWith("/")&&
    !value.startsWith("~")&&!value.includes("\\")&&
    value.split("/").every(segment=>segment&&segment!=="."&&segment!=="..");
}
