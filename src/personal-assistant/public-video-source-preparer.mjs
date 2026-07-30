import {createHash} from "node:crypto";
import {
  chmod,lstat,mkdir,mkdtemp,readFile,realpath,rm
} from "node:fs/promises";
import {isAbsolute,join,relative} from "node:path";
import {createSourceHandle} from "./source-handle.mjs";
import {extractPublicVideoRequest} from "./public-video-link.mjs";

const SOURCE_ID=/^source-00[1-8]$/u;
const SHA=/^[a-f0-9]{64}$/u;
const MAX_AUDIO_BYTES=32*1024*1024;
const MAX_VIDEO_BYTES=128*1024*1024;
const MAX_DURATION_MS=7*24*60*60*1_000;

export function createPublicVideoSourcePreparer({
  tempRoot,bilibiliAdapter,douyinAdapter,
  cleanup=directory=>rm(directory,{recursive:true,force:true})
}={}) {
  if (typeof tempRoot!=="string"||!isAbsolute(tempRoot)||
      typeof bilibiliAdapter?.prepare!=="function"||
      typeof douyinAdapter?.prepare!=="function"||
      typeof cleanup!=="function") {
    throw invalid();
  }
  const adapters={
    bilibili:bilibiliAdapter,
    douyin:douyinAdapter
  };
  return async function preparePublicVideoSource({
    request,sourceId,signal
  }) {
    validateRequest({request,sourceId,signal});
    await mkdir(tempRoot,{recursive:true,mode:0o700});
    await chmod(tempRoot,0o700);
    await privateDirectory(tempRoot);
    let workspaceDir;
    try {
      workspaceDir=await mkdtemp(join(tempRoot,"llw-public-video-"));
      await chmod(workspaceDir,0o700);
      const result=await adapters[request.platform].prepare({
        url:request.url,workspaceDir,signal
      });
      await validateAdapterResult({
        result,request,workspaceDir,signal
      });
      const handle=createSourceHandle({
        sourceId,
        displayName:`${request.platform}-${result.mediaId}.mp4`,
        mediaClass:"video",
        format:"mp4",
        relativePath:`${sourceId}.mp4`,
        byteSize:result.video.byteSize,
        sha256:result.video.sha256,
        availability:"ready",
        durationMs:result.durationMs,
        instructionRole:"source_content",
        representationIndexPath:`${sourceId}.manifest.json`,
        limitations:[...result.limitations]
      });
      const completed=workspaceDir;
      workspaceDir=undefined;
      return Object.freeze({
        instructionText:null,
        workspaceDir:completed,
        source:Object.freeze({
          handle,
          absolutePath:result.video.file,
          archiveExtension:"mp4",
          auxiliaryFiles:Object.freeze([Object.freeze({
            role:"audio",
            extension:"m4a",
            absolutePath:result.audio.file,
            byteSize:result.audio.byteSize,
            sha256:result.audio.sha256,
            durationMs:result.durationMs
          })])
        }),
        cleanup:once(()=>cleanup(completed))
      });
    } catch (error) {
      if (workspaceDir) {
        await cleanup(workspaceDir).catch(()=>{});
      }
      if (error?.message==="public_video_source_invalid"||
          error?.name==="AbortError") throw error;
      throw invalid();
    }
  };
}

export function createTurnSourcePreparerWithPublicVideo({
  basePreparer,publicVideoSourcePreparer
}={}) {
  if (typeof basePreparer!=="function"||
      typeof publicVideoSourcePreparer!=="function") {
    throw invalid();
  }
  return async function prepareTurnSources(message) {
    const request=extractPublicVideoRequest(message?.instructionText);
    const base=await basePreparer(message);
    if (!request) return base;
    if (!Array.isArray(base?.sources)||base.sources.length>=8||
        typeof base.cleanup!=="function") {
      await base?.cleanup?.().catch(()=>{});
      throw new Error("source_limit_exceeded");
    }
    let publicVideo;
    try {
      publicVideo=await publicVideoSourcePreparer({
        request,
        sourceId:`source-${String(base.sources.length+1).padStart(3,"0")}`
      });
      const cleanup=once(async()=>{
        await Promise.allSettled([
          Promise.resolve().then(()=>base.cleanup()),
          Promise.resolve().then(()=>publicVideo.cleanup())
        ]);
      });
      return Object.freeze({
        instructionText:base.instructionText,
        workspaceDir:base.workspaceDir,
        sources:Object.freeze([
          ...base.sources,publicVideo.source
        ]),
        cleanup
      });
    } catch (error) {
      await base.cleanup().catch(()=>{});
      await publicVideo?.cleanup?.().catch(()=>{});
      throw error;
    }
  };
}

function validateRequest({request,sourceId,signal}) {
  if (!plain(request)||
      !new Set(["bilibili","douyin"]).has(request.platform)||
      typeof request.url!=="string"||
      !request.url.startsWith("https://")||
      !SOURCE_ID.test(sourceId||"")||
      !(signal===undefined||signal instanceof AbortSignal)) {
    throw invalid();
  }
}

async function validateAdapterResult({
  result,request,workspaceDir,signal
}) {
  signal?.throwIfAborted();
  if (!plain(result)||result.platform!==request.platform||
      typeof result.mediaId!=="string"||
      !/^[A-Za-z0-9_-]{1,64}$/u.test(result.mediaId)||
      !bounded(result.durationMs,1,MAX_DURATION_MS)||
      !Array.isArray(result.limitations)||
      result.limitations.length>8||
      result.limitations.some(item=>
        typeof item!=="string"||!item||
        Buffer.byteLength(item,"utf8")>1_000
      )) {
    throw invalid();
  }
  await Promise.all([
    validateMedia({
      value:result.audio,workspaceDir,
      format:"m4a",mime:"audio/mp4",maxBytes:MAX_AUDIO_BYTES
    }),
    validateMedia({
      value:result.video,workspaceDir,
      format:"mp4",mime:"video/mp4",maxBytes:MAX_VIDEO_BYTES
    })
  ]);
  signal?.throwIfAborted();
}

async function validateMedia({
  value,workspaceDir,format,mime,maxBytes
}) {
  if (!plain(value)||typeof value.file!=="string"||
      !isAbsolute(value.file)||
      !bounded(value.byteSize,12,maxBytes)||
      !SHA.test(value.sha256||"")||
      value.format!==format||value.detectedMime!==mime) {
    throw invalid();
  }
  const workspace=await realpath(workspaceDir);
  const actual=await realpath(value.file);
  const fromWorkspace=relative(workspace,actual);
  const info=await lstat(actual);
  if (!info.isFile()||info.isSymbolicLink()||
      info.uid!==process.getuid()||(info.mode&0o077)!==0||
      info.size!==value.byteSize||
      fromWorkspace.startsWith("..")||isAbsolute(fromWorkspace)||
      sha(await readFile(actual))!==value.sha256) {
    throw invalid();
  }
}

async function privateDirectory(directory) {
  const info=await lstat(directory);
  if (!info.isDirectory()||info.isSymbolicLink()||
      info.uid!==process.getuid()||(info.mode&0o077)!==0) {
    throw invalid();
  }
}

function once(operation) {
  let promise;
  return ()=>promise||=Promise.resolve().then(operation);
}

function sha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function bounded(value,min,max) {
  return Number.isSafeInteger(value)&&value>=min&&value<=max;
}

function plain(value) {
  return value!==null&&typeof value==="object"&&!Array.isArray(value)&&
    Object.getPrototypeOf(value)===Object.prototype;
}

function invalid() {
  return new Error("public_video_source_invalid");
}
