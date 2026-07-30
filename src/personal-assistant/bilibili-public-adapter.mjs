import {lookup as dnsLookup} from "node:dns/promises";
import {lstat,rm} from "node:fs/promises";
import {request as httpsRequest} from "node:https";
import {isIP} from "node:net";
import {isAbsolute,join} from "node:path";
import {Readable} from "node:stream";
import {
  streamSourceToWorkspace
} from "./source-stream.mjs";

const PAGE_HOST="www.bilibili.com";
const SHORT_HOST="b23.tv";
const API_HOST="api.bilibili.com";
const MEDIA_SUFFIX="bilivideo.com";
const VIEW_PATH="/x/web-interface/view";
const PLAY_PATH="/x/player/playurl";
const MAX_REDIRECTS=3;
const MAX_CONTROL_BYTES=2*1024*1024;
const MAX_AUDIO_BYTES=32*1024*1024;
const MAX_VIDEO_BYTES=128*1024*1024;
const MAX_DURATION_MS=30*60*1_000;
const MAX_JSON_DEPTH=16;
const MAX_JSON_ENTRIES=16_384;
const MAX_JSON_TEXT_BYTES=1024*1024;
const BVID=/^BV[A-Za-z0-9]{10}$/u;
const SHORT_TOKEN=/^[A-Za-z0-9_-]{1,64}$/u;
const REDIRECT_STATUS=new Set([301,302,303,307,308]);
const SAFE_CODES=new Set([
  "bilibili_url_invalid",
  "bilibili_access_denied",
  "bilibili_control_invalid",
  "bilibili_media_unavailable",
  "bilibili_media_invalid",
  "bilibili_limit_exceeded"
]);

export function createBilibiliConnectionBoundFetch({
  lookupAll=defaultLookupAll,
  requestImpl=httpsRequest
}={}) {
  if (typeof lookupAll!=="function"||typeof requestImpl!=="function") {
    throw safeError("bilibili_control_invalid");
  }
  return async(url,options={})=>{
    let parsed;
    try {
      parsed=new URL(url);
    } catch {
      throw safeError("bilibili_access_denied");
    }
    if (parsed.protocol!=="https:"||
        parsed.port&&parsed.port!=="443"||
        parsed.username||parsed.password||parsed.hash) {
      throw safeError("bilibili_access_denied");
    }
    throwIfAborted(options.signal);
    const addresses=await resolvePublicAddresses(
      parsed.hostname,lookupAll
    );
    const pinnedLookup=(_hostname,lookupOptions,callback)=>{
      if (typeof lookupOptions==="function") {
        callback=lookupOptions;
        lookupOptions={};
      }
      if (typeof callback!=="function") return;
      if (lookupOptions?.all===true) {
        callback(null,addresses.map(item=>({...item})));
        return;
      }
      callback(null,addresses[0].address,addresses[0].family);
    };
    return new Promise((resolve,reject)=>{
      let request;
      try {
        request=requestImpl(parsed,{
          method:options.method,
          headers:options.headers,
          signal:options.signal,
          servername:parsed.hostname,
          lookup:pinnedLookup
        },response=>{
          try {
            resolve(toFetchResponse(response));
          } catch (error) {
            response.destroy?.();
            reject(error);
          }
        });
        request.once("error",reject);
        request.end();
      } catch (error) {
        request?.destroy?.();
        reject(error);
      }
    });
  };
}

