const MAX_INPUT_BYTES=32 * 1024;
const ROUTER_ROOT=new Set(["message","conversation","capabilities"]);
const ROUTER_CONVERSATION=new Set(["capability","question","startedAt"]);
const ROUTING_CONTRACT=new Set(["capability","purpose","accepts","positive_examples","negative_examples","supports_continuation"]);
const DAILY_ROOT=new Set(["message","conversation","candidates"]);
const DAILY_MESSAGE=new Set(["ok","messageId","text","createTime"]);
const DAILY_CONVERSATION=new Set(["id","status","turns","candidateIds","model"]);
const DAILY_TURN=new Set(["role","text","createTime"]);
const DAILY_CANDIDATE=new Set(["record_id","date","occurred_time","occurred_end_time","title","people","location","summary","follow_ups"]);

const ASSIGNMENT_OR_DISCLOSURE=[
  /(?:[:=：]|(?:的)?(?:值|内容)?\s*(?:是|为|等于|如下))\s*(?!什么[？?]?)/iu,
  /\b(?:value\s*)?(?:is|equals)\s*\S+/iu
];
const SECRET_DISCLOSURE_ACTIONS=/(?:包含|含有|附上)/u;
const SECRET_PRESENTATION_CONTEXT=[/(?:在这里|原始配置文件)/u];
const IDENTITY_ACCESS_TERMS=[
  /(?:密码|passwd|password|pwd|登录口令|凭证|凭据|credentials?|认证信息|恢复码|恢复代码|验证码|otp|访问令牌|刷新令牌|令牌|access[_ -]?token|refresh[_ -]?token|token|会话\s*cookie|session[_ -]?cookie|私钥|private[_ -]?key|api[_ -]?(?:key|密钥)|client[_ -]?secret|ssh[_ -]?(?:key|密钥)|mfa[_ -]?(?:secret|key)|mfa\s*[密秘]钥|多因素认证(?:种子|密钥|秘钥)|authorization)/iu
];
const PAYMENT_CONTROL_TERMS=[
  /(?:银行卡(?:号|卡号|\s*pin\s*码?)?|信用卡(?:号码|卡号)?|卡号|card[_ -]?number|cvv|cvc|\bpin\b|security\s+code|安全码|校验码|卡背面.{0,6}(?:数字|码)|付款码|支付码|(?:付款|支付|收款)?二维码|支付密码|支付凭证|转账口令|支付授权信息|转账.{0,4}授权代码|网银登录信息)/iu
];
const PAYMENT_OPERATION_CONTEXT=[/(?:扫码|扫描|直接|自动).{0,12}(?:支付|转账|扣款|扣费|付款)|(?:支付|转账|扣款|扣费|付款).{0,12}(?:扫码|扫描|直接|自动)/u];

const IDENTITY_MATERIAL_TERMS=[
  /(?:身份证|护照|驾驶证|驾驶执照|驾照|社保卡|社会保障卡|银行卡|借记卡|刷脸|人脸|指纹|虹膜|声纹|生物识别)/u
];
const IDENTITY_MATERIAL_CONTEXT=[
  /(?:正面和背面|正反(?:两)?面|前后(?:两)?面|正[、,，和]\s*反面|正面|完整页|整页|全页|资料页|个人信息页|第一页|原图|原始图片|照片|扫描件|扫描图|影像|截图|视频|材料|素材|模板|样本|数据|base64)/iu,
  /(?:用于|用作|供).{0,8}(?:身份|实名)?(?:核验|认证)|(?:身份|实名)(?:核验|认证)用/u,
  /(?:请处理|请识别|附上|在这里)/u
];
const IDENTITY_DEVELOPMENT_CONTEXT=[
  /(?:识别|核验|认证|模板).{0,8}(?:功能|算法|流程|方案).{0,12}(?:开发|评审|测试|完成)/u,
  /(?:设计|开发|评审|编写).{0,20}(?:身份证|护照|人脸|指纹|虹膜|声纹|模板).{0,20}(?:算法|功能|流程|单元测试|测试)/u
];
const IDENTITY_PRESENTATION_CONTEXT=[/(?:原图|照片|扫描件|截图|视频|材料|素材|样本|数据|附上|在这里|请处理|请识别|用于.{0,8}(?:核验|认证))/u];

