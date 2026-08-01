import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {
  chmod,constants as fsConstants,copyFile,lstat,mkdtemp,
  open,readFile,realpath,rm
} from "node:fs/promises";
import {extname,isAbsolute,join,relative,resolve} from "node:path";

const SOURCE_ID=/^source-00[1-8]$/u;
const SHA=/^[a-f0-9]{64}$/u;
const SHEET_NAME=/^timeline-([0-9]{3})\.png$/u;
const PNG_SIGNATURE=Buffer.from([
  0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a
]);
const MAX_VIDEO_BYTES=128*1024*1024;
const MAX_DURATION_MS=7*24*60*60*1_000;
const MAX_DURATION_ROUNDING_MS=1_000;
const MAX_SAMPLES=156;
const MAX_FILES=13;
const MAX_RANGE_MS=60_000;
const MAX_RANGE_SAMPLES=12;
const MAX_TOTAL_BYTES=100*1024*1024;
const MAX_DIMENSION=3508;
const MAX_PIXELS=12_306_064;
const MAX_STDOUT_BYTES=1024*1024;
const MAX_STDERR_BYTES=8*1024;
const MAX_HELPER_BYTES=64*1024*1024;
const RESULT_FIELDS=new Set([
  "version","status","contract","durationMs","sampleCount",
  "maxGapMs","samples","sheets","limitations"
]);
const RANGE_RESULT_FIELDS=new Set([
  "version","status","contract","durationMs","startMs","endMs",
  "sampleCount","maxGapMs","samples","sheets","limitations"
]);
const SAMPLE_FIELDS=new Set(["startMs","endMs","sampleMs"]);
const SHEET_FIELDS=new Set([
  "relativePath","sha256","width","height","startMs","endMs",
  "firstSampleIndex","lastSampleIndex"
]);
const SAFE_CODES=new Set([
  "video_timeline_input_invalid",
  "video_timeline_helper_unavailable",
  "video_timeline_helper_invalid",
  "video_timeline_media_invalid",
  "video_timeline_limit_exceeded"
]);