export function createBilibiliPublicAdapter({
  fetchImpl,
  lookupAll=defaultLookupAll,
  requestImpl=httpsRequest,
  inspectMediaHeader
}={}) {
  if (!(fetchImpl===undefined||typeof fetchImpl==="function")||
      typeof lookupAll!=="function"||
      typeof requestImpl!=="function"||
      typeof inspectMediaHeader!=="function") {
    throw safeError("bilibili_control_invalid");
  }
  const requestFetch=fetchImpl===undefined
    ?createBilibiliConnectionBoundFetch({lookupAll,requestImpl})
    :createDnsPreflightFetch({fetchImpl,lookupAll});
  return Object.freeze({
    async prepare(input) {
      let audioPublished=false;
      let videoPublished=false;
      let audioFile;
      let videoFile;
      try {
        const request=validatePrepareInput(input);
        const page=await resolvePage({
          initial:request.url,
          fetchImpl:requestFetch,
          signal:request.signal
        });
        const controlHeaders=fixedHeaders(page.canonicalUrl);
        const view=await fetchControlJson({
          url:viewUrl(page.mediaId),
          fetchImpl:requestFetch,
          headers:controlHeaders,
          signal:request.signal
        });
        const metadata=parseView(view,page.mediaId);
        const play=await fetchControlJson({
          url:playUrl(page.mediaId,metadata.cid),
          fetchImpl:requestFetch,
          headers:controlHeaders,
          signal:request.signal
        });
        const selected=parsePlay(play,metadata.durationMs);
        await validateWorkspace(request.workspaceDir);

        audioFile=join(request.workspaceDir,"bilibili-audio.m4a");
        videoFile=join(request.workspaceDir,"bilibili-video.mp4");
        const audioResponse=await fetchMedia({
          initial:selected.audio.url,
          canonicalUrl:page.canonicalUrl,
          fetchImpl:requestFetch,
          signal:request.signal
        });
        const audio=await streamSourceToWorkspace({
          input:toNodeStream(audioResponse.body),
          destination:audioFile,
          maxBytes:MAX_AUDIO_BYTES,
          signal:request.signal,
          inspectHeader:inspectionFor({
            inspectMediaHeader,
            kind:"audio",
            durationMs:selected.durationMs
          })
        });
        audioPublished=true;
        validatePublished({
          result:audio,kind:"audio",durationMs:selected.durationMs
        });

        const videoResponse=await fetchMedia({
          initial:selected.video.url,
          canonicalUrl:page.canonicalUrl,
          fetchImpl:requestFetch,
          signal:request.signal
        });
        const video=await streamSourceToWorkspace({
          input:toNodeStream(videoResponse.body),
          destination:videoFile,
          maxBytes:MAX_VIDEO_BYTES,
          signal:request.signal,
          inspectHeader:inspectionFor({
            inspectMediaHeader,
            kind:"video",
            durationMs:selected.durationMs
          })
        });
        videoPublished=true;
        validatePublished({
          result:video,kind:"video",durationMs:selected.durationMs
        });

        return Object.freeze({
          platform:"bilibili",
          mediaId:page.mediaId,
          canonicalUrl:page.canonicalUrl,
          durationMs:selected.durationMs,
          audio:publishedResult(audioFile,audio),
          video:publishedResult(videoFile,video),
          limitations:Object.freeze(unique([
            ...audio.limitations,...video.limitations
          ]))
        });
      } catch (error) {
        if (videoPublished) {
          await rm(videoFile,{force:true}).catch(()=>{});
        }
        if (audioPublished) {
          await rm(audioFile,{force:true}).catch(()=>{});
        }
        throw normalizeError(error);
      }
    }
  });
}

async function resolvePage({
  initial,fetchImpl,signal
}) {
  let current=validateUserPageUrl(initial,true);
  if (current.hostname===PAGE_HOST) return canonicalPage(current);

  for (let redirects=0;redirects<=MAX_REDIRECTS;redirects++) {
    const response=await safeFetch(
      fetchImpl,current.href,{
        method:"GET",
        redirect:"manual",
        signal,
        headers:{
          Accept:"text/html,application/xhtml+xml",
          "User-Agent":"Mozilla/5.0"
        }
      },
      "bilibili_access_denied"
    );
    if (!REDIRECT_STATUS.has(response.status)) {
      await cancelBody(response);
      throw safeError("bilibili_access_denied");
    }
    await cancelBody(response);
    if (redirects>=MAX_REDIRECTS) {
      throw safeError("bilibili_access_denied");
    }
    const location=response.headers.get("location");
    if (typeof location!=="string"||!location) {
      throw safeError("bilibili_access_denied");
    }
    let next;
    try {
      next=new URL(location,current);
    } catch {
      throw safeError("bilibili_access_denied");
    }
    current=validateUserPageUrl(next.href,false);
    if (current.hostname===PAGE_HOST) return canonicalPage(current);
  }
  throw safeError("bilibili_access_denied");
}

