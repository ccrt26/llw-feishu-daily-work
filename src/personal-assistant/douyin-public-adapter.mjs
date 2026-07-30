import {rm} from "node:fs/promises";
import {isAbsolute,resolve,sep} from "node:path";
import {
  createBilibiliConnectionBoundFetch
} from "./bilibili-public-adapter.mjs";
import {
  normalizeDouyinVideoUrl
} from "./douyin-webkit-reader-adapter.mjs";

const SHORT_HOST="v.douyin.com";
const SHORT_TOKEN=/^[A-Za-z0-9_-]{1,64}$/u;
const REDIRECT_STATUS=new Set([301,302,303,307,308]);
const MAX_REDIRECTS=3;
const SHA256=/^[a-f0-9]{64}$/u;
const MAX_DURATION_MS=5*60*60*1_000-1;
const MAX_AUDIO_BYTES=32*1024*1024;
const MAX_VIDEO_BYTES=128*1024*1024;
const RESULT_KEYS=[
  "audio","canonicalUrl","durationMs","limitations",
  "mediaId","platform","video"
];
const AUDIO_KEYS=[
  "byteSize","detectedMime","durationMs","file","format","sha256"
];
const VIDEO_KEYS=[
  "byteSize","detectedMime","durationMs","file","format",
  "height","sha256","width"
];

export function createDouyinPublicAdapter({
  reader,
  fetchImpl=createBilibiliConnectionBoundFetch()
}={}) {
  if (!plain(reader)||typeof reader.read!=="function"||
      typeof fetchImpl!=="function") {
    throw safeError("douyin_media_invalid");
  }
  return Object.freeze({
    async prepare(input) {
      let result;
      let request;
      try {
        request=await validateInput(input,fetchImpl);
        result=await reader.read({
          url:request.canonicalUrl,
          workspaceDir:request.workspaceDir,
          signal:request.signal
        });
        validateResult(result,request);
        if (result.limitations.includes("bounded_audio_prefix")) {
          throw safeError("douyin_complete_audio_unavailable");
        }
        if (result.limitations.includes("bounded_video_prefix")) {
          throw safeError("douyin_complete_video_unavailable");
        }
        return Object.freeze({
          platform:"douyin",
          mediaId:result.mediaId,
          canonicalUrl:result.canonicalUrl,
          durationMs:result.durationMs,
          audio:freezeMedia(result.audio),
          video:freezeMedia(result.video),
          limitations:Object.freeze([...result.limitations])
        });
      } catch (error) {
        if (request&&result) {
          await cleanupRejectedResult(result,request.workspaceDir);
        }
        throw normalizeError(error);
      }
    }
  });
}

async function validateInput(input,fetchImpl) {
  if (
    !plain(input)||
    typeof input.workspaceDir!=="string"||
    !isAbsolute(input.workspaceDir)||
    !(input.signal===undefined||input.signal instanceof AbortSignal)
  ) {
    throw safeError("douyin_url_invalid");
  }
  const normalized=await resolveDouyinVideoUrl({
    value:input.url,fetchImpl,signal:input.signal
  });
  return Object.freeze({
    ...normalized,
    workspaceDir:input.workspaceDir,
    signal:input.signal
  });
}

async function resolveDouyinVideoUrl({value,fetchImpl,signal}) {
  try {
    return normalizeDouyinVideoUrl(value);
  } catch {}
  let current=normalizeShareUrl(value);
  for (let redirects=0;redirects<MAX_REDIRECTS;redirects++) {
    let response;
    try {
      response=await fetchImpl(current.href,{
        method:"GET",
        redirect:"manual",
        signal,
        headers:{
          Accept:"text/html,application/xhtml+xml",
          "User-Agent":"Mozilla/5.0"
        }
      });
    } catch {
      signal?.throwIfAborted();
      throw safeError("douyin_media_unavailable");
    }
    if (!validResponse(response)||
        !REDIRECT_STATUS.has(response.status)) {
      await response?.body?.cancel?.().catch(()=>{});
      throw safeError("douyin_media_unavailable");
    }
    const location=response.headers.get("location");
    await response.body?.cancel?.().catch(()=>{});
    if (typeof location!=="string"||!location) {
      throw safeError("douyin_media_unavailable");
    }
    let next;
    try {
      next=new URL(location,current);
    } catch {
      throw safeError("douyin_media_unavailable");
    }
    const canonical=canonicalRedirect(next);
    if (canonical) return canonical;
    current=normalizeShareUrl(next.href,"douyin_media_unavailable");
  }
  throw safeError("douyin_media_unavailable");
}