export function createVideoTimelineReaderAdapter({
  helperPath,
  helperSha256,
  tempRoot,
  jobCwd,
  timeoutMs=120_000,
  maxStdoutBytes=MAX_STDOUT_BYTES,
  maxFiles=MAX_FILES,
  maxTotalBytes=MAX_TOTAL_BYTES,
  maxDimension=MAX_DIMENSION,
  maxPixels=MAX_PIXELS,
  helperEnvironment={},
  spawnImpl=spawn
}={}) {
  if (
    typeof helperPath!=="string"||!isAbsolute(helperPath)||
    !SHA.test(helperSha256||"")||
    typeof tempRoot!=="string"||!isAbsolute(tempRoot)||
    typeof jobCwd!=="string"||!isAbsolute(jobCwd)||
    !bounded(timeoutMs,1,120_000)||
    !bounded(maxStdoutBytes,1,MAX_STDOUT_BYTES)||
    !bounded(maxFiles,1,MAX_FILES)||
    !bounded(maxTotalBytes,1,MAX_TOTAL_BYTES)||
    !bounded(maxDimension,1,MAX_DIMENSION)||
    !bounded(maxPixels,1,MAX_PIXELS)||
    !safeEnvironment(helperEnvironment)||
    typeof spawnImpl!=="function"
  ) {
    throw safeError("video_timeline_helper_invalid");
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
          validateHelper(helperPath,helperSha256),
          validateVideo(request)
        ]);
        request.signal?.throwIfAborted();
        job=await mkdtemp(join(tempRoot,"llw-video-timeline-"));
        await chmod(job,0o700);
        await validatePrivateDirectory(job);

        const stdout=await runHelper({
          helperPath,
          args:[
            "--video",request.videoFile,
            "--output-dir",job,
            "--expected-duration-ms",String(request.durationMs)
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
        const result=parseResult({
          stdout,
          expectedDurationMs:request.durationMs,
          maxFiles
        });
        let totalBytes=0;
        const images=[];
        for (let index=0;index<result.sheets.length;index++) {
          const sheet=result.sheets[index];
          const verified=await verifySheet({
            sheet,
            index,
            job,
            maxDimension,
            maxPixels
          });
          totalBytes+=verified.byteSize;
          if (!Number.isSafeInteger(totalBytes)||
              totalBytes>maxTotalBytes) {
            throw safeError("video_timeline_limit_exceeded");
          }
          const relativePath=
            `${request.sourceId}.timeline-${String(index+1)
              .padStart(3,"0")}.png`;
          const destination=join(request.workspaceDir,relativePath);
          await copyFile(
            verified.file,
            destination,
            fsConstants.COPYFILE_EXCL
          );
          await chmod(destination,0o600);
          published.push(destination);
          images.push(Object.freeze({
            sourceId:request.sourceId,
            relativePath,
            sha256:sheet.sha256,
            startMs:sheet.startMs,
            endMs:sheet.endMs
          }));
        }
        request.signal?.throwIfAborted();
        return Object.freeze({
          durationMs:result.durationMs,
          sampleCount:result.sampleCount,
          maxGapMs:result.maxGapMs,
          samples:Object.freeze(
            result.samples.map(item=>Object.freeze({...item}))
          ),
          images:Object.freeze(images),
          limitations:Object.freeze([...result.limitations])
        });
      } catch (error) {
        for (const file of published.reverse()) {
          await rm(file,{force:true}).catch(()=>{});
        }
        throw normalizeError(error);
      } finally {
        if (job) await rm(job,{recursive:true,force:true}).catch(()=>{});
      }
    },
    async readRange(input) {
      const request=validateRangeInput(input);
      const published=[];
      let job;
      try {
        await Promise.all([
          validatePrivateDirectory(request.workspaceDir),
          validatePrivateDirectory(tempRoot),
          validatePrivateDirectory(jobCwd),
          validateHelper(helperPath,helperSha256),
          validateVideo(request)
        ]);
        request.signal?.throwIfAborted();
        job=await mkdtemp(join(tempRoot,"llw-video-range-"));
        await chmod(job,0o700);
        await validatePrivateDirectory(job);

        const stdout=await runHelper({
          helperPath,
          args:[
            "--video",request.videoFile,
            "--output-dir",job,
            "--expected-duration-ms",String(request.durationMs),
            "--start-ms",String(request.startMs),
            "--end-ms",String(request.endMs)
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
        const result=parseRangeResult({
          stdout,
          expectedDurationMs:request.durationMs,
          expectedStartMs:request.startMs,
          expectedEndMs:request.endMs
        });
        const sheet=result.sheets[0];
        const verified=await verifySheet({
          sheet,index:0,job,maxDimension,maxPixels
        });
        if (verified.byteSize>maxTotalBytes) {
          throw safeError("video_timeline_limit_exceeded");
        }
        const relativePath=[
          `${request.sourceId}.inspect`,
          `${request.startMs}`,
          `${request.endMs}.png`
        ].join("-");
        const destination=join(request.workspaceDir,relativePath);
        await copyFile(
          verified.file,
          destination,
          fsConstants.COPYFILE_EXCL
        );
        await chmod(destination,0o600);
        published.push(destination);
        request.signal?.throwIfAborted();
        return Object.freeze({
          durationMs:result.durationMs,
          startMs:result.startMs,
          endMs:result.endMs,
          sampleCount:result.sampleCount,
          maxGapMs:result.maxGapMs,
          samples:Object.freeze(
            result.samples.map(item=>Object.freeze({...item}))
          ),
          images:Object.freeze([Object.freeze({
            sourceId:request.sourceId,
            relativePath,
            sha256:sheet.sha256,
            startMs:request.startMs,
            endMs:request.endMs
          })]),
          limitations:Object.freeze([...result.limitations])
        });
      } catch (error) {
        for (const file of published.reverse()) {
          await rm(file,{force:true}).catch(()=>{});
        }
        throw normalizeError(error);
      } finally {
        if (job) await rm(job,{recursive:true,force:true}).catch(()=>{});
      }
    }
  });
}

function validateReadInput(input) {
  if (
    !plain(input)||
    !SOURCE_ID.test(input.sourceId||"")||
    typeof input.videoFile!=="string"||
    !isAbsolute(input.videoFile)||
    extname(input.videoFile).toLowerCase()!==".mp4"||
    !SHA.test(input.videoSha256||"")||
    !bounded(input.durationMs,1,MAX_DURATION_MS)||
    typeof input.workspaceDir!=="string"||
    !isAbsolute(input.workspaceDir)||
    !(input.signal===undefined||input.signal instanceof AbortSignal)
  ) {
    throw safeError("video_timeline_input_invalid");
  }
  return Object.freeze({...input});
}

function validateRangeInput(input) {
  const request=validateReadInput(input);
  const allowed=new Set([
    "sourceId","videoFile","videoSha256","durationMs",
    "startMs","endMs","workspaceDir","signal"
  ]);
  if (Object.keys(input).some(key=>!allowed.has(key))||
      !Number.isSafeInteger(input.startMs)||input.startMs<0||
      !Number.isSafeInteger(input.endMs)||
      input.endMs<=input.startMs||
      input.endMs>request.durationMs||
      input.endMs-input.startMs>MAX_RANGE_MS) {
    throw safeError("video_timeline_input_invalid");
  }
  return Object.freeze({...request,
    startMs:input.startMs,endMs:input.endMs
  });
}

async function validateVideo(request) {
  try {
    const info=await lstat(request.videoFile);
    const actual=await realpath(request.videoFile);
    const workspace=await realpath(request.workspaceDir);
    const fromWorkspace=relative(workspace,actual);
    if (
      !info.isFile()||info.isSymbolicLink()||
      info.uid!==process.getuid()||(info.mode&0o077)!==0||
      info.size<12||info.size>MAX_VIDEO_BYTES||
      fromWorkspace.startsWith("..")||isAbsolute(fromWorkspace)||
      resolve(workspace,fromWorkspace)!==actual||
      await sha256File(actual)!==request.videoSha256
    ) {
      throw new Error("invalid");
    }
  } catch {
    throw safeError("video_timeline_input_invalid");
  }
}

async function validateHelper(file,expectedSha256) {
  try {
    const info=await lstat(file);
    if (
      !info.isFile()||info.isSymbolicLink()||
      info.uid!==process.getuid()||(info.mode&0o077)!==0||
      (info.mode&0o100)===0||
      info.size<1||info.size>MAX_HELPER_BYTES||
      await sha256File(file)!==expectedSha256
    ) {
      throw new Error("unsafe");
    }
  } catch {
    throw safeError("video_timeline_helper_unavailable");
  }
}

async function validatePrivateDirectory(directory) {
  try {
    const info=await lstat(directory);
    if (
      !info.isDirectory()||info.isSymbolicLink()||
      info.uid!==process.getuid()||(info.mode&0o077)!==0
    ) {
      throw new Error("unsafe");
    }
  } catch {
    throw safeError("video_timeline_helper_unavailable");
  }
}

function runHelper({
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
    throw safeError("video_timeline_helper_unavailable");
  }
  if (!child?.stdout||!child?.stderr||
      typeof child.once!=="function") {
    throw safeError("video_timeline_helper_unavailable");
  }
  return new Promise((resolvePromise,rejectPromise)=>{
    const stdout=[];
    let stdoutBytes=0;
    let stderrBytes=0;
    let settled=false;
    let timedOut=false;
    let exceeded=false;
    const finish=(error,value)=>{
      if (settled) return;
      settled=true;
      clearTimeout(timer);
      signal?.removeEventListener("abort",onAbort);
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const stop=()=>{
      try { child.kill("SIGKILL"); } catch {}
    };
    const onAbort=()=>{
      stop();
      finish(safeError("video_timeline_media_invalid"));
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
      } else {
        stdout.push(Buffer.from(chunk));
      }
    });
    child.stderr.on("data",chunk=>{
      stderrBytes+=chunk.length;
      if (stderrBytes>MAX_STDERR_BYTES) {
        exceeded=true;
        stop();
      }
    });
    child.once("error",()=>{
      finish(safeError("video_timeline_helper_unavailable"));
    });
    child.once("close",code=>{
      if (exceeded) {
        finish(safeError("video_timeline_limit_exceeded"));
      } else if (timedOut||code!==0||stderrBytes!==0) {
        finish(safeError("video_timeline_helper_invalid"));
      } else {
        finish(null,Buffer.concat(stdout).toString("utf8"));
      }
    });
  });
}