async function fetchControlJson({
  url,fetchImpl,headers,signal
}) {
  const parsed=new URL(url);
  if (parsed.protocol!=="https:"||parsed.hostname!==API_HOST||
      parsed.port||parsed.username||parsed.password||parsed.hash) {
    throw safeError("bilibili_control_invalid");
  }
  const response=await safeFetch(
    fetchImpl,parsed.href,{
      method:"GET",
      redirect:"manual",
      signal,
      headers
    },
    "bilibili_access_denied"
  );
  if (!response.ok||REDIRECT_STATUS.has(response.status)) {
    await cancelBody(response);
    throw safeError("bilibili_access_denied");
  }
  const contentType=response.headers.get("content-type")||"";
  if (!/^application\/json(?:;|$)/iu.test(contentType)) {
    await cancelBody(response);
    throw safeError("bilibili_control_invalid");
  }
  const value=await readBoundedJson(response.body,signal);
  validateJsonBounds(value);
  return value;
}

function parseView(value,mediaId) {
  const data=value?.data;
  if (!plain(value)||value.code!==0||!plain(data)||
      data.bvid!==mediaId||
      !Number.isSafeInteger(data.cid)||data.cid<1||
      !Number.isSafeInteger(data.duration)||data.duration<1||
      data.duration*1_000>MAX_DURATION_MS||
      !Array.isArray(data.pages)||data.pages.length!==1) {
    throw safeError("bilibili_control_invalid");
  }
  const page=data.pages[0];
  if (!plain(page)||page.page!==1||
      !Number.isSafeInteger(page.cid)||page.cid<1||
      page.cid!==data.cid||
      !Number.isSafeInteger(page.duration)||page.duration<1||
      Math.abs(page.duration-data.duration)>5) {
    throw safeError("bilibili_control_invalid");
  }
  return Object.freeze({
    cid:data.cid,
    durationMs:data.duration*1_000
  });
}

function parsePlay(value,viewDurationMs) {
  const data=value?.data;
  const dash=data?.dash;
  if (!plain(value)||value.code!==0||!plain(data)||
      !Number.isSafeInteger(data.timelength)||
      data.timelength<1||data.timelength>MAX_DURATION_MS||
      Math.abs(data.timelength-viewDurationMs)>5_000||
      !plain(dash)||
      !Array.isArray(dash.audio)||!Array.isArray(dash.video)||
      dash.audio.length<1||dash.video.length<1||
      dash.audio.length>256||dash.video.length>256) {
    throw safeError("bilibili_control_invalid");
  }
  return Object.freeze({
    durationMs:data.timelength,
    audio:selectAudio(dash.audio),
    video:selectVideo(dash.video)
  });
}

function selectAudio(items) {
  const accepted=[];
  for (const item of items) {
    const representation=representationOf(item);
    if (!representation||
        representation.mimeType!=="audio/mp4"||
        representation.codecs!=="mp4a.40.2") {
      continue;
    }
    accepted.push(representation);
  }
  rejectDuplicateRepresentations(accepted);
  accepted.sort((left,right)=>
    left.bandwidth-right.bandwidth||
    left.id-right.id||
    left.url.localeCompare(right.url)
  );
  if (!accepted.length) throw safeError("bilibili_control_invalid");
  return accepted[0];
}

function selectVideo(items) {
  const accepted=[];
  for (const item of items) {
    const representation=representationOf(item);
    if (!representation||
        representation.mimeType!=="video/mp4"||
        !representation.codecs.startsWith("avc1.")||
        representation.id>32||
        !Number.isSafeInteger(item.width)||item.width<1||item.width>1_920||
        !Number.isSafeInteger(item.height)||item.height<1||item.height>1_080) {
      continue;
    }
    accepted.push(representation);
  }
  rejectDuplicateRepresentations(accepted);
  accepted.sort((left,right)=>
    right.id-left.id||
    left.bandwidth-right.bandwidth||
    left.url.localeCompare(right.url)
  );
  if (!accepted.length) throw safeError("bilibili_control_invalid");
  return accepted[0];
}

function representationOf(item) {
  if (!plain(item)||
      !Number.isSafeInteger(item.id)||item.id<1||
      !Number.isSafeInteger(item.bandwidth)||item.bandwidth<1||
      typeof item.codecs!=="string"||
      typeof item.mimeType!=="string") {
    return null;
  }
  const primary=item.baseUrl??item.base_url;
  const backups=item.backupUrl??item.backup_url??[];
  if (typeof primary!=="string"||
      !Array.isArray(backups)||backups.length>8||
      backups.some(value=>typeof value!=="string")) {
    return null;
  }
  let url;
  for (const candidate of [primary,...backups]) {
    try {
      validateMediaUrl(candidate);
      url=candidate;
      break;
    } catch {}
  }
  if (!url) return null;
  return {
    id:item.id,
    bandwidth:item.bandwidth,
    codecs:item.codecs,
    mimeType:item.mimeType,
    url
  };
}

