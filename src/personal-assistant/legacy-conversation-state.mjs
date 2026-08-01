import {
  isPreparedSourceSetId
} from "../core/opaque-identifier.mjs";

const WAITING=new Set([
  "waiting_answer","waiting_file","waiting_confirmation"
]);

export function validateLegacyAssistantConversation(value) {
  const fields=new Set([
    "waitingType","question","instructionText","preparedTool","confirmed",
    "turns","model","startedAt","updatedAt"
  ]);
  const allowed=new Set([...fields,"preparedSourceSetId"]);
  if (!value||typeof value!=="object"||Array.isArray(value)||
      !new Set([fields.size,fields.size+1]).has(Object.keys(value).length)||
      Object.keys(value).some(key=>!allowed.has(key))||
      (Object.hasOwn(value,"preparedSourceSetId")&&
        !isPreparedSourceSetId(value.preparedSourceSetId))||
      !WAITING.has(value.waitingType)||
      !safeText(value.question,1000)||
      typeof value.instructionText!=="string"||
      Buffer.byteLength(value.instructionText,"utf8")>32_768||
      (value.preparedTool!==null&&
        !/^[a-z][a-z0-9_]{0,63}$/u.test(value.preparedTool))||
      !plainConfirmed(value.confirmed)||
      !Array.isArray(value.turns)||value.turns.length>8||
      value.turns.some(turn=>!turn||typeof turn!=="object"||
        !new Set(["user","assistant"]).has(turn.role)||
        !safeText(turn.text,4000))||
      !new Set(["codex","deepseek"]).has(value.model)||
      !canonicalIso(value.startedAt)||!canonicalIso(value.updatedAt)||
      Date.parse(value.updatedAt)<Date.parse(value.startedAt)) {
    throw new Error("legacy_conversation_state_invalid");
  }
  return structuredClone(value);
}

function safeText(value,max) {
  return typeof value==="string"&&value.trim()&&
    Buffer.byteLength(value,"utf8")<=max;
}

function canonicalIso(value) {
  return typeof value==="string"&&Number.isFinite(Date.parse(value))&&
    new Date(value).toISOString()===value;
}

function plainConfirmed(value) {
  if (!value||typeof value!=="object"||Array.isArray(value)||
      Object.keys(value).length>16) return false;
  return Object.entries(value).every(([key,item])=>
    /^[a-z][a-zA-Z0-9_]{0,63}$/u.test(key)&&
    typeof item==="string"&&Buffer.byteLength(item,"utf8")<=1000
  );
}