function parseResult({stdout,expectedDurationMs,maxFiles}) {
  let value;
  try {
    value=JSON.parse(stdout);
  } catch {
    throw safeError("video_timeline_helper_invalid");
  }
  if (
    !exact(value,RESULT_FIELDS)||
    value.version!==1||
    value.status!=="ok"||
    value.contract!=="video_timeline_reader_v1"||
    !bounded(value.durationMs,1,MAX_DURATION_MS)||
    Math.abs(value.durationMs-expectedDurationMs)>
      MAX_DURATION_ROUNDING_MS||
    !bounded(value.sampleCount,1,MAX_SAMPLES)||
    !bounded(value.maxGapMs,1,MAX_DURATION_MS)||
    !Array.isArray(value.samples)||
    value.samples.length!==value.sampleCount||
    !Array.isArray(value.sheets)||
    value.sheets.length<1||
    value.sheets.length>maxFiles||
    value.sheets.length!==Math.ceil(value.sampleCount/12)||
    !Array.isArray(value.limitations)||
    value.limitations.length!==2||
    value.limitations[0]!=="uniform_timeline_sampling"||
    value.limitations[1]!=="not_frame_by_frame"
  ) {
    if (Array.isArray(value?.sheets)&&value.sheets.length>maxFiles) {
      throw safeError("video_timeline_limit_exceeded");
    }
    throw safeError("video_timeline_helper_invalid");
  }
  validateSamples(value);
  validateSheets(value);
  return normalizeDurationRounding(value,expectedDurationMs);
}