async function fetchMedia({
  initial,canonicalUrl,fetchImpl,signal
}) {
  let current=validateMediaUrl(
    initial,"bilibili_media_unavailable"
  );
  for (let redirects=0;redirects<=MAX_REDIRECTS;redirects++) {
    const response=await safeFetch(
      fetchImpl,current.href,{
        method:"GET",
        redirect:"manual",
        signal,
        headers:fixedHeaders(canonicalUrl)
      },
      "bilibili_media_unavailable"
    );
    if (REDIRECT_STATUS.has(response.status)) {
      await cancelBody(response);
      if (redirects>=MAX_REDIRECTS) {
        throw safeError("bilibili_media_unavailable");
      }
      const location=response.headers.get("location");
      if (typeof location!=="string"||!location) {
        throw safeError("bilibili_media_unavailable");
      }
      let next;
      try {
        next=new URL(location,current);
      } catch {
        throw safeError("bilibili_media_unavailable");
      }
      current=validateMediaUrl(
        next.href,"bilibili_media_unavailable"
      );
      continue;
    }
    if (!response.ok||!response.body) {
      await cancelBody(response);
      throw safeError("bilibili_media_unavailable");
    }
    return response;
  }
  throw safeError("bilibili_media_unavailable");
}

function validatePrepareInput(input) {
  const {url,workspaceDir,signal}=input||{};
  if (typeof url!=="string"||
      typeof workspaceDir!=="string"||!isAbsolute(workspaceDir)||
      !(signal===undefined||signal instanceof AbortSignal)) {
    throw safeError("bilibili_url_invalid");
  }
  throwIfAborted(signal);
  return {
    url:validateUserPageUrl(url,true).href,
    workspaceDir,
    signal
  };
}

function validateUserPageUrl(value,first) {
  let url;
  try {
    url=new URL(value);
  } catch {
    throw safeError("bilibili_url_invalid");
  }
  if (url.protocol!=="https:"||
      url.port&&url.port!=="443"||
      url.username||url.password||url.hash) {
    throw safeError(first
      ?"bilibili_url_invalid"
      :"bilibili_access_denied");
  }
  if (url.hostname===PAGE_HOST) {
    if (first&&url.search) {
      throw safeError("bilibili_url_invalid");
    }
    canonicalPage(url);
    return url;
  }
  if (url.hostname===SHORT_HOST&&
      !url.search&&
      SHORT_TOKEN.test(url.pathname.slice(1))&&
      !url.pathname.slice(1).includes("/")) {
    return url;
  }
  throw safeError(first
    ?"bilibili_url_invalid"
    :"bilibili_access_denied");
}

function canonicalPage(url) {
  const match=/^\/video\/(BV[A-Za-z0-9]{10})\/?$/u.exec(url.pathname);
  if (url.hostname!==PAGE_HOST||!match||!BVID.test(match[1])) {
    throw safeError("bilibili_url_invalid");
  }
  return Object.freeze({
    mediaId:match[1],
    canonicalUrl:`https://${PAGE_HOST}/video/${match[1]}/`
  });
}

function validateMediaUrl(
  value,code="bilibili_control_invalid"
) {
  let url;
  try {
    url=new URL(value);
  } catch {
    throw safeError(code);
  }
  const host=url.hostname.toLowerCase();
  if (url.protocol!=="https:"||
      url.port&&url.port!=="443"||
      url.username||url.password||url.hash||
      !(host===MEDIA_SUFFIX||host.endsWith(`.${MEDIA_SUFFIX}`))) {
    throw safeError(code);
  }
  return url;
}

function rejectDuplicateRepresentations(items) {
  const identities=new Set();
  for (const item of items) {
    const identity=[
      item.id,item.codecs,item.mimeType,item.url
    ].join("\u0000");
    if (identities.has(identity)) {
      throw safeError("bilibili_control_invalid");
    }
    identities.add(identity);
  }
}

function viewUrl(mediaId) {
  const url=new URL(`https://${API_HOST}${VIEW_PATH}`);
  url.searchParams.set("bvid",mediaId);
  return url.href;
}

