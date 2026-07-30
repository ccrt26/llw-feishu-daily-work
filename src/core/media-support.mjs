const UNSUPPORTED_MEDIA_EXTENSIONS=new Set([
  "aac","aif","aiff","avi","flac","m4a","m4v","mkv",
  "mov","mp3","mp4","ogg","opus","wav","webm"
]);
const NATIVE_VOICE_EXTENSIONS=new Set(["amr","silk"]);
const AUDIO_EXTENSIONS=new Set([
  "aac","aif","aiff","flac","m4a","mp3","ogg","opus","wav"
]);
const VIDEO_EXTENSIONS=new Set([
  "avi","m4v","mkv","mov","mp4","webm"
]);
const GATE_FIELDS=[
  "nativeVoiceEnabled","audioFileEnabled","localVideoEnabled",
  "webPageEnabled","bilibiliEnabled","douyinEnabled"
];

export const DEFAULT_MEDIA_INPUT_GATES=Object.freeze(
  Object.fromEntries(GATE_FIELDS.map(field=>[field,false]))
);

export function isUnsupportedMediaExtension(value) {
  if (typeof value!=="string") return false;
  return UNSUPPORTED_MEDIA_EXTENSIONS.has(
    value.trim().toLowerCase().replace(/^\./u,"")
  );
}

export function normalizeMediaInputGates(value) {
  if (!value||typeof value!=="object"||Array.isArray(value)||
      Object.keys(value).length!==GATE_FIELDS.length||
      Object.keys(value).some(field=>!GATE_FIELDS.includes(field))||
      GATE_FIELDS.some(field=>typeof value[field]!=="boolean")) {
    throw new Error("media_input_gates_invalid");
  }
  return Object.freeze(structuredClone(value));
}

export function classifyDisabledMediaInput(message,gates) {
  const policy=normalizeMediaInputGates(gates);
  for (const attachment of message?.attachments||[]) {
    const extension=normalizeExtension(
      attachment?.extension||
      attachment?.displayName?.split(".").at(-1)
    );
    if (NATIVE_VOICE_EXTENSIONS.has(extension)&&
        !policy.nativeVoiceEnabled) {
      return "native_voice_disabled";
    }
    if (AUDIO_EXTENSIONS.has(extension)&&
        !policy.audioFileEnabled) {
      return "audio_file_disabled";
    }
    if (VIDEO_EXTENSIONS.has(extension)&&
        !policy.localVideoEnabled) {
      return "local_video_disabled";
    }
  }
  const urls=publicUrls(message?.instructionText);
  if (urls.some(url=>isBilibili(url.hostname))) {
    return policy.bilibiliEnabled?null:"bilibili_disabled";
  }
  if (urls.some(url=>isDouyin(url.hostname))) {
    return policy.douyinEnabled?null:"douyin_disabled";
  }
  if (urls.some(url=>!isExistingFeishuDocumentHost(url.hostname))) {
    return policy.webPageEnabled?null:"web_page_disabled";
  }
  return null;
}

function publicUrls(value) {
  if (typeof value!=="string") return [];
  const result=[];
  for (const match of value.matchAll(
    /https?:\/\/[^\s<>()\[\]{}，。；！？、）》】”’"']+/giu
  )) {
    try {
      const url=new URL(match[0]);
      if (new Set(["http:","https:"]).has(url.protocol)) {
        result.push(url);
      }
    } catch {}
  }
  return result;
}

function isBilibili(hostname) {
  return domain(hostname,"bilibili.com")||
    domain(hostname,"b23.tv");
}

function isDouyin(hostname) {
  return domain(hostname,"douyin.com")||
    domain(hostname,"iesdouyin.com");
}

function isExistingFeishuDocumentHost(hostname) {
  return domain(hostname,"feishu.cn")||
    domain(hostname,"larksuite.com");
}

function domain(hostname,suffix) {
  const value=hostname.toLowerCase();
  return value===suffix||value.endsWith(`.${suffix}`);
}

function normalizeExtension(value) {
  return typeof value==="string"
    ?value.trim().toLowerCase().replace(/^\./u,"")
    :"";
}