const CLASSIFICATION_TERMS=[/(?:绝密|机密|秘密|保密)/u];
const CLASSIFICATION_CONTEXT=[
  /(?:密级|等级|标记|标注|注明|标明|标有|属于)/u,
  /(?:绝密|机密|秘密|保密)(?:级|等级)?的?(?:项目|资料|文件|内容|原文|合同|信息)/u,
  /(?:【|\[)(?:绝密|机密|秘密|保密)(?:】|\])/u
];
const RESTRICTION_TERMS=[/(?:仅限内部|内部禁止外发|(?:内部|公司内部).{0,4}(?:资料|材料|文件)|保密协议|\bnda\b|监管|合同|公司制度|保密义务|无权授权|未经.{0,12}(?:授权|许可)|第三方.{0,8}(?:没有|未)授权|没有得到第三方授权|未授权第三方|明确限制)/iu];
const NO_EXFILTRATION_CONTEXT=[/(?:不得|不能|禁止|严禁|不允许|请勿|无权|没有授权|未授权|明确限制).{0,18}(?:外发|对外披露|交给|提供|发送|传播|处理|原文|材料|资料|外部\s*(?:ai|模型)|模型)|(?:原文|材料|资料).{0,18}(?:不得|不能|禁止|严禁|不允许|请勿)/iu];
const CONFIDENTIAL_MATERIAL_TERMS=[/(?:文档|原文|材料|资料|文件|内容|外部\s*(?:ai|模型)|模型)/iu];
const NEGATED_NO_EXFILTRATION=[
  /(?:不是|并非|不属于|未标记为|未标注为|未注明为).{0,8}(?:绝密|机密|秘密|保密)(?:资料|文件|内容|项目)?/u,
  /(?:已)?(?:取消|撤销).{0,12}(?:(?:绝密|机密|秘密|保密).{0,4}(?:标记|标注|密级)|禁止外发(?:要求)?)/u
];

const BULK_QUANTIFIERS=[/(?:整个|全部|全量|所有|每封|每一个|一次性|一口气|批量|递归|打包|从头到尾|完整|一万|\d{4,}|过去.{0,8}年|往年|历年|历史|旧|全(?=发|交|上传|提交))/u];
const BULK_RESOURCES=[/(?:obsidian\s*vault|vault|邮箱|邮件|客户目录|客户文件夹|客户资料库|项目目录|项目文件夹|工程目录|项目资料|目录|文件夹|历史资料|历史消息|旧资料|往年资料|历年资料|对话|聊天记录|聊天备份|记录|附件|文件)/iu];
const BULK_ACTIONS=/(?:上传|提交|读取|扫描|导入|发送|发给|交给|打包|提供|给(?=\s*(?:ai|模型)))/iu;

const SYSTEM_QUALIFIERS=[/(?:完整|全部|原始|原样|未脱敏|未经脱敏|导出|转储|备份|dump-keychain|崩溃\s*dump|crash\s*dump|core\s*dump|\bdump\b)/iu];
const SYSTEM_MATERIAL_TERMS=[/(?:环境变量|\benv\b|\.env\b|系统日志|应用日志|syslog|journald\s*日志|浏览器配置|浏览器用户配置目录|浏览器.{0,8}cookie|(?:chrome|safari|firefox).{0,8}(?:用户数据目录|cookie\s*数据)|browser.{0,8}cookie|keychain|钥匙串|凭证目录|凭证文件夹|secrets?\s*(?:目录|文件夹|仓库|repository)|token\s*存储目录|core\s*dump|crash\s*dump|崩溃\s*(?:转储|dump))/iu];
const INHERENT_RAW_SYSTEM_TERMS=[/(?:浏览器配置|浏览器用户配置目录|浏览器.{0,8}cookie|(?:chrome|safari|firefox).{0,8}(?:用户数据目录|cookie\s*数据)|browser.{0,8}cookie)/iu];
const SYSTEM_DISCLOSURE_CONTEXT=[/(?:如下|这是|在下面|在后文|文件|数据库|目录|仓库|中有|里有|包含|含有|contains|发送|上传|提交|导出|读取|粘贴|提供|打包)/iu];
const SYSTEM_DEVELOPMENT_CONTEXT=[/(?:编写|开发|设计|调研|评审).{0,40}(?:检测|单元测试|测试|解析|加载器|api)/iu];
const SYSTEM_PRESENTATION_CONTEXT=[
  /(?:如下|这是|附上|在这里|在下面|在后文|导出文件|备份文件|用户数据目录|数据库|仓库|中有|里有|包含|含有|contains|现在执行)/iu,
  /(?:请|把|将|帮我).{0,24}(?:发送|上传|提交|交给|导出|读取|提供|粘贴|打包)/u
];

const HARD_FORBIDDEN_PATTERNS=[
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/iu,
  /(?:^|\n)(?:PATH|HOME|USER|SHELL|AWS_[A-Z0-9_]*|OPENAI_[A-Z0-9_]*|ANTHROPIC_[A-Z0-9_]*|DEEPSEEK_[A-Z0-9_]*)=/u,
  /(?:^|\n)\s*(?:\d{4}-\d{2}-\d{2}[T ][^\n]{0,60}\b(?:INFO|WARN|ERROR|DEBUG)\b|\[(?:INFO|WARN|ERROR|DEBUG)\])/iu,
  /(?:(?<![A-Za-z0-9_:/])\/(?!\/)\S+|(?<![A-Za-z0-9_])[A-Za-z]:[\\/]\S+|\\\\[^\\\s]+\\[^\\\s]+|(?<!:)\/\/[^/\s]+\/\S+)/u,
  /\b(?:sender|chat|message|event|resource|file|image)[_-]?(?:id|key)\s*(?:[:=：]|\s+是)\s*\S+/iu,
  /\b(?:ou|oc|om|on|cli|file|img)_[A-Za-z0-9][A-Za-z0-9_-]{5,}\b/iu
];

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
    for (const value of strings(prepared.context)) if (isForbiddenAiText(value)) reject();
    return prepared;
  } catch (error) {
    if (error?.message==="ai_input_rejected") throw error;
    reject();
  }
}

