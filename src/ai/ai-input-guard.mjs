const MAX_INPUT_BYTES=32 * 1024;
const ROUTER_ROOT=new Set(["message","conversation","capabilities"]);
const ROUTER_CONVERSATION=new Set(["capability","question","startedAt"]);
const ROUTING_CONTRACT=new Set(["capability","purpose","accepts","positive_examples","negative_examples","supports_continuation"]);
const DAILY_ROOT=new Set(["message","conversation","candidates"]);
const DAILY_MESSAGE=new Set(["text","sent_at_beijing"]);
const DAILY_CONVERSATION=new Set(["turns"]);
const DAILY_TURN=new Set(["role","text","sent_at_beijing"]);
const DAILY_CANDIDATE=new Set(["record_id","date","occurred_time","occurred_end_time","title","people","location","summary","follow_ups"]);

const FORBIDDEN_PATTERNS=[
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/iu,
  /\bBearer\s+[^\s]+/iu,
  /\bAuthorization\s*:\s*(?:Bearer|Token|Basic)\s+\S+/iu,
  /\b(?:api[_ -]?key|client[_ -]?secret|token|access[_ -]?token|refresh[_ -]?token|credential(?:s)?|private[_ -]?key|session[_ -]?cookie|ssh[_ -]?key|mfa[_ -]?(?:secret|key)|recovery[_ -]?code|otp|password|passwd|pwd)\s*[:=：]\s*\S+/iu,
  /(?:密码|凭证|口令|恢复码|动态验证码|验证码|支付密码|支付二维码|转账口令|授权信息|网银登录信息)\s*[:=：]\s*\S+/u,
  /(?:银行卡(?:完整)?卡号|卡号|credit\s*card)\s*[:=：]?\s*(?:\d[ -]?){13,19}/iu,
  /\b(?:cvv|cvc|pin)\s*[:=：]\s*\d{3,8}\b/iu,
  /(?:密级\s*[:=：]\s*(?:绝密|机密|秘密|保密)|内部禁止外发|禁止外发)/u,
  /(?:【(?:绝密|机密|秘密|保密)】|\[(?:绝密|机密|秘密|保密)\])/u,
  /(?:security\s+dump-keychain|keychain\s+export|钥匙串导出|系统环境变量|未脱敏(?:的)?(?:系统)?日志|浏览器(?:配置|cookie)|崩溃转储)/iu,
  /(?:^|\n)(?:PATH|HOME|USER|SHELL|AWS_[A-Z0-9_]*|OPENAI_[A-Z0-9_]*|ANTHROPIC_[A-Z0-9_]*|DEEPSEEK_[A-Z0-9_]*)=/u,
  /(?:^|\n)\s*(?:\d{4}-\d{2}-\d{2}[T ][^\n]{0,60}\b(?:INFO|WARN|ERROR|DEBUG)\b|\[(?:INFO|WARN|ERROR|DEBUG)\])/iu,
  /(?:身份证正反面(?:原图)?|护照完整页|驾驶证完整页|社保卡原图|银行卡原图|身份认证(?:人脸|指纹)|生物识别材料)/u,
  /(?:(?<![A-Za-z0-9_:/])\/(?!\/)\S+|(?<![A-Za-z0-9_])[A-Za-z]:[\\/]\S+|\\\\[^\\\s]+\\[^\\\s]+|(?<!:)\/\/[^/\s]+\/\S+)/u,
  /\b(?:sender|chat|message|event|resource|file|image)[_-]?(?:id|key)\s*(?:[:=：]|\s+是)\s*\S+/iu,
  /\b(?:ou|oc|om|on|cli|file|img)_[A-Za-z0-9][A-Za-z0-9_-]{5,}\b/iu,
  /(?:整个|全部|全量)(?:\s*Obsidian\s*Vault|\s*Vault|邮箱|客户目录|项目目录|目录|文件夹|历史资料|历史消息|文件)/iu
];

