const TASK_ID=/^[A-Za-z0-9_-]{43}$/u;
const SOURCES=new Set(["feishu","wechat"]);
const MODELS=new Set(["codex","deepseek"]);
const STATUSES=new Set(["active","paused"]);
const WAITING_TYPES=new Set([
  "waiting_answer","waiting_file","waiting_confirmation"
]);
const TTL_MS=24*60*60*1000;
const MAX_SESSION_BYTES=128*1024;
const SESSION_FIELDS=new Set([
  "version","taskId","source","status","revision","resolvedRevision",
  "model","goal","workingSummary","confirmedRequirements",
  "rejectedDirections","recentTurns","sourceIds","pendingInputs",
  "waiting","writerCheckpoint","startedAt","updatedAt","expiresAt"
]);

export function createTaskSession({message,model,taskId,now}) {
  validateMessage(message);
  if (!MODELS.has(model)||!TASK_ID.test(taskId||"")||
      !canonicalIso(now)||message.receivedAt!==now) {
    throw new Error("task_session_invalid");
  }
  return freezeSession({
    version:1,
    taskId,
    source:message.source,
    status:"active",
    revision:1,
    resolvedRevision:0,
    model,
    goal:message.instructionText.trim()||"处理已提供的来源",
    workingSummary:"",
    confirmedRequirements:[],
    rejectedDirections:[],
    recentTurns:[],
    sourceIds:[],
    pendingInputs:[projectPendingInput(message,1)],
    waiting:null,
    writerCheckpoint:null,
    startedAt:now,
    updatedAt:now,
    expiresAt:expiresAt(now)
  });
}

export function appendTaskInput({session,message,now}) {
  const current=validateTaskSession(session);
  validateMessage(message);
  if (current.status!=="active"||message.source!==current.source||
      !canonicalIso(now)||message.receivedAt!==now||
      Date.parse(now)<Date.parse(current.updatedAt)) {
    throw new Error("task_session_invalid");
  }
  const revision=current.revision+1;
  return freezeSession({
    ...current,
    revision,
    pendingInputs:[
      ...current.pendingInputs,
      projectPendingInput(message,revision)
    ],
    updatedAt:now,
    expiresAt:expiresAt(now)
  });
}

export function resolveTaskStage({
  session,throughRevision,userText,assistantText,waiting=null,
  taskUpdate=null,now
}) {
  const current=validateTaskSession(session);
  const update=taskUpdate===null
    ?{
      workingSummary:deterministicSummary(
        current.goal,userText,assistantText
      ),
      confirmedRequirements:current.confirmedRequirements,
      rejectedDirections:current.rejectedDirections
    }
    :validateTaskUpdate(taskUpdate);
  if (current.status!=="active"||
      !Number.isSafeInteger(throughRevision)||
      throughRevision<=current.resolvedRevision||
      throughRevision>current.revision||
      !safeText(userText,32_000)||
      !safeText(assistantText,32_000)||
      !canonicalIso(now)||
      Date.parse(now)<Date.parse(current.updatedAt)) {
    throw new Error("task_session_invalid");
  }
  validateWaiting(waiting);
  return freezeSession({
    ...current,
    resolvedRevision:throughRevision,
    workingSummary:update.workingSummary,
    confirmedRequirements:update.confirmedRequirements,
    rejectedDirections:update.rejectedDirections,
    recentTurns:[
      ...current.recentTurns,
      {role:"user",text:userText},
      {role:"assistant",text:assistantText}
    ].slice(-12),
    pendingInputs:current.pendingInputs.filter(
      input=>input.revision>throughRevision
    ),
    waiting:waiting===null?null:structuredClone(waiting),
    writerCheckpoint:null,
    updatedAt:now,
    expiresAt:expiresAt(now)
  });
}

export function pauseTaskSession({session,now}) {
  const current=validateTaskSession(session);
  if (current.status!=="active"||!forwardTime(current,now)) {
    throw new Error("task_session_invalid");
  }
  return freezeSession({
    ...current,status:"paused",updatedAt:now,expiresAt:expiresAt(now)
  });
}

export function resumeTaskSession({session,now}) {
  const current=validateTaskSession(session);
  if (current.status!=="paused"||!forwardTime(current,now)) {
    throw new Error("task_session_invalid");
  }
  return freezeSession({
    ...current,status:"active",updatedAt:now,expiresAt:expiresAt(now)
  });
}

export function classifyTaskControl({instructionText,hasAttachments}) {
  if (typeof instructionText!=="string"||
      typeof hasAttachments!=="boolean"||hasAttachments) return null;
  const text=instructionText.trim();
  if (/^(?:取消|算了|不用了|取消当前任务)[。！!\s]*$/u.test(text)) {
    return {kind:"cancel"};
  }
  if (/^(?:暂停|先暂停|暂停当前任务)[。！!\s]*$/u.test(text)) {
    return {kind:"pause"};
  }
  if (/^(?:结束|结束任务|结束当前任务|这个任务结束)[。！!\s]*$/u
    .test(text)) {
    return {kind:"end"};
  }
  if (/^(?:继续|继续刚才的|继续当前任务)[。！!\s]*$/u.test(text)) {
    return {kind:"resume"};
  }
  const match=/^开始新任务(?:[：:]\s*(.*))?$/u.exec(text);
  if (match) {
    return {
      kind:"new_task",
      instructionText:(match[1]||"").trim()
    };
  }
  return null;
}