function normalizeShareUrl(value,code="douyin_url_invalid") {
  let url;
  try {
    url=new URL(value);
  } catch {
    throw safeError(code);
  }
  const token=url.pathname.replace(/^\/|\/$/gu,"");
  if (
    url.protocol!=="https:"||url.hostname!==SHORT_HOST||
    url.port||url.username||url.password||url.search||url.hash||
    !SHORT_TOKEN.test(token)||url.pathname!==`/${token}/`
  ) {
    throw safeError(code);
  }
  return url;
}

function canonicalRedirect(url) {
  if (
    url.protocol==="https:"&&url.hostname==="www.iesdouyin.com"&&
    !url.port&&!url.username&&!url.password&&!url.hash
  ) {
    const match=/^\/share\/video\/([1-9][0-9]{9,23})\/$/u
      .exec(url.pathname);
    if (match) {
      return normalizeDouyinVideoUrl(
        `https://www.douyin.com/video/${match[1]}`
      );
    }
  }
  if (
    url.protocol!=="https:"||url.hostname!=="www.douyin.com"||
    url.port||url.username||url.password||url.hash
  ) {
    return null;
  }
  if (
    url.search&&
    url.search!=="?previous_page=app_code_link"
  ) {
    return null;
  }
  try {
    return normalizeDouyinVideoUrl(
      `https://www.douyin.com${url.pathname}`
    );
  } catch {
    return null;
  }
}

function validResponse(value) {
  return value&&typeof value==="object"&&
    Number.isInteger(value.status)&&
    value.headers&&typeof value.headers.get==="function";
}

function validateResult(value,request) {
  if (
    !plain(value)||!exactKeys(value,RESULT_KEYS)||
    value.platform!=="douyin"||
    value.mediaId!==request.mediaId||
    value.canonicalUrl!==request.canonicalUrl||
    !boundedInteger(value.durationMs,1,MAX_DURATION_MS)||
    !Array.isArray(value.limitations)||
    value.limitations.length>16||
    value.limitations.some(item=>
      typeof item!=="string"||
      Buffer.byteLength(item,"utf8")>256
    )
  ) {
    throw safeError("douyin_media_invalid");
  }
  validateMedia(value.audio,"audio",value.durationMs);
  validateMedia(value.video,"video",value.durationMs);
}

function validateMedia(value,kind,durationMs) {
  const keys=kind==="audio"?AUDIO_KEYS:VIDEO_KEYS;
  const expected=kind==="audio"
    ?{mime:"audio/mp4",format:"m4a",max:MAX_AUDIO_BYTES}
    :{mime:"video/mp4",format:"mp4",max:MAX_VIDEO_BYTES};
  if (
    !plain(value)||!exactKeys(value,keys)||
    typeof value.file!=="string"||!isAbsolute(value.file)||
    !boundedInteger(value.byteSize,1,expected.max)||
    typeof value.sha256!=="string"||!SHA256.test(value.sha256)||
    value.detectedMime!==expected.mime||
    value.format!==expected.format||
    !boundedInteger(value.durationMs,1,MAX_DURATION_MS)||
    Math.abs(value.durationMs-durationMs)>5_000
  ) {
    throw safeError("douyin_media_invalid");
  }
  if (
    kind==="video"&&(
      !boundedInteger(value.width,1,7680)||
      !boundedInteger(value.height,1,4320)
    )
  ) {
    throw safeError("douyin_media_invalid");
  }
}

async function cleanupRejectedResult(result,workspaceDir) {
  const root=resolve(workspaceDir);
  for (const file of [result?.audio?.file,result?.video?.file]) {
    if (
      typeof file==="string"&&isAbsolute(file)&&
      resolve(file).startsWith(`${root}${sep}`)
    ) {
      await rm(file,{force:true}).catch(()=>{});
    }
  }
}

function freezeMedia(value) {
  return Object.freeze({...value});
}

function exactKeys(value,expected) {
  return JSON.stringify(Object.keys(value).sort())===
    JSON.stringify([...expected].sort());
}

function boundedInteger(value,min,max) {
  return Number.isSafeInteger(value)&&value>=min&&value<=max;
}

function plain(value) {
  if (!value||typeof value!=="object"||Array.isArray(value)) {
    return false;
  }
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype||prototype===null;
}

function safeError(code) {
  return new Error(code);
}

function normalizeError(error) {
  if (error?.name==="AbortError") return error;
  switch (error?.message) {
  case "douyin_url_invalid":
  case "douyin_limit_exceeded":
  case "douyin_media_invalid":
  case "douyin_complete_audio_unavailable":
  case "douyin_complete_video_unavailable":
    return safeError(error.message);
  case "douyin_helper_invalid":
    return safeError("douyin_media_invalid");
  default:
    return safeError("douyin_media_unavailable");
  }
}
