const FIELDS=new Set(["action","capability","confidence","reason_code","question","reason"]);

export function validateIntentDecision(value,enabledNames,{hasConversation=false,conversationCapability=null}={}) {
  fail(!value || typeof value!=="object" || Array.isArray(value));
  fail(Object.keys(value).length!==FIELDS.size || Object.keys(value).some(key=>!FIELDS.has(key)));
  for (const field of FIELDS) fail(typeof value[field]!=="string");
  const enabled=new Set(enabledNames);
  if (value.action==="route") {
    fail(!enabled.has(value.capability) || value.confidence!=="high" || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(value.reason_code));
    fail(value.question!=="" || value.reason!=="");
    const changedCapability=hasConversation&&typeof conversationCapability==="string"&&conversationCapability&&value.capability!==conversationCapability;
    return {action:"route",capability:value.capability,confidence:"high",reasonCode:changedCapability?"new_task":value.reason_code};
  }
  if (value.action==="clarify") {
    fail(value.capability!=="" || value.confidence!=="" || value.reason_code!=="" || value.reason!=="");
    fail(!value.question.trim() || [...value.question].length>200);
    return {action:"clarify",question:value.question.trim()};
  }
  if (value.action==="unsupported") {
    fail(value.capability!=="" || value.confidence!=="" || value.reason_code!=="" || value.question!=="");
    fail(!value.reason.trim() || [...value.reason].length>200);
    const reason=value.reason.trim();
    return {action:"unsupported",reason:reason==="cancelled"&&!hasConversation?"当前没有待取消任务。":reason};
  }
  fail(true);
}

function fail(condition) { if (condition) throw new Error("invalid_intent_decision"); }
