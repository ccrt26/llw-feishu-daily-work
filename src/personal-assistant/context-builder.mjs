const PRIORITY=Object.freeze([
  "program_safety",
  "current_instruction",
  "confirmed_personal_rules",
  "source_facts",
  "weak_metadata"
]);

export function buildAgentTurnContext({
  message,evidence,conversation,personalRules,model,toolDeclarations,
  dailyCandidates=[]
}) {
  if (!message||typeof message.instructionText!=="string"||
      !canonicalIso(message.receivedAt)||
      !Array.isArray(personalRules)||personalRules.length>64||
      personalRules.some(rule=>typeof rule!=="string"||
        Buffer.byteLength(rule,"utf8")>1000)||
      !new Set(["codex","deepseek"]).has(model)||
      !Array.isArray(toolDeclarations)||
      !Array.isArray(dailyCandidates)||dailyCandidates.length>20) {
    throw new Error("agent_turn_context_invalid");
  }
  return Object.freeze({
    instructionText:message.instructionText,
    entry:message.source,
    currentTime:message.receivedAt,
    sourceEvidence:evidence===null?null:structuredClone(evidence),
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
