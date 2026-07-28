const PRIVATE_KEY_HEADER=/-----BEGIN (?:PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY|OPENSSH PRIVATE KEY)-----/u;
const BEARER_VALUE=/\bauthorization\s*:\s*bearer\s+([^\s,，;；。！？?]+)/iu;
const JWT_VALUE=/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/u;
const NAMED_CREDENTIAL_VALUE=/(?:\b(?:API Key|api_key|access_token|refresh_token|client_secret|session_cookie|password|passwd|pwd|OTP|MFA code)\b|密码|登录密码|验证码|动态验证码|恢复码|(?:微信|飞书|邮箱|云服务)\s*(?:登录密码|Token|验证码))\s*(?:[:=：]|是|为|等于)\s*(?!什么(?:[？?]|$))([^\s,，;；。！？?]+)/giu;
const CARD_SECURITY_CODE=/\b(?:CVV|CVC|CID)\b\s*(?:[:=：]|是|为|等于)\s*(\d{3,4})\b/iu;
const PAYMENT_NAMED_VALUE=/(?:\bPIN\b|银行卡\s*PIN|支付密码|网银密码|银行验证码|支付验证码|支付授权码|转账授权码|支付口令)\s*(?:[:=：]|是|为|等于)\s*([^\s,，;；。！？?]+)/giu;
const CARD_NUMBER_GROUP=/(?:\d[\s-]*)+/gu;
const PATH_ACTION=/(?:保存到|写入|归档到|移动到|创建到)\s*(?:\/|~(?:\/|$)|[^\n]{0,160}(?:^|\/)\.\.(?:\/|$))/mu;

export function assertContentSafe({
  instructionText,sources=[],conversation,limits
}) {
  try {
    if (typeof instructionText!=="string"||
        !limits||!Number.isSafeInteger(limits.maxContextBytes)||
        limits.maxContextBytes<1024||limits.maxContextBytes>1024*1024) {
      reject();
    }
    if (!Array.isArray(sources)||sources.length>8) reject();
    const context={instructionText,sources,conversation};
    if (Buffer.byteLength(JSON.stringify(context),"utf8")>limits.maxContextBytes||
        Buffer.byteLength(instructionText,"utf8")>32_768||
        PATH_ACTION.test(instructionText)) {
      reject();
    }
    for (const value of textValues(context)) {
      if (detectPaymentCredential(value)||
          detectStrongCredentialFormat(value)||
          detectNamedCredentialValue(value)) {
        reject();
      }
    }
    return context;
  } catch (error) {
    if (error?.message==="content_safety_rejected") throw error;
    reject();
  }
}

function* textValues(value,seen=new Set()) {
  if (typeof value==="string") {
    yield value;
    return;
  }
  if (!value||typeof value!=="object"||seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) yield* textValues(item,seen);
    return;
  }
  for (const [key,item] of Object.entries(value)) {
    if (key==="sha256"||key==="jobRef") continue;
    yield* textValues(item,seen);
  }
}

function detectStrongCredentialFormat(text) {
  if (PRIVATE_KEY_HEADER.test(text)||JWT_VALUE.test(text)) return true;
  const bearer=BEARER_VALUE.exec(text);
  return Boolean(bearer&&!isObviousPlaceholder(bearer[1]));
}

function detectNamedCredentialValue(text) {
  for (const match of text.matchAll(NAMED_CREDENTIAL_VALUE)) {
    if (!isObviousPlaceholder(match[1])) return true;
  }
  return false;
}

function detectPaymentCredential(text) {
  if (CARD_SECURITY_CODE.test(text)) return true;
  for (const match of text.matchAll(CARD_NUMBER_GROUP)) {
    const digits=match[0].replace(/[^0-9]/g,"");
    if (digits.length>=13&&digits.length<=19&&luhn(digits)) return true;
  }
  for (const match of text.matchAll(PAYMENT_NAMED_VALUE)) {
    if (!isObviousPlaceholder(match[1])) return true;
  }
  return false;
}

function luhn(digits) {
  return digits.split("").reverse().reduce((sum,digit,index)=>{
    let value=Number(digit);
    if (index%2===1) value=value>4?value*2-9:value*2;
    return sum+value;
  },0)%10===0;
}

function isObviousPlaceholder(value) {
  const normalized=value.trim()
    .replace(/^[\s("'（【]+|[\s)"'）】.,，。!?！？]+$/gu,"").trim();
  return new Set([
    "<API_KEY>","${API_KEY}","YOUR_API_KEY","REDACTED","MASKED",
    "****","xxxx","sk-****","卡号 **** **** **** 1234","已脱敏"
  ]).has(normalized)||/^(?:什么|(?:的)?格式是什么|如何(?:获取|修改))$/u.test(normalized);
}

function reject() {
  throw new Error("content_safety_rejected");
}
