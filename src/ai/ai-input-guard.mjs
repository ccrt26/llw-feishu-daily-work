const MAX_INPUT_BYTES=32 * 1024;
const ROUTER_ROOT=new Set(["message","conversation","capabilities"]);
const ROUTER_CONVERSATION=new Set(["capability","question","startedAt"]);
const ROUTING_CONTRACT=new Set(["capability","purpose","accepts","positive_examples","negative_examples","supports_continuation"]);
const DAILY_ROOT=new Set(["message","conversation","candidates"]);
const DAILY_MESSAGE=new Set(["ok","messageId","text","createTime"]);
const DAILY_CONVERSATION=new Set(["id","status","turns","candidateIds","model"]);
const DAILY_TURN=new Set(["role","text","createTime"]);
const DAILY_CANDIDATE=new Set(["record_id","date","occurred_time","occurred_end_time","title","people","location","summary","follow_ups"]);

const FORBIDDEN_PATTERNS=[
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/iu,
  /\bBearer\s+(?!(?:Token\s*)?(?:是什么|的(?:格式|含义|用途)是什么)[？?]?\s*$)[^\s]+/iu,
  /\bAuthorization\s*:\s*(?:Bearer|Token|Basic)\s+(?!(?:Token\s*)?(?:是什么|的(?:格式|含义|用途)是什么)[？?]?\s*$)\S+/iu,
  /\b(?:api[_ -]?key|client[_ -]?secret|token|access[_ -]?token|refresh[_ -]?token|credential(?:s)?|private[_ -]?key|session[_ -]?cookie|ssh[_ -]?key|mfa[_ -]?(?:secret|key)|recovery[_ -]?code|otp|password|passwd|pwd)(?:[_\s-]?value)?\b\s*(?:[:=：]|is|equals|是|为|等于)\s*(?!什么[？?]?\s*$)\S+/iu,
  /(?:密码|凭证|凭据|口令|恢复码|恢复代码|动态验证码|验证码|访问令牌|刷新令牌|会话\s*Cookie|私钥|API\s*密钥|SSH\s*(?:Key|密钥)|MFA\s*[密秘]钥|多因素认证(?:种子|密钥|秘钥)|支付密码|转账口令|授权信息|网银登录信息)\s*(?:内容\s*)?(?:[:=：]|是|为|等于|如下)\s*(?!什么[？?]?\s*$)\S+/iu,
  /(?:微信|飞书|邮箱|云服务|云平台)(?:的)?(?:登录|认证)(?:凭证|凭据|密码|信息)\s*(?:[:=：]|是|为|等于|如下)\s*(?!什么[？?]?\s*$)\S+/u,
  /登录(?:微信|飞书|邮箱|云服务|云平台)用的(?:令牌|凭证|口令)\s*(?:[:=：]|是|为|等于)\s*\S+/u,
  /(?:我的)?(?:登录)?密码\s*(?:是|为|等于)\s*(?!什么[？?]?\s*$)\S+/u,
  /(?:短信|动态)?验证码\s*(?:是|为)\s*\d{4,8}\b/u,
  /(?:银行卡(?:完整)?卡号|银行卡号|信用卡(?:完整)?(?:号码|卡号)|卡号|credit\s*card)\s*(?:[:=：]|是|为|等于)?\s*(?:\d[ -]?){13,19}/iu,
  /\bcard[_ -]?number\s*[:=]\s*(?:\d[ -]?){13,19}\b/iu,
  /(?:我的)?银行卡(?:号)?\s*(?:是|为|[:=：])?\s*(?:\d[ -]?){13,19}/u,
  /\b(?:cvv|cvc|pin)\b\s*(?:[:=：]|是|为|等于)\s*\d{3,8}\b/iu,
  /银行卡\s*PIN\s*码?\s*(?:[:=：]|是|为|等于)\s*\d{3,8}\b/iu,
  /安全码\s*(?:[:=：]|是|为|等于)\s*\d{3,8}\b/u,
  /\bsecurity\s+code\s*[:=]\s*\d{3,8}\b/iu,
  /卡背面(?:的)?三位安全数字\s*(?:[:=：]|是|为|等于)\s*\d{3}\b/u,
  /转账的?授权代码\s*(?:[:=：]|是|为|等于)\s*\S+/u,
  /(?:密级\s*[:=：]\s*(?:绝密|机密|秘密|保密)|内部禁止外发|禁止外发)/u,
  /密级\s*(?:[:=：]|是|为|等于)\s*[“”"']?(?:绝密|机密|秘密|保密)[“”"']?/u,
  /(?:【(?:绝密|机密|秘密|保密)】|\[(?:绝密|机密|秘密|保密)\])/u,
  /(?<!不是)(?<!并非)(?<!不属于)(?:绝密|机密|秘密|保密)(?:级|等级)?的?(?:项目|资料|文件|内容|原文|合同|信息)/u,
  /(?:文档|资料|文件|项目|合同|内容)\s*标有\s*(?:绝密|机密|秘密|保密)字样/u,
  /(?:文档|资料|文件|项目|合同|内容)\s*(?:已)?(?:标记|标注|注明)为\s*(?:绝密|机密|秘密|保密)/u,
  /(?:本文档|文档|资料|文件)\s*(?:注明|标明|标注)\s*[:=：]?\s*(?:绝密|机密|秘密|保密)/u,
  /(?:文档|资料|文件|项目|合同|内容)\s*(?:密级\s*)?(?:是|为|等于|属于)\s*(?:绝密|机密|秘密|保密)(?:资料|文件|内容)?/u,
  /(?:内部|公司|客户|项目|第三方)?资料\s*(?:不得|禁止|严禁)\s*(?:对外|向外部\s*AI\s*)?外发/u,
  /(?:禁止|不得|严禁)(?:将)?(?:此|该|本)?资料(?:对外|向外部\s*AI)?(?:提供|发送|传播|披露)/u,
  /(?:公司制度明确禁止交给外部\s*AI|(?:用户)?无权授权(?:处理(?:这份)?)?的?第三方资料|受(?:合同保密义务|监管义务|保密义务|合同|监管)(?:[、，或和](?:合同保密义务|监管义务|保密义务|合同|监管)){0,2}明确限制的原文)/u,
  /(?:根据合同不得向外部\s*AI\s*提供(?:这段)?原文|监管(?:规定|要求)(?:不允许|不得|禁止)外发|客户资料未经授权不得交给外部\s*AI|第三方(?:没有|未)授权(?:我)?处理)/u,
  /(?:保密协议要求原文(?:不能|不得|禁止)外发|监管要求不得把原文发给(?:外部\s*AI|模型)|没有得到第三方授权[，,]?请勿处理)/u,
  /(?:依据|根据)?\s*NDA[，,]?(?:这些)?内容(?:不得|不能|禁止)对外披露/iu,
  /监管限制\s*[:=：]?(?:禁止|不得|不允许)把原文发送给\s*(?:AI|模型)/u,
  /未经资料所有者(?:授权|许可)[，,]?(?:不能|不得|禁止)交给外部(?:\s*AI|模型)/u,
  /(?:security\s+dump-keychain|keychain\s+(?:export|导出)|keychain\s*导出文件|导出(?:登录)?钥匙串|导出\s*keychain|钥匙串导出|钥匙串备份文件|导出\s*macOS\s*钥匙串数据库|(?:发送|上传|读取|导出|粘贴|提供)系统环境变量|未脱敏(?:的)?(?:完整)?环境变量|(?:发送|上传|读取|导出|粘贴|提供)(?:全部|完整)环境变量|完整的?环境变量清单(?:如下|内容)|\benv\b.{0,12}(?:全部|完整)(?:内容|变量)|\.env\s*文件.{0,12}(?:原样|完整).{0,8}(?:发送|发|交给)(?:给)?\s*(?:AI|模型)|未脱敏(?:的)?(?:系统)?日志|(?:发送|上传|读取|粘贴|提供)完整系统日志|原始\s*syslog\s*(?:内容)?(?:如下|[:=：])|(?:发送|上传|读取|导出|提供)\s*(?:浏览器配置|(?:Chrome|Safari|Firefox)\s*(?:用户数据目录|Cookie\s*数据))|浏览器用户配置目录(?:打包|导出|发送)|未脱敏(?:的)?\s*(?:core|crash)\s*dump|(?:core|crash|崩溃)\s*dump.{0,12}(?:中有|里有|含有|包含)\s*(?:Token|密钥|密码)|(?:core|crash)\s*dump\s+contains\s+(?:API\s*key|token|password)|(?:包含|含有)\s*(?:Token|密钥|密码)\s*的?\s*(?:崩溃转储|(?:core|crash)\s*dump)|(?:发送|上传|读取|提供)原始\s*(?:凭证|secrets?)\s*(?:目录|文件夹)|读取原始\s*token\s*存储目录)/iu,
  /(?:包含|含有)(?:访问令牌|刷新令牌|Token|API\s*Key|密码|私钥|凭证)(?:信息)?的?原始配置文件/iu,
  /(?:可直接)?(?:完成)?(?:支付|转账)的?(?:支付)?二维码/u,
  /(?:收款|付款|支付)?二维码.{0,12}(?:就能|可以|可)(?:直接)?(?:完成|进行)?(?:支付|转账|扣款)/u,
  /(?:付款码|支付码).{0,12}(?:可以|可|能够)?直接(?:扣款|付款|支付|转账)/u,
  /(?:付款|支付|收款)二维码.{0,12}扫码后?(?:自动|直接)(?:扣费|扣款|支付|转账)/u,
  /(?:^|\n)(?:PATH|HOME|USER|SHELL|AWS_[A-Z0-9_]*|OPENAI_[A-Z0-9_]*|ANTHROPIC_[A-Z0-9_]*|DEEPSEEK_[A-Z0-9_]*)=/u,
  /(?:^|\n)\s*(?:\d{4}-\d{2}-\d{2}[T ][^\n]{0,60}\b(?:INFO|WARN|ERROR|DEBUG)\b|\[(?:INFO|WARN|ERROR|DEBUG)\])/iu,
  /(?:身份证正反面原图|护照完整页|驾驶证完整页|社保卡原图|银行卡原图|身份认证(?:人脸|指纹)|生物识别材料)/u,
  /(?:身份证(?:的)?(?:正面和背面|正反(?:两)?面)|完整身份证正反面)(?:原图|照片|扫描件)/u,
  /身份证正\s*[、,，和]?\s*反面(?:的)?(?:高清)?(?:图|照片|扫描件|原图)/u,
  /(?:整页护照|护照(?:完整页|整页|资料页))(?:原图|照片|扫描件)?/u,
  /(?:驾驶证|驾驶执照|驾照)(?:完整页|整页|全页)(?:原图|照片|扫描件|截图)?/u,
  /(?:社保卡|社会保障卡|银行卡)(?:的)?(?:正反面)?(?:原图|照片|扫描件)|完整的?银行卡(?:原图|照片|扫描件)/u,
  /(?:刷脸|人脸(?:识别)?)(?:身份|实名)?认证(?:材料|素材|视频|照片)|用于实名认证的?人脸(?:材料|素材|视频|照片)|(?:用于)?认证(?:的)?指纹(?:材料|模板|数据)|(?:虹膜|声纹)认证(?:材料|素材|样本|模板|数据)/u,
  /(?:(?<![A-Za-z0-9_:/])\/(?!\/)\S+|(?<![A-Za-z0-9_])[A-Za-z]:[\\/]\S+|\\\\[^\\\s]+\\[^\\\s]+|(?<!:)\/\/[^/\s]+\/\S+)/u,
  /\b(?:sender|chat|message|event|resource|file|image)[_-]?(?:id|key)\s*(?:[:=：]|\s+是)\s*\S+/iu,
  /\b(?:ou|oc|om|on|cli|file|img)_[A-Za-z0-9][A-Za-z0-9_-]{5,}\b/iu,
  /(?:整个|全部|全量|所有)(?:\s*Obsidian\s*Vault|\s*Vault|邮箱|客户目录|项目目录|目录|文件夹|历史资料|历史消息|文件)/iu,
  /(?:与当前任务无关|无关当前任务)的?(?:批量|大量)(?:文件|资料)/u,
  /(?:邮件|邮箱).{0,12}(?:全部|所有).{0,12}(?:发送|交给)(?:给)?\s*(?:外部\s*)?(?:AI|模型)/iu,
  /整个(?:邮件|邮箱)(?:账户|账号)?\s*(?:发送|交给)(?:给)?\s*(?:AI|模型)/iu,
  /邮箱.{0,8}每封邮件.{0,8}(?:都)?(?:给|发送给|交给)\s*(?:AI|模型)/iu,
  /(?:客户文件夹|客户目录).{0,12}(?:所有|全部|整个)内容/u,
  /(?:客户文件夹|客户目录).{0,12}(?:每一个|所有|全部)(?:文件|内容)/u,
  /递归(?:读取|扫描|导入)(?:整个)?客户(?:目录|文件夹)/u,
  /项目资料\s*(?:全部|全|全量)\s*(?:发送|发|交给)(?:给)?(?:AI|模型)/u,
  /项目(?:目录|文件夹).{0,8}(?:打包|全部|整个).{0,8}(?:交给|发送给|给)(?:AI|模型)/u,
  /(?:一次性)?上传(?:我)?(?:所有|全部)的?(?:旧资料|历史资料|历史消息)/u,
  /(?:所有|全部)(?:旧|历史)(?:聊天记录|资料|消息).{0,12}(?:一次|一次性).{0,12}(?:AI|模型)/u,
  /(?:导入|上传|发送)(?:全部|所有)(?:往年|历年|历史|旧)(?:资料|消息|文件)/u,
  /导入过去.{0,8}年的?(?:全部|所有)(?:记录|资料|消息|文件)/u,
  /(?:一口气|一次性)上传(?:全部|所有)(?:聊天备份|聊天记录备份|历史备份)/u,
  /Vault\s*根目录(?:的)?(?:全部|所有|整个)内容/iu,
  /(?:一万|\d{4,})个?(?:与当前任务无关|与任务无关)的?(?:附件|文件)/u
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
    for (const value of strings(prepared.context)) for (const pattern of FORBIDDEN_PATTERNS) if (pattern.test(value)) reject();
    return prepared;
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