function playUrl(mediaId,cid) {
  const url=new URL(`https://${API_HOST}${PLAY_PATH}`);
  url.searchParams.set("bvid",mediaId);
  url.searchParams.set("cid",String(cid));
  url.searchParams.set("qn","32");
  url.searchParams.set("fnval","4048");
  url.searchParams.set("fnver","0");
  url.searchParams.set("fourk","1");
  return url.href;
}

function fixedHeaders(canonicalUrl) {
  return {
    Accept:"application/json,application/octet-stream,audio/mp4,video/mp4",
    "User-Agent":"Mozilla/5.0",
    Referer:canonicalUrl
  };
}

async function validateWorkspace(workspaceDir) {
  let info;
  try {
    info=await lstat(workspaceDir);
  } catch {
    throw safeError("bilibili_media_invalid");
  }
  if (!info.isDirectory()||info.isSymbolicLink()||
      info.uid!==process.getuid()||(info.mode&0o077)!==0) {
    throw safeError("bilibili_media_invalid");
  }
}

async function resolvePublicAddresses(hostname,lookupAll) {
  let answers;
  try {
    answers=await lookupAll(hostname,{all:true,verbatim:true});
  } catch {
    throw safeError("bilibili_access_denied");
  }
  if (!Array.isArray(answers)||!answers.length) {
    throw safeError("bilibili_access_denied");
  }
  const validated=[];
  for (const answer of answers) {
    const address=typeof answer==="string"?answer:answer?.address;
    const family=isIP(address);
    const declaredFamily=typeof answer==="string"
      ?family
      :answer?.family;
    if (typeof address!=="string"||
        !isPublicAddress(address)||
        !new Set([4,6]).has(family)||
        declaredFamily!==family) {
      throw safeError("bilibili_access_denied");
    }
    validated.push(Object.freeze({address,family}));
  }
  return Object.freeze(validated);
}

function isPublicAddress(address) {
  const family=isIP(address);
  if (family===4) return isPublicIpv4(address);
  if (family!==6) return false;
  const value=address.toLowerCase().split("%")[0];
  if (value==="::"||value==="::1"||
      /^f[cd]/u.test(value)||
      /^fe[89ab]/u.test(value)||
      /^ff/u.test(value)||
      /^2001:db8(?::|$)/u.test(value)||
      /^2001:(?:0?2|0?10|0?20)(?::|$)/u.test(value)) {
    return false;
  }
  const mapped=/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(value);
  if (mapped) return isPublicIpv4(mapped[1]);
  const first=parseInt(value.split(":")[0]||"0",16);
  return Number.isInteger(first)&&(first&0xe000)===0x2000;
}

function isPublicIpv4(address) {
  const parts=address.split(".").map(Number);
  if (parts.length!==4||
      parts.some(part=>!Number.isInteger(part)||part<0||part>255)) {
    return false;
  }
  const value=(
    ((parts[0]<<24)>>>0)|
    (parts[1]<<16)|
    (parts[2]<<8)|
    parts[3]
  )>>>0;
  return ![
    [0x00000000,8],
    [0x0a000000,8],
    [0x64400000,10],
    [0x7f000000,8],
    [0xa9fe0000,16],
    [0xac100000,12],
    [0xc0000000,24],
    [0xc0000200,24],
    [0xc0586300,24],
    [0xc0a80000,16],
    [0xc6120000,15],
    [0xc6336400,24],
    [0xcb007100,24],
    [0xe0000000,4],
    [0xf0000000,4]
  ].some(([network,prefix])=>
    (value>>>(32-prefix))===(network>>>(32-prefix))
  );
}

async function readBoundedJson(body,signal) {
  if (!body||typeof body.getReader!=="function") {
    throw safeError("bilibili_control_invalid");
  }
  const reader=body.getReader();
  const chunks=[];
  let total=0;
  while (true) {
    throwIfAborted(signal);
    let part;
    try {
      part=await reader.read();
    } catch {
      throwIfAborted(signal);
      throw safeError("bilibili_control_invalid");
    }
    if (part.done) break;
    total+=part.value.byteLength;
    if (total>MAX_CONTROL_BYTES) {
      await reader.cancel().catch(()=>{});
      throw safeError("bilibili_control_invalid");
    }
    chunks.push(Buffer.from(part.value));
  }
  let text;
  try {
    text=new TextDecoder("utf-8",{fatal:true}).decode(
      Buffer.concat(chunks)
    );
    return JSON.parse(text);
  } catch {
    throw safeError("bilibili_control_invalid");
  }
}

