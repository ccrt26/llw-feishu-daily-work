import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {
  chmod,constants as fsConstants,copyFile,lstat,mkdtemp,
  readFile,realpath,rm,stat
} from "node:fs/promises";
import {isAbsolute,join,resolve} from "node:path";

const PAGE_HOST="www.douyin.com";
const VIDEO_PATH=/^\/video\/([1-9][0-9]{9,23})$/u;
const SHA256=/^[a-f0-9]{64}$/u;
const SAFE_NAME=/^[a-z0-9][a-z0-9._-]{0,127}$/u;
const MAX_AUDIO_BYTES=32*1024*1024;
const MAX_VIDEO_BYTES=128*1024*1024;
const MAX_DURATION_MS=5*60*60*1_000-1;
const MAX_STDOUT_BYTES=64*1024;
const MAX_STDERR_BYTES=8*1024;
const MAX_HELPER_BYTES=64*1024*1024;
const SAFE_CODES=new Set([
  "douyin_url_invalid",
  "douyin_helper_unavailable",
  "douyin_helper_invalid",
  "douyin_media_unavailable",
  "douyin_media_invalid",
  "douyin_limit_exceeded"
]);

export function createDouyinWebKitReaderAdapter({
  helperPath,
  helperSha256,
  tempRoot,
  jobCwd,
  timeoutMs=45_000,
  maxStdoutBytes=MAX_STDOUT_BYTES,
  helperEnvironment={},
  spawnImpl=spawn
}={}) {
  if (
    typeof helperPath!=="string"||!isAbsolute(helperPath)||
    typeof helperSha256!=="string"||!SHA256.test(helperSha256)||
    typeof tempRoot!=="string"||!isAbsolute(tempRoot)||
    typeof jobCwd!=="string"||!isAbsolute(jobCwd)||
    !boundedInteger(timeoutMs,1,120_000)||
    !boundedInteger(maxStdoutBytes,1,MAX_STDOUT_BYTES)||
    !safeEnvironment(helperEnvironment)||
    typeof spawnImpl!=="function"
  ) {
    throw safeError("douyin_helper_invalid");
  }

  return Object.freeze({
    async read(input) {
      const request=validateReadInput(input);
      const published=[];
      let job;
      try {
        await Promise.all([
          validatePrivateDirectory(request.workspaceDir),
          validatePrivateDirectory(tempRoot),
          validatePrivateDirectory(jobCwd),
          validateHelper(helperPath,helperSha256)
        ]);
        request.signal?.throwIfAborted();
        job=await mkdtemp(join(tempRoot,"llw-douyin-webkit-"));
        await chmod(job,0o700);
        await validatePrivateDirectory(job);

        const stdout=await runHelper({
          helperPath,
          args:[
            "--url",request.canonicalUrl,
            "--output-dir",job,
            "--audio-max-bytes",String(MAX_AUDIO_BYTES),
            "--video-max-bytes",String(MAX_VIDEO_BYTES),
            "--deadline-ms",String(timeoutMs)
          ],
          jobCwd,
          job,
          timeoutMs,
          maxStdoutBytes,
          helperEnvironment,
          spawnImpl,
          signal:request.signal
        });
        request.signal?.throwIfAborted();
        const result=parseHelperResult(
          stdout,request,job
        );
        await verifyHelperMedia({
          item:result.audio,
          job,
          maxBytes:MAX_AUDIO_BYTES,
          kind:"audio",
          durationMs:result.durationMs
        });
        await verifyHelperMedia({
          item:result.video,
          job,
          maxBytes:MAX_VIDEO_BYTES,
          kind:"video",
          durationMs:result.durationMs
        });
        request.signal?.throwIfAborted();

        const audioFile=join(
          request.workspaceDir,
          `douyin-${request.mediaId}-audio.m4a`
        );
        const videoFile=join(
          request.workspaceDir,
          `douyin-${request.mediaId}-video.mp4`
        );
        await publishOne(
          join(job,result.audio.relativePath),audioFile,published
        );
        await publishOne(
          join(job,result.video.relativePath),videoFile,published
        );

        return Object.freeze({
          platform:"douyin",
          mediaId:request.mediaId,
          canonicalUrl:request.canonicalUrl,
          durationMs:result.durationMs,
          audio:publishedMedia(audioFile,result.audio),
          video:publishedMedia(videoFile,result.video),
          limitations:Object.freeze([...result.limitations])
        });
      } catch (error) {
        for (const file of published.reverse()) {
          await rm(file,{force:true}).catch(()=>{});
        }
        throw normalizeError(error);
      } finally {
        if (job) {
          await rm(job,{recursive:true,force:true}).catch(()=>{});
        }
      }
    }
  });
}

