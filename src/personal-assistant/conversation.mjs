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
      (decision.preparedTool!==null&&decision.preparedTool!==undefined&&
        !/^[a-z][a-z0-9_]{0,63}$/u.test(decision.preparedTool))) {
    throw new Error("conversation_invalid");
  }
  const next={feishu:clone(state.feishu),wechat:clone(state.wechat)};
  next[source]={
    waitingType:decision.waitingType,
    question:decision.question,
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
  if (!value||!canonicalIso(value.updatedAt)||
      Date.parse(now)-Date.parse(value.updatedAt)>TTL_MS) return null;
  return clone(value);
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
