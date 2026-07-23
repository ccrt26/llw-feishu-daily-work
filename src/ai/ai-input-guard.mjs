const MAX_INPUT_BYTES=32 * 1024;
const ROUTER_ROOT=new Set(["message","conversation","capabilities"]);
const ROUTER_CONVERSATION=new Set(["capability","question","startedAt"]);
const ROUTING_CONTRACT=new Set(["capability","purpose","accepts","positive_examples","negative_examples","supports_continuation"]);
const DAILY_ROOT=new Set(["message","conversation","candidates"]);
const DAILY_MESSAGE=new Set(["ok","messageId","text","createTime"]);
const DAILY_CONVERSATION=new Set(["id","status","turns","candidateIds","model"]);
const DAILY_TURN=new Set(["role","text","createTime"]);
const DAILY_CANDIDATE=new Set(["record_id","date","occurred_time","occurred_end_time","title","people","location","summary","follow_ups"]);

const PRIVATE_KEY_HEADER=/-----BEGIN (?:PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY|OPENSSH PRIVATE KEY)-----/u;
const BEARER_VALUE=/\bauthorization\s*:\s*bearer\s+([^\s,，;；。！？?]+)/iu;
const JWT_VALUE=/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/u;
const NAMED_CREDENTIAL_VALUE=/(?:\b(?:API Key|api_key|access_token|refresh_token|client_secret|session_cookie|password|passwd|pwd|OTP|MFA code)\b|密码|登录密码|验证码|动态验证码|恢复码|(?:微信|飞书|邮箱|云服务)\s*(?:登录密码|Token|验证码))\s*(?:[:=：]|是|为|等于)\s*(?!什么(?:[？?]|$))([^\s,，;；。！？?]+)/giu;
const CARD_SECURITY_CODE=/\b(?:CVV|CVC|CID)\b\s*(?:[:=：]|是|为|等于)\s*(\d{3,4})\b/iu;
const PAYMENT_NAMED_VALUE=/(?:\bPIN\b|银行卡\s*PIN|支付密码|网银密码|银行验证码|支付验证码|支付授权码|转账授权码|支付口令)\s*(?:[:=：]|是|为|等于)\s*([^\s,，;；。！？?]+)/giu;
const CARD_NUMBER_GROUP=/(?:\d[\s-]*)+/gu;

export function guardAiInput(task,input) {
  prepareGuardedAiInput(task,input);
  return structuredClone(input);
}

export function prepareGuardedAiInput(task,input) {
  try {
    let prepared;
    if (task==="router.text") {
      validateRouter(input);
      prepared={context:structuredClone(input),validation:{enabledNames:input.capabilities.map(item=>item.capability)}};
    }
    else if (task==="daily-work.interpret") prepared=prepareDaily(input);
    else reject();
    const serialized=JSON.stringify(prepared.context);
    if (Buffer.byteLength(serialized,"utf8")>MAX_INPUT_BYTES) reject();
    for (const value of modelTextValues(task,prepared.context)) {
      if (detectPaymentCredential(value)) reject("payment");
      if (detectStrongCredentialFormat(value)||detectNamedCredentialValue(value)) reject("credential");
    }
    return prepared;
  } catch (error) {
    if (error?.message==="ai_input_rejected") throw error;
    reject();
  }
}

function detectStrongCredentialFormat(text) {
  if (PRIVATE_KEY_HEADER.test(text)||JWT_VALUE.test(text)) return true;
  const bearer=BEARER_VALUE.exec(text);
  return Boolean(bearer&&!isObviousPlaceholder(bearer[1]));
}

function detectNamedCredentialValue(text) {
  for (const match of text.matchAll(NAMED_CREDENTIAL_VALUE)) if (!isObviousPlaceholder(match[1])) return true;
  return false;
}

function detectPaymentCredential(text) {
  if (CARD_SECURITY_CODE.test(text)) return true;
  for (const match of text.matchAll(CARD_NUMBER_GROUP)) {
    const digits=match[0].replace(/[^0-9]/g,"");
    if (digits.length>=13&&digits.length<=19&&digits.split("").reverse().reduce((sum,digit,index)=>{
      let value=Number(digit);
      if (index%2===1) value=value>4?value*2-9:value*2;
      return sum+value;
    },0)%10===0) return true;
  }
  for (const match of text.matchAll(PAYMENT_NAMED_VALUE)) if (!isObviousPlaceholder(match[1])) return true;
  return false;
}

