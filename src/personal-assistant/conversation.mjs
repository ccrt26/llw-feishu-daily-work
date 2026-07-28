const WAITING=new Set(["waiting_answer","waiting_file","waiting_confirmation"]);
const TTL_MS=24*60*60*1000;

export function applyConversationDecision({
  state,source,now,decision
}) {
  validateState(state);
  if (!new Set(["feishu","wechat"]).has(source)||
      !canonicalIso(now)||!decision||decision.kind!=="ask"||
      !WAITING.has(decision.waitingType)||
      !safeText(decision.question,1000)||
      (decision.instructionText!==undefined&&
        (typeof decision.instructionText!=="string"||
          Buffer.byteLength(decision.instructionText,"utf8")>32_768))||
      (decision.preparedTool!==null&&decision.preparedTool!==undefined&&
        !/^[a-z][a-z0-9_]{0,63}$/u.test(decision.preparedTool))) {
    throw new Error("conversation_invalid");
  }
  const next={feishu:clone(state.feishu),wechat:clone(state.wechat)};
  next[source]={
    waitingType:decision.waitingType,
    question:decision.question,
    instructionText:decision.instructionText??"",
    preparedTool:decision.preparedTool??null,
    confirmed:{},
    turns:[],
    model:decision.model??"codex",
    startedAt:now,
    updatedAt:now
  };
  return next;
}

export function getActiveConversation(state,source,now) {
  validateState(state);
  if (!new Set(["feishu","wechat"]).has(source)||!canonicalIso(now)) {
    throw new Error("conversation_invalid");
  }
  const value=state[source];
  if (value) validateAssistantConversation(value);
  if (!value||!canonicalIso(value.updatedAt)||
      Date.parse(now)-Date.parse(value.updatedAt)>TTL_MS) return null;
  return clone(value);
}

export function validateAssistantConversation(value) {
  const fields=new Set([
    "waitingType","question","instructionText","preparedTool","confirmed",
    "turns","model","startedAt","updatedAt"
  ]);
  if (!value||typeof value!=="object"||Array.isArray(value)||
      Object.keys(value).length!==fields.size||
      Object.keys(value).some(key=>!fields.has(key))||
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
    throw new Error("conversation_invalid");
  }
  return structuredClone(value);
}

export function clearConversation(state,source) {
  validateState(state);
  if (!new Set(["feishu","wechat"]).has(source)) {
    throw new Error("conversation_invalid");
  }
  return {
    feishu:source==="feishu"?null:clone(state.feishu),
    wechat:source==="wechat"?null:clone(state.wechat)
  };
}

export function isConversationCancellation(value) {
  return typeof value==="string"&&
    /^(?:不用了[，,。\s]*)?(?:取消|算了|不用了)[。！!\s]*$/u
      .test(value.trim());
}

function validateState(state) {
  if (!state||typeof state!=="object"||Array.isArray(state)||
      Object.keys(state).some(key=>!new Set(["feishu","wechat"]).has(key))) {
    throw new Error("conversation_invalid");
  }
}
function safeText(value,max) {
  return typeof value==="string"&&value.trim()&&Buffer.byteLength(value,"utf8")<=max;
}
function canonicalIso(value) {
  return typeof value==="string"&&Number.isFinite(Date.parse(value))&&
    new Date(value).toISOString()===value;
}
function clone(value) {
  return value===null||value===undefined?null:structuredClone(value);
}
function plainConfirmed(value) {
  if (!value||typeof value!=="object"||Array.isArray(value)||
      Object.keys(value).length>16) return false;
  return Object.entries(value).every(([key,item])=>
    /^[a-z][a-zA-Z0-9_]{0,63}$/u.test(key)&&
    typeof item==="string"&&Buffer.byteLength(item,"utf8")<=1000
  );
}