function validateJsonBounds(value) {
  let entries=0;
  let textBytes=0;
  const visit=(item,depth)=>{
    if (depth>MAX_JSON_DEPTH) {
      throw safeError("bilibili_control_invalid");
    }
    if (typeof item==="string") {
      textBytes+=Buffer.byteLength(item,"utf8");
    } else if (Array.isArray(item)) {
      entries+=item.length;
      for (const child of item) visit(child,depth+1);
    } else if (plain(item)) {
      const fields=Object.entries(item);
      entries+=fields.length;
      for (const [key,child] of fields) {
        textBytes+=Buffer.byteLength(key,"utf8");
        visit(child,depth+1);
      }
    }
    if (entries>MAX_JSON_ENTRIES||textBytes>MAX_JSON_TEXT_BYTES) {
      throw safeError("bilibili_control_invalid");
    }
  };
  visit(value,0);
}

function inspectionFor({inspectMediaHeader,kind,durationMs}) {
  return async input=>{
    try {
      return await inspectMediaHeader({
        ...input,kind,durationMs
      });
    } catch {
      throw safeError("bilibili_media_invalid");
    }
  };
}

function validatePublished({result,kind,durationMs}) {
  const expectedMime=kind==="audio"?"audio/mp4":"video/mp4";
  const expectedFormat=kind==="audio"?"m4a":"mp4";
  if (result.detectedMime!==expectedMime||
      result.format!==expectedFormat||
      Math.abs(result.durationMs-durationMs)>5_000) {
    throw safeError("bilibili_media_invalid");
  }
}

function publishedResult(file,result) {
  return Object.freeze({
    file,
    byteSize:result.byteSize,
    sha256:result.sha256,
    format:result.format,
    detectedMime:result.detectedMime
  });
}

async function safeFetch(fetchImpl,url,options,code) {
  throwIfAborted(options.signal);
  let response;
  try {
    response=await fetchImpl(url,options);
  } catch {
    throwIfAborted(options.signal);
    throw safeError(code);
  }
  if (!response||typeof response.ok!=="boolean"||
      !Number.isInteger(response.status)||
      !response.headers||typeof response.headers.get!=="function") {
    throw safeError(code);
  }
  return response;
}

function createDnsPreflightFetch({fetchImpl,lookupAll}) {
  return async(url,options)=>{
    let parsed;
    try {
      parsed=new URL(url);
    } catch {
      throw safeError("bilibili_access_denied");
    }
    await resolvePublicAddresses(parsed.hostname,lookupAll);
    return fetchImpl(parsed.href,options);
  };
}

function toFetchResponse(response) {
  const status=response?.statusCode;
  if (!Number.isInteger(status)||status<100||status>599||
      !response||typeof response.pipe!=="function") {
    throw safeError("bilibili_access_denied");
  }
  const headers=new Headers();
  for (const [name,value] of Object.entries(response.headers||{})) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name,String(item));
    } else if (value!==undefined) {
      headers.set(name,String(value));
    }
  }
  return Object.freeze({
    ok:status>=200&&status<300,
    status,
    headers,
    body:Readable.toWeb(response)
  });
}

function toNodeStream(body) {
  if (body&&typeof body.pipe==="function") return body;
  if (body&&typeof body.getReader==="function") {
    return Readable.fromWeb(body);
  }
  throw safeError("bilibili_media_unavailable");
}

async function cancelBody(response) {
  await response?.body?.cancel?.().catch(()=>{});
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw safeError("bilibili_media_unavailable");
}

function normalizeError(error) {
  if (SAFE_CODES.has(error?.message)) return safeError(error.message);
  if (error?.message==="source_limit_exceeded") {
    return safeError("bilibili_limit_exceeded");
  }
  return safeError("bilibili_media_invalid");
}

function unique(items) {
  return [...new Set(items)];
}

function plain(value) {
  return value!==null&&typeof value==="object"&&!Array.isArray(value);
}

function safeError(code) {
  return new Error(code);
}

async function defaultLookupAll(hostname) {
  return dnsLookup(hostname,{all:true,verbatim:true});
}