function isObviousPlaceholder(value) {
  const normalized=value.trim().replace(/^[\s("'（【]+|[\s)"'）】.,，。!?！？]+$/gu,"").trim();
  return new Set(["<API_KEY>","${API_KEY}","YOUR_API_KEY","REDACTED","MASKED","****","xxxx","sk-****","卡号 **** **** **** 1234","已脱敏"]).has(normalized)
    || /^(?:什么|(?:的)?格式是什么|如何(?:获取|修改))$/u.test(normalized);
}

function* modelTextValues(task,context) {
  if (task==="router.text") {
    if (typeof context.message.text==="string") yield context.message.text;
    if (typeof context.message.attachment?.displayName==="string") yield context.message.attachment.displayName;
    if (typeof context.conversation?.question==="string") yield context.conversation.question;
    return;
  }
  yield context.message.text;
  for (const turn of context.conversation?.turns||[]) yield turn.text;
  for (const candidate of context.candidates) {
    yield candidate.title;
    yield* candidate.people;
    yield candidate.location;
    yield candidate.summary;
    yield* candidate.follow_ups;
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

function prepareDaily(input) {
  exact(input,DAILY_ROOT);
  only(input.message,DAILY_MESSAGE);
  if (!text(input.message.text,12_000)||!validTimestamp(input.message.createTime)) reject();
  if (Object.hasOwn(input.message,"ok")&&input.message.ok!==true) reject();
  if (Object.hasOwn(input.message,"messageId")&&!text(input.message.messageId,512)) reject();
  let conversation=null;
  if (input.conversation!==null) {
    only(input.conversation,DAILY_CONVERSATION);
    if (!Array.isArray(input.conversation.turns)||input.conversation.turns.length>40) reject();
    conversation={turns:input.conversation.turns.map(turn=>{
      only(turn,DAILY_TURN);
      if (!new Set(["user","assistant"]).has(turn.role)||!text(turn.text,12_000)||(Object.hasOwn(turn,"createTime")&&!validTimestamp(turn.createTime))) reject();
      const value={role:turn.role,text:turn.text};
      if (Object.hasOwn(turn,"createTime")) value.sent_at_beijing=beijingTimestamp(turn.createTime);
      return value;
    })};
  }
  if (!Array.isArray(input.candidates)||input.candidates.length>20) reject();
  for (const candidate of input.candidates) {
    exact(candidate,DAILY_CANDIDATE);
    if (!/^[a-f0-9]{16}$/.test(candidate.record_id)||!/^\d{4}-\d{2}-\d{2}$/.test(candidate.date)) reject();
    for (const field of ["occurred_time","occurred_end_time"]) if (typeof candidate[field]!=="string"||candidate[field].length>5) reject();
    if (!text(candidate.title,80)||typeof candidate.location!=="string"||candidate.location.length>120||!text(candidate.summary,4000)||!stringArray(candidate.people,50,80)||!stringArray(candidate.follow_ups,50,500)) reject();
  }
  return {
    context:{message:{text:input.message.text,sent_at_beijing:beijingTimestamp(input.message.createTime)},conversation,candidates:structuredClone(input.candidates)},
    validation:{sourceText:input.message.text,candidateIds:input.candidates.map(candidate=>candidate.record_id),allowedOriginalTexts:[input.message.text,...(conversation?.turns||[]).filter(turn=>turn.role==="user").map(turn=>turn.text)]}
  };
}

function exact(value,fields) {
  if (!value||typeof value!=="object"||Array.isArray(value)) reject();
  const keys=Object.keys(value);
  if (keys.length!==fields.size||keys.some(key=>!fields.has(key))) reject();
}
function only(value,fields) {
  if (!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(key=>!fields.has(key))) reject();
}
function text(value,max) { return typeof value==="string"&&value.length>0&&value.length<=max; }
function stringArray(value,maxItems,maxLength) { return Array.isArray(value)&&value.length<=maxItems&&value.every(item=>text(item,maxLength)); }
function validTimestamp(value) { return Number.isFinite(value)&&Number.isFinite(new Date(value).getTime()); }
function beijingTimestamp(milliseconds) { return new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).format(new Date(milliseconds)); }
function reject(reasonCode) {
  const error=new Error("ai_input_rejected");
  if (reasonCode) error.reasonCode=reasonCode;
  throw error;
}