function parseRangeResult({
  stdout,expectedDurationMs,expectedStartMs,expectedEndMs
}) {
  let value;
  try {
    value=JSON.parse(stdout);
  } catch {
    throw safeError("video_timeline_helper_invalid");
  }
  if (
    !exact(value,RANGE_RESULT_FIELDS)||
    value.version!==1||
    value.status!=="ok"||
    value.contract!=="video_time_range_reader_v1"||
    !bounded(value.durationMs,1,MAX_DURATION_MS)||
    Math.abs(value.durationMs-expectedDurationMs)>
      MAX_DURATION_ROUNDING_MS||
    value.startMs!==expectedStartMs||
    value.endMs!==expectedEndMs||
    !bounded(value.sampleCount,1,MAX_RANGE_SAMPLES)||
    !bounded(value.maxGapMs,1,MAX_RANGE_MS)||
    !Array.isArray(value.samples)||
    value.samples.length!==value.sampleCount||
    !Array.isArray(value.sheets)||
    value.sheets.length!==1||
    !Array.isArray(value.limitations)||
    value.limitations.length!==2||
    value.limitations[0]!=="uniform_range_sampling"||
    value.limitations[1]!=="not_frame_by_frame"
  ) {
    throw safeError("video_timeline_helper_invalid");
  }
  validateRangeSamples(value);
  validateSheets(value);
  if (value.durationMs===expectedDurationMs) return value;
  return {...value,durationMs:expectedDurationMs};
}

function normalizeDurationRounding(value,expectedDurationMs) {
  if (value.durationMs===expectedDurationMs) return value;
  const result=structuredClone(value);
  const lastSample=result.samples.at(-1);
  const lastSheet=result.sheets.at(-1);
  if (
    expectedDurationMs<=lastSample.startMs||
    lastSample.sampleMs>=expectedDurationMs
  ) {
    throw safeError("video_timeline_helper_invalid");
  }
  lastSample.endMs=expectedDurationMs;
  lastSheet.endMs=expectedDurationMs;
  result.durationMs=expectedDurationMs;
  result.maxGapMs=Math.max(
    ...result.samples.map(item=>item.endMs-item.startMs)
  );
  validateSamples(result);
  validateSheets(result);
  return result;
}

function validateSamples(value) {
  let previousEnd=0;
  let maxGap=0;
  for (const sample of value.samples) {
    if (
      !exact(sample,SAMPLE_FIELDS)||
      !Number.isSafeInteger(sample.startMs)||
      !Number.isSafeInteger(sample.endMs)||
      !Number.isSafeInteger(sample.sampleMs)||
      sample.startMs!==previousEnd||
      sample.endMs<=sample.startMs||
      sample.endMs>value.durationMs||
      sample.sampleMs<sample.startMs||
      sample.sampleMs>=sample.endMs
    ) {
      throw safeError("video_timeline_helper_invalid");
    }
    maxGap=Math.max(maxGap,sample.endMs-sample.startMs);
    previousEnd=sample.endMs;
  }
  if (previousEnd!==value.durationMs||maxGap!==value.maxGapMs) {
    throw safeError("video_timeline_helper_invalid");
  }
}

function validateRangeSamples(value) {
  let previousEnd=value.startMs;
  let maxGap=0;
  for (const sample of value.samples) {
    if (
      !exact(sample,SAMPLE_FIELDS)||
      !Number.isSafeInteger(sample.startMs)||
      !Number.isSafeInteger(sample.endMs)||
      !Number.isSafeInteger(sample.sampleMs)||
      sample.startMs!==previousEnd||
      sample.endMs<=sample.startMs||
      sample.endMs>value.endMs||
      sample.sampleMs<sample.startMs||
      sample.sampleMs>=sample.endMs
    ) {
      throw safeError("video_timeline_helper_invalid");
    }
    maxGap=Math.max(maxGap,sample.endMs-sample.startMs);
    previousEnd=sample.endMs;
  }
  if (previousEnd!==value.endMs||maxGap!==value.maxGapMs) {
    throw safeError("video_timeline_helper_invalid");
  }
}