function isForbiddenAiText(value) {
  return matchesAny(value,HARD_FORBIDDEN_PATTERNS)
    || isIdentityAccessDisclosure(value)
    || isPaymentControlDisclosure(value)
    || isIdentityMaterial(value)
    || isNoExfiltrationMaterial(value)
    || isUnboundedBulkDisclosure(value)
    || isRawSystemMaterial(value);
}

function isIdentityAccessDisclosure(value) {
  if (!matchesAny(value,IDENTITY_ACCESS_TERMS)) return false;
  if (/\bauthorization\s*:\s*(?:bearer|token|basic)\s+(?:的)?(?:格式|含义|用途|是什么)/iu.test(value)) return false;
  if (/\bauthorization\s*:\s*(?:bearer|token|basic)\s+\S+/iu.test(value)) return true;
  if (/\bbearer\s+(?!token\s*(?:是什么|的(?:格式|含义|用途)))[A-Za-z0-9._~+/-]{4,}/iu.test(value)) return true;
  return matchesAny(value,ASSIGNMENT_OR_DISCLOSURE)
    || matchesAny(value,SECRET_PRESENTATION_CONTEXT)
    || hasAffirmativeAction(value,SECRET_DISCLOSURE_ACTIONS);
}

function isPaymentControlDisclosure(value) {
  return matchesAny(value,PAYMENT_CONTROL_TERMS)
    && (matchesAny(value,ASSIGNMENT_OR_DISCLOSURE)||matchesAny(value,PAYMENT_OPERATION_CONTEXT));
}

function isIdentityMaterial(value) {
  if (!matchesAny(value,IDENTITY_MATERIAL_TERMS)||!matchesAny(value,IDENTITY_MATERIAL_CONTEXT)) return false;
  const developmentOnly=matchesAny(value,IDENTITY_DEVELOPMENT_CONTEXT)&&!matchesAny(value,IDENTITY_PRESENTATION_CONTEXT);
  return !developmentOnly;
}

function isNoExfiltrationMaterial(value) {
  const activeValue=withoutLocalNegations(value,NEGATED_NO_EXFILTRATION);
  const explicitRestriction=matchesAny(activeValue,NO_EXFILTRATION_CONTEXT)
    && (matchesAny(activeValue,RESTRICTION_TERMS)||matchesAny(activeValue,CONFIDENTIAL_MATERIAL_TERMS));
  if (explicitRestriction) return true;
  return matchesAny(activeValue,CLASSIFICATION_TERMS)&&matchesAny(activeValue,CLASSIFICATION_CONTEXT);
}

function isUnboundedBulkDisclosure(value) {
  return matchesAny(value,BULK_QUANTIFIERS)
    && matchesAny(value,BULK_RESOURCES)
    && hasAffirmativeAction(value,BULK_ACTIONS);
}

function isRawSystemMaterial(value) {
  if (!matchesAny(value,SYSTEM_MATERIAL_TERMS)) return false;
  if (!matchesAny(value,SYSTEM_QUALIFIERS)&&!matchesAny(value,INHERENT_RAW_SYSTEM_TERMS)) return false;
  const developmentOnly=matchesAny(value,SYSTEM_DEVELOPMENT_CONTEXT)&&!matchesAny(value,SYSTEM_PRESENTATION_CONTEXT);
  if (developmentOnly) return false;
  return matchesAny(value,SYSTEM_DISCLOSURE_CONTEXT)||hasAffirmativeAction(value,/(?:发送|上传|提交|导出|读取|粘贴|提供)/u);
}

function hasAffirmativeAction(value,pattern) {
  const matcher=new RegExp(pattern.source,`${pattern.flags.replace("g","")}g`);
  for (const match of value.matchAll(matcher)) {
    const prefix=value.slice(Math.max(0,match.index-10),match.index);
    if (!/(?:不要|不能|不得|禁止|避免|无需|不再|请勿|没有|未)[^，。；,;]{0,5}$/u.test(prefix)) return true;
  }
  return false;
}

function matchesAny(value,patterns) { return patterns.some(pattern=>pattern.test(value)); }
function withoutLocalNegations(value,patterns) {
  let active=value;
  for (const pattern of patterns) active=active.replace(new RegExp(pattern.source,`${pattern.flags.replace("g","")}g`),"");
  return active;
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
function* strings(value) {
  if (typeof value==="string") { yield value; return; }
  if (Array.isArray(value)) { for (const item of value) yield* strings(item); return; }
  if (value&&typeof value==="object") for (const item of Object.values(value)) yield* strings(item);
}
function reject() { throw new Error("ai_input_rejected"); }