export function normalizeDouyinVideoUrl(value) {
  if (typeof value!=="string") {
    throw safeError("douyin_url_invalid");
  }
  let url;
  try {
    url=new URL(value);
  } catch {
    throw safeError("douyin_url_invalid");
  }
  const match=VIDEO_PATH.exec(url.pathname);
  if (
    url.protocol!=="https:"||
    url.hostname!==PAGE_HOST||
    url.port||url.username||url.password||
    url.search||url.hash||
    !match||
    url.href!==`https://${PAGE_HOST}${url.pathname}`
  ) {
    throw safeError("douyin_url_invalid");
  }
  return Object.freeze({
    mediaId:match[1],
    canonicalUrl:url.href
  });
}

function validateReadInput(input) {
  if (
    !plain(input)||
    typeof input.url!=="string"||
    typeof input.workspaceDir!=="string"||
    !isAbsolute(input.workspaceDir)||
    !(input.signal===undefined||input.signal instanceof AbortSignal)
  ) {
    throw safeError("douyin_url_invalid");
  }
  const normalized=normalizeDouyinVideoUrl(input.url);
  return Object.freeze({
    mediaId:normalized.mediaId,
    canonicalUrl:normalized.canonicalUrl,
    workspaceDir:input.workspaceDir,
    signal:input.signal
  });
}

async function validateHelper(file,expectedSha256) {
  try {
    const info=await lstat(file);
    if (
      !info.isFile()||info.isSymbolicLink()||
      info.uid!==process.getuid()||
      (info.mode&0o077)!==0||
      (info.mode&0o100)===0||
      info.size<1||info.size>MAX_HELPER_BYTES
    ) {
      throw new Error("unsafe");
    }
    const canonical=await realpath(file);
    if (canonical!==file) throw new Error("alias");
    if (await sha256File(file)!==expectedSha256) {
      throw new Error("hash");
    }
  } catch {
    throw safeError("douyin_helper_unavailable");
  }
}

async function validatePrivateDirectory(directory) {
  try {
    const info=await lstat(directory);
    if (
      !info.isDirectory()||info.isSymbolicLink()||
      info.uid!==process.getuid()||
      (info.mode&0o077)!==0
    ) {
      throw new Error("unsafe");
    }
    await realpath(directory);
  } catch {
    throw safeError("douyin_helper_unavailable");
  }
}