function validateSheets(value) {
  let nextSample=0;
  for (let index=0;index<value.sheets.length;index++) {
    const sheet=value.sheets[index];
    const expectedName=`timeline-${String(index+1).padStart(3,"0")}.png`;
    if (
      !exact(sheet,SHEET_FIELDS)||
      sheet.relativePath!==expectedName||
      !SHA.test(sheet.sha256||"")||
      !bounded(sheet.width,1,MAX_DIMENSION)||
      !bounded(sheet.height,1,MAX_DIMENSION)||
      !Number.isSafeInteger(sheet.firstSampleIndex)||
      !Number.isSafeInteger(sheet.lastSampleIndex)||
      sheet.firstSampleIndex!==nextSample||
      sheet.lastSampleIndex<sheet.firstSampleIndex||
      sheet.lastSampleIndex>=value.sampleCount||
      sheet.lastSampleIndex-sheet.firstSampleIndex>=12||
      sheet.startMs!==value.samples[sheet.firstSampleIndex].startMs||
      sheet.endMs!==value.samples[sheet.lastSampleIndex].endMs
    ) {
      throw safeError("video_timeline_helper_invalid");
    }
    nextSample=sheet.lastSampleIndex+1;
  }
  if (nextSample!==value.sampleCount) {
    throw safeError("video_timeline_helper_invalid");
  }
}

async function verifySheet({
  sheet,index,job,maxDimension,maxPixels
}) {
  if (
    sheet.relativePath!==
      `timeline-${String(index+1).padStart(3,"0")}.png`||
    isAbsolute(sheet.relativePath)||
    sheet.relativePath.includes("/")||
    sheet.relativePath.includes("\\")||
    sheet.relativePath.includes("\0")||
    !SHEET_NAME.test(sheet.relativePath)
  ) {
    throw safeError("video_timeline_helper_invalid");
  }
  const file=join(job,sheet.relativePath);
  try {
    const info=await lstat(file);
    const actual=await realpath(file);
    const actualJob=await realpath(job);
    const fromJob=relative(actualJob,actual);
    if (
      !info.isFile()||info.isSymbolicLink()||
      info.uid!==process.getuid()||(info.mode&0o077)!==0||
      info.size<24||
      fromJob.startsWith("..")||isAbsolute(fromJob)||
      resolve(actualJob,fromJob)!==actual
    ) {
      throw new Error("unsafe");
    }
    const dimensions=await readPngHeader(file);
    if (
      dimensions.width!==sheet.width||
      dimensions.height!==sheet.height||
      dimensions.width>maxDimension||
      dimensions.height>maxDimension||
      dimensions.width*dimensions.height>maxPixels
    ) {
      throw safeError("video_timeline_limit_exceeded");
    }
    if (await sha256File(file)!==sheet.sha256) {
      throw safeError("video_timeline_media_invalid");
    }
    return {file,byteSize:info.size};
  } catch (error) {
    if (SAFE_CODES.has(error?.message)) throw error;
    throw safeError("video_timeline_media_invalid");
  }
}

async function readPngHeader(file) {
  const handle=await open(file,"r");
  try {
    const header=Buffer.alloc(24);
    const {bytesRead}=await handle.read(header,0,header.length,0);
    if (
      bytesRead!==header.length||
      !header.subarray(0,8).equals(PNG_SIGNATURE)||
      header.readUInt32BE(8)!==13||
      header.toString("ascii",12,16)!=="IHDR"
    ) {
      throw safeError("video_timeline_media_invalid");
    }
    return {
      width:header.readUInt32BE(16),
      height:header.readUInt32BE(20)
    };
  } finally {
    await handle.close();
  }
}

async function sha256File(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

function safeEnvironment(value) {
  return plain(value)&&Object.entries(value).every(([key,item])=>
    /^[A-Z][A-Z0-9_]{0,63}$/u.test(key)&&
    typeof item==="string"&&
    Buffer.byteLength(item,"utf8")<=4_096&&
    !/(?:TOKEN|SECRET|PASSWORD|COOKIE|API_KEY|HOME)/u.test(key)
  );
}

function exact(value,fields) {
  return plain(value)&&
    Object.keys(value).length===fields.size&&
    Object.keys(value).every(key=>fields.has(key));
}

function plain(value) {
  return value!==null&&typeof value==="object"&&!Array.isArray(value)&&
    Object.getPrototypeOf(value)===Object.prototype;
}

function bounded(value,min,max) {
  return Number.isSafeInteger(value)&&value>=min&&value<=max;
}

function normalizeError(error) {
  if (SAFE_CODES.has(error?.message)) return safeError(error.message);
  if (error?.name==="AbortError") {
    return safeError("video_timeline_media_invalid");
  }
  return safeError("video_timeline_media_invalid");
}

function safeError(code) {
  return new Error(code);
}