export function guardAiInput(task,input) {
  try {
    if (task==="router.text") validateRouter(input);
    else if (task==="daily-work.interpret") validateDaily(input);
    else reject();
    const serialized=JSON.stringify(input);
    if (Buffer.byteLength(serialized,"utf8")>MAX_INPUT_BYTES) reject();
    for (const value of strings(input)) for (const pattern of FORBIDDEN_PATTERNS) if (pattern.test(value)) reject();
    return structuredClone(input);
  } catch (error) {
    if (error?.message==="ai_input_rejected") throw error;
    reject();
  }
}

function validateRouter(input) {
  exact(input,ROUTER_ROOT);
  const message=input.message;
  if (!message||typeof message!=="object"||Array.isArray(message)||!new Set(["text","image","file"]).has(message.type)||!text(message.beijingTime,40)) reject();
  if (message.type==="text") {
    exact(message,new Set(["type","text","beijingTime"]));
    if (!text(message.text,12_000)) reject();
  } else {
    exact(message,new Set(["type","attachment","beijingTime"]));
    exact(message.attachment,new Set(["displayName","extension","resourceType"]));
    if (!text(message.attachment.displayName,255)||typeof message.attachment.extension!=="string"||message.attachment.extension.length>20||message.attachment.resourceType!==message.type) reject();
  }
  if (input.conversation!==null) {
    exact(input.conversation,ROUTER_CONVERSATION);
    if (input.conversation.capability!==null&&!text(input.conversation.capability,64)) reject();
    if (!text(input.conversation.question,200)||!text(input.conversation.startedAt,64)) reject();
  }
  if (!Array.isArray(input.capabilities)||input.capabilities.length>20) reject();
  for (const contract of input.capabilities) {
    exact(contract,ROUTING_CONTRACT);
    if (!text(contract.capability,64)||!text(contract.purpose,500)||!stringArray(contract.accepts,3,20)||!stringArray(contract.positive_examples,20,500)||!stringArray(contract.negative_examples,20,500)||typeof contract.supports_continuation!=="boolean") reject();
  }
}

function validateDaily(input) {
  exact(input,DAILY_ROOT); exact(input.message,DAILY_MESSAGE);
  if (!text(input.message.text,12_000)||!text(input.message.sent_at_beijing,40)) reject();
  if (input.conversation!==null) {
    exact(input.conversation,DAILY_CONVERSATION);
    if (!Array.isArray(input.conversation.turns)||input.conversation.turns.length>40) reject();
    for (const turn of input.conversation.turns) {
      exact(turn,new Set(Object.hasOwn(turn,"sent_at_beijing")?DAILY_TURN:["role","text"]));
      if (!new Set(["user","assistant"]).has(turn.role)||!text(turn.text,12_000)||(Object.hasOwn(turn,"sent_at_beijing")&&!text(turn.sent_at_beijing,40))) reject();
    }
  }
  if (!Array.isArray(input.candidates)||input.candidates.length>20) reject();
  for (const candidate of input.candidates) {
    exact(candidate,DAILY_CANDIDATE);
    if (!/^[a-f0-9]{16}$/.test(candidate.record_id)||!/^\d{4}-\d{2}-\d{2}$/.test(candidate.date)) reject();
    for (const field of ["occurred_time","occurred_end_time"]) if (typeof candidate[field]!=="string"||candidate[field].length>5) reject();
    if (!text(candidate.title,80)||typeof candidate.location!=="string"||candidate.location.length>120||!text(candidate.summary,4000)||!stringArray(candidate.people,50,80)||!stringArray(candidate.follow_ups,50,500)) reject();
  }
}

function exact(value,fields) {
  if (!value||typeof value!=="object"||Array.isArray(value)) reject();
  const keys=Object.keys(value);
  if (keys.length!==fields.size||keys.some(key=>!fields.has(key))) reject();
}
function text(value,max) { return typeof value==="string"&&value.length>0&&value.length<=max; }
function stringArray(value,maxItems,maxLength) { return Array.isArray(value)&&value.length<=maxItems&&value.every(item=>text(item,maxLength)); }
function* strings(value) {
  if (typeof value==="string") { yield value; return; }
  if (Array.isArray(value)) { for (const item of value) yield* strings(item); return; }
  if (value&&typeof value==="object") for (const item of Object.values(value)) yield* strings(item);
}
function reject() { throw new Error("ai_input_rejected"); }
