import {createHash} from "node:crypto";
import {validateToolCall} from "../tool-definitions.mjs";
import {createSourceHandle} from "../source-handle.mjs";
import {
  resolveKnowledgeEvidence
} from "../knowledge-evidence-resolver.mjs";

export async function executeSaveKnowledge({
  toolCall,sourceBindings,workspaceDir,instructionText,writer,
  skillVersion,ingestedAt,resolveEvidence=resolveKnowledgeEvidence
}) {
  const call=validateToolCall(toolCall);
  if (call.name!=="save_knowledge") throw new Error("tool_call_invalid");
  const bindings=validateBindings(sourceBindings);
  if (typeof instructionText!=="string"||typeof writer?.commit!=="function") {
    throw new Error("tool_call_invalid");
  }
  const selected=[];
  for (const sourceId of call.arguments.sourceIds) {
    const binding=bindings.get(sourceId);
    if (!binding) {
      return {
        status:"rejected",
        reply:"本次保存引用了不属于当前任务的文件，系统没有写入。请重新选择当前文件。",
        artifacts:[]
      };
    }
    selected.push({
      sourceId,
      displayName:binding.handle.displayName,
      format:binding.handle.format,
      absolutePath:binding.absolutePath,
      byteSize:binding.handle.byteSize,
      sha256:binding.handle.sha256
    });
  }
  const sourceSetDigest=createHash("sha256")
    .update(selected.length
      ?selected.map(source=>
        `${source.sourceId}\0${source.sha256}`
      ).join("\0")
      :`text\0${instructionText}`)
    .digest("hex");
  const args=call.arguments;
  let evidenceInput=null;
  if (Object.hasOwn(args,"evidenceSourceIds")) {
    try {
      evidenceInput=await resolveEvidence({
        workspaceDir,sourceBindings,
        evidenceSourceIds:args.evidenceSourceIds,
        sourceIds:args.sourceIds
      });
    } catch {
      return {
        status:"rejected",
        reply:"本次视频证据不完整或已变化，系统没有写入。请重新处理当前视频后再保存。",
        artifacts:[]
      };
    }
  }
  try {
    const result=await writer.commit({
      libraryKey:args.libraryKey,
      folderSegments:[...args.folderSegments],
      title:args.title,
      summary:args.summary,
      tags:[...args.tags],
      knowledgeSections:structuredClone(args.knowledgeSections),
      sources:selected,
      ...(evidenceInput===null
        ?{sourceSetDigest}
        :{
          evidenceSources:structuredClone(evidenceInput.evidenceSources),
          sourceSetDigest:evidenceInput.sourceSetDigest
        }),
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
      artifacts:[],
      failureCode:"knowledge_writer_failed"
    };
  }
}

function validateBindings(sourceBindings) {
  if (!Array.isArray(sourceBindings)||sourceBindings.length>8) {
    throw new Error("tool_call_invalid");
  }
  const bindings=new Map();
  for (const binding of sourceBindings) {
    if (!binding||typeof binding!=="object"||
        typeof binding.absolutePath!=="string"||!binding.absolutePath) {
      throw new Error("tool_call_invalid");
    }
    const handle=createSourceHandle(binding.handle??binding);
    if (bindings.has(handle.sourceId)) throw new Error("tool_call_invalid");
    bindings.set(handle.sourceId,{...binding,handle});
  }
  return bindings;
}

function safeRelative(value) {
  return typeof value==="string"&&value.length>0&&!value.startsWith("/")&&
    !value.startsWith("~")&&!value.includes("\\")&&
    value.split("/").every(segment=>segment&&segment!=="."&&segment!=="..");
}