async function runHelper({
  helperPath,args,jobCwd,job,timeoutMs,maxStdoutBytes,
  helperEnvironment,spawnImpl,signal
}) {
  signal?.throwIfAborted();
  const environment=Object.freeze({
    PATH:"/usr/bin:/bin",
    LANG:"en_US.UTF-8",
    LC_ALL:"en_US.UTF-8",
    TMPDIR:job,
    ...helperEnvironment
  });
  let child;
  try {
    child=spawnImpl(helperPath,args,{
      cwd:jobCwd,
      env:environment,
      shell:false,
      stdio:["ignore","pipe","pipe"]
    });
  } catch {
    throw safeError("douyin_helper_unavailable");
  }
  if (
    !child||typeof child.once!=="function"||
    !child.stdout||!child.stderr
  ) {
    throw safeError("douyin_helper_unavailable");
  }

  return new Promise((resolvePromise,rejectPromise)=>{
    const stdout=[];
    let stdoutBytes=0;
    let stderrBytes=0;
    let settled=false;
    let exceeded=false;
    let timedOut=false;
    const finish=(error,value)=>{
      if (settled) return;
      settled=true;
      clearTimeout(timer);
      signal?.removeEventListener("abort",onAbort);
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const stop=()=>{
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may already have exited.
      }
    };
    const onAbort=()=>{
      stop();
      finish(signal.reason instanceof Error
        ?signal.reason
        :abortError());
    };
    const timer=setTimeout(()=>{
      timedOut=true;
      stop();
    },timeoutMs);

    signal?.addEventListener("abort",onAbort,{once:true});
    child.stdout.on("data",chunk=>{
      stdoutBytes+=chunk.length;
      if (stdoutBytes>maxStdoutBytes) {
        exceeded=true;
        stop();
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data",chunk=>{
      stderrBytes+=chunk.length;
      if (stderrBytes>MAX_STDERR_BYTES) {
        exceeded=true;
        stop();
      }
    });
    child.once("error",()=>{
      finish(safeError("douyin_helper_unavailable"));
    });
    child.once("close",code=>{
      if (exceeded) {
        finish(safeError("douyin_limit_exceeded"));
      } else if (timedOut) {
        finish(safeError("douyin_media_unavailable"));
      } else if (code!==0) {
        finish(safeError("douyin_media_unavailable"));
      } else {
        finish(null,Buffer.concat(stdout).toString("utf8"));
      }
    });
  });
}

function parseHelperResult(stdout,request,job) {
  let value;
  try {
    if (
      typeof stdout!=="string"||
      Buffer.byteLength(stdout,"utf8")>MAX_STDOUT_BYTES
    ) {
      throw new Error("bounds");
    }
    value=JSON.parse(stdout.trim());
  } catch {
    throw safeError("douyin_helper_invalid");
  }
  if (
    !plain(value)||value.version!==1||value.status!=="ok"||
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
    throw safeError("douyin_helper_invalid");
  }
  validateMediaShape(value.audio,"audio",value.durationMs,job);
  validateMediaShape(value.video,"video",value.durationMs,job);
  return value;
}

function validateMediaShape(item,kind,durationMs,job) {
  const expected=kind==="audio"
    ?{mime:"audio/mp4",format:"m4a",max:MAX_AUDIO_BYTES}
    :{mime:"video/mp4",format:"mp4",max:MAX_VIDEO_BYTES};
  if (
    !plain(item)||
    typeof item.relativePath!=="string"||
    !SAFE_NAME.test(item.relativePath)||
    resolve(job,item.relativePath)!==join(job,item.relativePath)||
    !boundedInteger(item.byteSize,1,expected.max)||
    typeof item.sha256!=="string"||!SHA256.test(item.sha256)||
    item.detectedMime!==expected.mime||
    item.format!==expected.format||
    !boundedInteger(item.durationMs,1,MAX_DURATION_MS)||
    Math.abs(item.durationMs-durationMs)>5_000
  ) {
    throw safeError("douyin_helper_invalid");
  }
  if (
    kind==="video"&&(
      !boundedInteger(item.width,1,7680)||
      !boundedInteger(item.height,1,4320)
    )
  ) {
    throw safeError("douyin_helper_invalid");
  }
}

async function verifyHelperMedia({
  item,job,maxBytes,kind,durationMs
}) {
  const file=join(job,item.relativePath);
  try {
    const info=await lstat(file);
    const canonical=await realpath(file);
    const canonicalJob=await realpath(job);
    if (
      !info.isFile()||info.isSymbolicLink()||
      info.uid!==process.getuid()||
      (info.mode&0o077)!==0||
      info.size!==item.byteSize||
      info.size<1||info.size>maxBytes||
      canonical!==join(canonicalJob,item.relativePath)||
      await sha256File(file)!==item.sha256||
      item.durationMs<1||
      Math.abs(item.durationMs-durationMs)>5_000||
      (kind==="audio"&&item.detectedMime!=="audio/mp4")||
      (kind==="video"&&item.detectedMime!=="video/mp4")
    ) {
      throw new Error("invalid");
    }
  } catch {
    throw safeError("douyin_media_invalid");
  }
}

async function publishOne(source,destination,published) {
  try {
    await copyFile(source,destination,fsConstants.COPYFILE_EXCL);
    published.push(destination);
    await chmod(destination,0o600);
    const info=await stat(destination);
    if (
      !info.isFile()||info.uid!==process.getuid()||
      (info.mode&0o077)!==0
    ) {
      throw new Error("unsafe");
    }
  } catch {
    throw safeError("douyin_media_invalid");
  }
}

function publishedMedia(file,item) {
  const result={
    file,
    byteSize:item.byteSize,
    sha256:item.sha256,
    detectedMime:item.detectedMime,
    format:item.format,
    durationMs:item.durationMs
  };
  if (item.width!==undefined) result.width=item.width;
  if (item.height!==undefined) result.height=item.height;
  return Object.freeze(result);
}

async function sha256File(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

function safeEnvironment(value) {
  return plain(value)&&
    Object.entries(value).length<=16&&
    Object.entries(value).every(([key,item])=>
      /^[A-Z][A-Z0-9_]{0,63}$/u.test(key)&&
      typeof item==="string"&&
      Buffer.byteLength(item,"utf8")<=1024&&
      !item.includes("\0")
    );
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

function abortError() {
  const error=new Error("aborted");
  error.name="AbortError";
  return error;
}

function safeError(code) {
  return new Error(code);
}

function normalizeError(error) {
  if (error?.name==="AbortError") return error;
  if (SAFE_CODES.has(error?.message)) return safeError(error.message);
  return safeError("douyin_media_unavailable");
}
