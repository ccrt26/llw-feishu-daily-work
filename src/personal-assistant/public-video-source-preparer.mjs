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
const BILIBILI_FAILURES=new Set([
  "bilibili_url_invalid","bilibili_access_denied",
  "bilibili_control_invalid","bilibili_media_unavailable",
  "bilibili_media_invalid","bilibili_limit_exceeded"
]);
const BILIBILI_REVALIDATION_FAILURES=new Set([
  "bilibili_source_workspace_mode_failed",
  "bilibili_result_metadata_invalid",
  "bilibili_audio_descriptor_invalid",
  "bilibili_video_descriptor_invalid",
  "bilibili_audio_workspace_realpath_failed",
  "bilibili_video_workspace_realpath_failed",
  "bilibili_audio_file_realpath_failed",
  "bilibili_video_file_realpath_failed",
  "bilibili_audio_file_stat_failed",
  "bilibili_video_file_stat_failed",
  "bilibili_audio_file_metadata_invalid",
  "bilibili_video_file_metadata_invalid",
  "bilibili_audio_read_failed",
  "bilibili_video_read_failed",
  "bilibili_audio_hash_mismatch",
  "bilibili_video_hash_mismatch",
  "bilibili_source_handle_invalid"
]);

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
      try {
        await chmod(workspaceDir,0o700);
      } catch {
        throw invalidAt(
          request.platform,"bilibili_source_workspace_mode_failed"
        );
      }
      const result=await adapters[request.platform].prepare({
        url:request.url,workspaceDir,signal
      });
      await validateAdapterResult({
        result,request,workspaceDir,signal
      });
      let handle;
      try {
        handle=createSourceHandle({
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
      } catch {
        throw invalidAt(
          request.platform,"bilibili_source_handle_invalid"
        );
      }
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
      throw invalidFrom(error,request.platform);
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
  return async function prepareTurnSources(message,{signal}={}) {
    const request=extractPublicVideoRequest(message?.instructionText);
    const base=await basePreparer(message,{signal});
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
        sourceId:`source-${String(base.sources.length+1).padStart(3,"0")}`,
        signal
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
    throw invalidAt(
      request.platform,"bilibili_result_metadata_invalid"
    );
  }
  await Promise.all([
    validateMedia({
      value:result.audio,workspaceDir,
      format:"m4a",mime:"audio/mp4",maxBytes:MAX_AUDIO_BYTES,
      platform:request.platform,kind:"audio"
    }),
    validateMedia({
      value:result.video,workspaceDir,
      format:"mp4",mime:"video/mp4",maxBytes:MAX_VIDEO_BYTES,
      platform:request.platform,kind:"video"
    })
  ]);
  signal?.throwIfAborted();
}

async function validateMedia({
  value,workspaceDir,format,mime,maxBytes,platform,kind
}) {
  if (!plain(value)||typeof value.file!=="string"||
      !isAbsolute(value.file)||
      !bounded(value.byteSize,12,maxBytes)||
      !SHA.test(value.sha256||"")||
      value.format!==format||value.detectedMime!==mime) {
    throw invalidAt(
      platform,`bilibili_${kind}_descriptor_invalid`
    );
  }
  let workspace;
  try {
    workspace=await realpath(workspaceDir);
  } catch {
    throw invalidAt(
      platform,`bilibili_${kind}_workspace_realpath_failed`
    );
  }
  let actual;
  try {
    actual=await realpath(value.file);
  } catch {
    throw invalidAt(
      platform,`bilibili_${kind}_file_realpath_failed`
    );
  }
  const fromWorkspace=relative(workspace,actual);
  let info;
  try {
    info=await lstat(actual);
  } catch {
    throw invalidAt(
      platform,`bilibili_${kind}_file_stat_failed`
    );
  }
  if (!info.isFile()||info.isSymbolicLink()||
      info.uid!==process.getuid()||(info.mode&0o077)!==0||
      info.size!==value.byteSize||
      fromWorkspace.startsWith("..")||isAbsolute(fromWorkspace)) {
    throw invalidAt(
      platform,`bilibili_${kind}_file_metadata_invalid`
    );
  }
  let bytes;
  try {
    bytes=await readFile(actual);
  } catch {
    throw invalidAt(
      platform,`bilibili_${kind}_read_failed`
    );
  }
  if (sha(bytes)!==value.sha256) {
    throw invalidAt(
      platform,`bilibili_${kind}_hash_mismatch`
    );
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

function invalidAt(platform,code) {
  const failure=invalid();
  if (platform==="bilibili"&&
      BILIBILI_REVALIDATION_FAILURES.has(code)) {
    failure.publicVideoFailureCode=code;
  }
  return failure;
}

function invalidFrom(error,platform) {
  const failure=invalid();
  if (platform==="bilibili"&&
      BILIBILI_FAILURES.has(error?.message)) {
    failure.publicVideoFailureCode=error.message;
  }
  return failure;
}
