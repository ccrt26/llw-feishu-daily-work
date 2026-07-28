import {projectSourceForModel} from "./source-handle.mjs";

const PRIORITY=Object.freeze([
  "program_safety",
  "current_instruction",
  "confirmed_personal_rules",
  "source_facts",
  "weak_metadata"
]);

export function buildAgentTurnContext({
  message,sources,conversation,personalRules,model,toolDeclarations,
  dailyCandidates=[]
}) {
  if (!message||typeof message.instructionText!=="string"||
      !canonicalIso(message.receivedAt)||
      !Array.isArray(sources)||sources.length>8||
      !Array.isArray(personalRules)||personalRules.length>64||
      personalRules.some(rule=>typeof rule!=="string"||
        Buffer.byteLength(rule,"utf8")>1000)||
      !new Set(["codex","deepseek"]).has(model)||
      !Array.isArray(toolDeclarations)||
      !Array.isArray(dailyCandidates)||dailyCandidates.length>20) {
    throw new Error("agent_turn_context_invalid");
  }
  let safeSources;
  try {
    safeSources=sources.map(projectSourceForModel);
    if (new Set(safeSources.map(source=>source.sourceId)).size!==
        safeSources.length) {
      throw new Error("duplicate_source");
    }
  } catch {
    throw new Error("agent_turn_context_invalid");
  }
  return Object.freeze({
    instructionText:message.instructionText,
    entry:message.source,
    currentTime:message.receivedAt,
    sources:Object.freeze(safeSources.map(source=>Object.freeze(source))),
    conversation:conversation===null?null:structuredClone(conversation),
    confirmedPersonalRules:[...personalRules],
    model,
    tools:toolDeclarations.map(item=>({
      name:item.name,
      description:item.description,
      parameters:item.parameters
    })),
    dailyCandidates:structuredClone(dailyCandidates),
    priority:PRIORITY
  });
}

function canonicalIso(value) {
  return typeof value==="string"&&Number.isFinite(Date.parse(value))&&
    new Date(value).toISOString()===value;
}