export function publicTaskContext(session) {
  const value=validateTaskSession(session);
  return Object.freeze({
    taskId:value.taskId,
    status:value.status,
    revision:value.revision,
    goal:value.goal,
    workingSummary:value.workingSummary,
    confirmedRequirements:[...value.confirmedRequirements],
    rejectedDirections:[...value.rejectedDirections],
    recentTurns:structuredClone(value.recentTurns),
    sourceIds:[...value.sourceIds],
    waiting:value.waiting===null?null:structuredClone(value.waiting),
    startedAt:value.startedAt,
    updatedAt:value.updatedAt
  });
}

export function validateTaskUpdate(value) {
  const fields=new Set([
    "workingSummary","confirmedRequirements","rejectedDirections"
  ]);
  if (!plainExact(value,fields)||
      !optionalText(value.workingSummary,8_000)||
      !safeStringList(value.confirmedRequirements,20,1_000)||
      !safeStringList(value.rejectedDirections,20,1_000)) {
    throw new Error("task_session_invalid");
  }
  return structuredClone(value);
}

export function validateTaskSession(value) {
  if (!plainExact(value,SESSION_FIELDS)||
      value.version!==1||!TASK_ID.test(value.taskId||"")||
      !SOURCES.has(value.source)||
      !STATUSES.has(value.status)||
      !Number.isSafeInteger(value.revision)||value.revision<1||
      !Number.isSafeInteger(value.resolvedRevision)||
      value.resolvedRevision<0||
      value.resolvedRevision>value.revision||
      !MODELS.has(value.model)||
      !safeText(value.goal,2_000)||
      !optionalText(value.workingSummary,8_000)||
      !safeStringList(value.confirmedRequirements,20,1_000)||
      !safeStringList(value.rejectedDirections,20,1_000)||
      !validateTurns(value.recentTurns)||
      !validateSourceIds(value.sourceIds)||
      !validatePendingInputs(value.pendingInputs,value)||
      !safeWaiting(value.waiting)||
      !safeWriterCheckpoint(
        value.writerCheckpoint,value.revision,value.resolvedRevision
      )||
      !canonicalIso(value.startedAt)||
      !canonicalIso(value.updatedAt)||
      !canonicalIso(value.expiresAt)||
      Date.parse(value.updatedAt)<Date.parse(value.startedAt)||
      Date.parse(value.expiresAt)-Date.parse(value.updatedAt)!==TTL_MS||
      Buffer.byteLength(JSON.stringify(value),"utf8")>MAX_SESSION_BYTES) {
    throw new Error("task_session_invalid");
  }
  return structuredClone(value);
}

function projectPendingInput(message,revision) {
  return {
    revision,
    messageKey:`${message.source}:${message.sourceMessageId}`,
    userId:message.userId,
    conversationId:message.conversationId,
    receivedAt:message.receivedAt,
    instructionText:message.instructionText,
    attachments:structuredClone(message.attachments),
    replyTarget:structuredClone(message.replyTarget)
  };
}

function validateMessage(message) {
  if (!message||typeof message!=="object"||Array.isArray(message)||
      !SOURCES.has(message.source)||
      typeof message.sourceMessageId!=="string"||
      !message.sourceMessageId||
      typeof message.userId!=="string"||!message.userId||
      typeof message.conversationId!=="string"||
      !message.conversationId||
      typeof message.instructionText!=="string"||
      !Array.isArray(message.attachments)||
      message.attachments.length>8||
      (!message.instructionText.trim()&&!message.attachments.length)||
      Buffer.byteLength(message.instructionText,"utf8")>32_000||
      !canonicalIso(message.receivedAt)||
      !safeAttachments(message.attachments)||
      !safeReplyTarget(message.replyTarget,message.source)) {
    throw new Error("task_session_invalid");
  }
}

function expiresAt(now) {
  return new Date(Date.parse(now)+TTL_MS).toISOString();
}

function canonicalIso(value) {
  return typeof value==="string"&&Number.isFinite(Date.parse(value))&&
    new Date(value).toISOString()===value;
}

function freezeSession(value) {
  const validated=validateTaskSession(value);
  return deepFreeze(validated);
}

function forwardTime(session,now) {
  return canonicalIso(now)&&Date.parse(now)>=Date.parse(session.updatedAt);
}

function deterministicSummary(goal,userText,assistantText) {
  const text=`目标：${goal}\n用户：${userText}\n助手：${assistantText}`;
  const characters=[...text];
  while (characters.length&&
      Buffer.byteLength(characters.join(""),"utf8")>8_000) {
    characters.pop();
  }
  return characters.join("");
}

function validateTurns(value) {
  return Array.isArray(value)&&value.length<=12&&value.every(turn=>
    plainExact(turn,new Set(["role","text"]))&&
    new Set(["user","assistant"]).has(turn.role)&&
    safeText(turn.text,32_000)
  );
}

function validateSourceIds(value) {
  return Array.isArray(value)&&value.length<=8&&
    new Set(value).size===value.length&&
    value.every(item=>/^source-\d{3}$/u.test(item));
}

function validatePendingInputs(value,session) {
  if (!Array.isArray(value)||value.length>8) return false;
  const fields=new Set([
    "revision","messageKey","userId","conversationId","receivedAt",
    "instructionText","attachments","replyTarget"
  ]);
  const revisions=new Set();
  const keys=new Set();
  let attachmentCount=session.sourceIds.length;
  for (const input of value) {
    if (!plainExact(input,fields)||
        !Number.isSafeInteger(input.revision)||
        input.revision<=session.resolvedRevision||
        input.revision>session.revision||
        revisions.has(input.revision)||
        typeof input.messageKey!=="string"||
        !input.messageKey.startsWith(`${session.source}:`)||
        keys.has(input.messageKey)||
        !safeIdentity(input.userId)||
        !safeIdentity(input.conversationId)||
        !canonicalIso(input.receivedAt)||
        typeof input.instructionText!=="string"||
        Buffer.byteLength(input.instructionText,"utf8")>32_000||
        !safeAttachments(input.attachments)||
        !safeReplyTarget(input.replyTarget,session.source)) {
      return false;
    }
    revisions.add(input.revision);
    keys.add(input.messageKey);
    attachmentCount+=input.attachments.length;
  }
  return attachmentCount<=8;
}

function safeWaiting(value) {
  if (value===null) return true;
  try {
    validateWaiting(value);
    return true;
  } catch {
    return false;
  }
}

function validateWaiting(value) {
  if (value===null) return;
  const fields=new Set(["type","question","preparedTool","confirmed"]);
  if (!plainExact(value,fields)||
      !WAITING_TYPES.has(value.type)||
      !safeText(value.question,1_000)||
      !(value.preparedTool===null||
        /^[a-z][a-z0-9_]{0,63}$/u.test(value.preparedTool||""))||
      !plainConfirmed(value.confirmed)) {
    throw new Error("task_session_invalid");
  }
}

function safeWriterCheckpoint(value,revision,resolvedRevision) {
  if (value===null) return true;
  return plainExact(
    value,new Set(["revision","toolName","status"])
  )&&Number.isSafeInteger(value.revision)&&
    value.revision>resolvedRevision&&
    value.revision<=revision&&
    /^[a-z][a-z0-9_]{0,63}$/u.test(value.toolName||"")&&
    new Set(["reserved","cancel_requested"]).has(value.status);
}

function safeAttachments(value) {
  const fields=new Set([
    "type","sourceAttachmentId","displayName","extension"
  ]);
  return Array.isArray(value)&&value.length<=8&&value.every(item=>
    plainExact(item,fields)&&
    new Set(["image","file"]).has(item.type)&&
    safeIdentity(item.sourceAttachmentId)&&
    safeText(item.displayName,1_000)&&
    typeof item.extension==="string"&&
    Buffer.byteLength(item.extension,"utf8")<=32
  );
}

function safeReplyTarget(value,source) {
  const fields=source==="wechat"
    ?new Set(["source","sourceMessageId","conversationId","contextToken"])
    :new Set(["source","sourceMessageId","conversationId"]);
  if (!plainExact(value,fields)||value.source!==source) return false;
  return [...fields].every(field=>safeIdentity(value[field],4_096));
}

function safeStringList(value,maxItems,maxBytes) {
  return Array.isArray(value)&&value.length<=maxItems&&
    new Set(value).size===value.length&&
    value.every(item=>safeText(item,maxBytes)&&!unsafeReference(item));
}

function plainConfirmed(value) {
  return value&&typeof value==="object"&&!Array.isArray(value)&&
    Object.getPrototypeOf(value)===Object.prototype&&
    Object.keys(value).length<=16&&
    Object.entries(value).every(([key,item])=>
      /^[a-z][a-zA-Z0-9_]{0,63}$/u.test(key)&&
      safeText(item,1_000)
    );
}

function safeText(value,maxBytes) {
  return typeof value==="string"&&value.trim()&&
    Buffer.byteLength(value,"utf8")<=maxBytes&&!value.includes("\0");
}

function optionalText(value,maxBytes) {
  return typeof value==="string"&&
    Buffer.byteLength(value,"utf8")<=maxBytes&&
    !value.includes("\0")&&(value===""||value.trim()===value)&&
    !unsafeReference(value);
}

function safeIdentity(value,maxBytes=512) {
  return typeof value==="string"&&value.length>0&&
    Buffer.byteLength(value,"utf8")<=maxBytes&&!value.includes("\0");
}

function unsafeReference(value) {
  return value.startsWith("/")||value.startsWith("~")||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value);
}

function plainExact(value,fields) {
  return value&&typeof value==="object"&&!Array.isArray(value)&&
    Object.getPrototypeOf(value)===Object.prototype&&
    Object.keys(value).length===fields.size&&
    Object.keys(value).every(key=>fields.has(key));
}

function deepFreeze(value) {
  if (value&&typeof value==="object"&&!Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
