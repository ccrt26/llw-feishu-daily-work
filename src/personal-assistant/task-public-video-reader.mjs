import {createHash,randomUUID} from "node:crypto";
import {createReadStream} from "node:fs";
import {
  access,chmod,lstat,open,readFile,rename,realpath
} from "node:fs/promises";
import {isAbsolute,join,relative} from "node:path";
import {createSourceHandle} from "./source-handle.mjs";
import {
  appendDerivedRepresentation,
  createSourceSidecarManifest
} from "./source-sidecar-manifest.mjs";
import {
  validateModelImageEvidence
} from "./model-image-evidence.mjs";

const PRODUCED_BY="llw.public-video-reader.v1";
const MAX_INDEX_BYTES=768*1024;
const MAX_OBSERVATION_BYTES=256*1024;

export class TaskPublicVideoReader {
  constructor({asr,timelineReader}) {
    if (typeof asr?.transcribe!=="function"||
        typeof timelineReader?.read!=="function") {
      throw invalid();
    }
    this.asr=asr;
    this.timelineReader=timelineReader;
  }

  async prepare({
    workspaceDir,sources,signal,now,onProcessingAccepted
  }) {
    if (typeof workspaceDir!=="string"||!isAbsolute(workspaceDir)||
        !Array.isArray(sources)||sources.length>8||
        !(signal===undefined||signal instanceof AbortSignal)||
        !(onProcessingAccepted===undefined||
          typeof onProcessingAccepted==="function")||
        !canonicalIso(now)) {
      throw invalid();
    }
    await privateDirectory(workspaceDir);
    const notifyProcessingAccepted=onceBestEffort(
      onProcessingAccepted
    );
    const observations=[];
    const modelImageFiles=[];
    for (const source of sources) {
      const handle=createSourceHandle(source?.handle??source);
      if (handle.mediaClass!=="video") continue;
      signal?.throwIfAborted();
      const evidence=await this.prepareSource({
        workspaceDir,source,handle,signal,now,
        notifyProcessingAccepted
      });
      observations.push(evidence.observation);
      modelImageFiles.push(...evidence.modelImageFiles);
    }
    return Object.freeze({
      observations:Object.freeze(observations),
      modelImageFiles:Object.freeze(modelImageFiles)
    });
  }

  async prepareSource({
    workspaceDir,source,handle,signal,now,
    notifyProcessingAccepted
  }) {
    const videoFile=await validateOriginal({
      workspaceDir,source,handle
    });
    const manifestPath=join(
      workspaceDir,`${handle.sourceId}.manifest.json`
    );
    let manifest=await ensureSidecar({
      workspaceDir,manifestPath,handle,now
    });
    const retainedTranscript=await loadDerived({
      workspaceDir,manifest,kind:"transcript"
    });
    let transcript=retainedTranscript===null
      ?null
      :validateTranscript(retainedTranscript.value,handle);
    if (transcript===null) {
      const transcriptRelativePath=
        `${handle.sourceId}.transcript.json`;
      const orphanTranscript=await loadOptionalJson(
        join(workspaceDir,transcriptRelativePath)
      );
      if (orphanTranscript!==null) {
        transcript=validateTranscript(orphanTranscript,handle);
        await appendDerivedRepresentation({
          workspaceDir,manifestPath,
          entry:{
            kind:"transcript",
            relativePath:transcriptRelativePath,
            producedBy:PRODUCED_BY,
            limitations:transcript.limitations
          },
          now
        });
        manifest=await readManifest(manifestPath,handle);
      }
    }
    if (transcript===null) {
      const audioFile=join(
        workspaceDir,`${handle.sourceId}.audio.m4a`
      );
      const audioSha256=await validateAudio(audioFile,workspaceDir);
      let raw;
      try {
        raw=await this.asr.transcribe({
          audioFile,audioSha256,
          durationMs:handle.durationMs,
          signal,
          onProcessingAccepted:notifyProcessingAccepted
        });
      } catch (error) {
        if (error?.name==="AbortError") throw error;
        throw new Error("public_video_asr_failed");
      }
      transcript=buildTranscript({
        raw,handle,audioSha256
      });
      const relativePath=`${handle.sourceId}.transcript.json`;
      await atomicWriteJson(
        join(workspaceDir,relativePath),transcript
      );
      await appendDerivedRepresentation({
        workspaceDir,manifestPath,
        entry:{
          kind:"transcript",relativePath,
          producedBy:PRODUCED_BY,
          limitations:transcript.limitations
        },
        now
      });
      manifest=await readManifest(manifestPath,handle);
    }

    const retainedTimeline=await loadDerived({
      workspaceDir,manifest,kind:"timeline"
    });
    let timeline=retainedTimeline===null
      ?null
      :await validateTimeline({
        value:retainedTimeline.value,handle,workspaceDir
      });
    if (timeline===null) {
      const timelineRelativePath=
        `${handle.sourceId}.timeline.json`;
      const orphanTimeline=await loadOptionalJson(
        join(workspaceDir,timelineRelativePath)
      );
      if (orphanTimeline!==null) {
        timeline=await validateTimeline({
          value:orphanTimeline,handle,workspaceDir
        });
        await appendDerivedRepresentation({
          workspaceDir,manifestPath,
          entry:{
            kind:"timeline",
            relativePath:timelineRelativePath,
            producedBy:PRODUCED_BY,
            limitations:timeline.limitations
          },
          now
        });
      }
    }
    if (timeline===null) {
      await notifyProcessingAccepted();
      let raw;
      try {
        raw=await this.timelineReader.read({
          sourceId:handle.sourceId,
          videoFile,
          videoSha256:handle.sha256,
          durationMs:handle.durationMs,
          workspaceDir,
          signal
        });
      } catch (error) {
        if (error?.name==="AbortError") throw error;
        throw new Error("public_video_timeline_failed");
      }
      timeline=await buildTimeline({
        raw,handle,workspaceDir
      });
      const relativePath=`${handle.sourceId}.timeline.json`;
      await atomicWriteJson(
        join(workspaceDir,relativePath),timeline
      );
      await appendDerivedRepresentation({
        workspaceDir,manifestPath,
        entry:{
          kind:"timeline",relativePath,
          producedBy:PRODUCED_BY,
          limitations:timeline.limitations
        },
        now
      });
    }

    const transcriptPath=join(
      workspaceDir,`${handle.sourceId}.transcript.json`
    );
    const transcriptSha256=await sha256File(transcriptPath);
    const content=JSON.stringify({
      kind:"public_video",
      transcript,
      visualTimeline:{
        durationMs:timeline.durationMs,
        sampleCount:timeline.sampleCount,
        maxGapMs:timeline.maxGapMs,
        samples:timeline.samples,
        images:timeline.images,
        coverageStatus:timeline.coverageStatus,
        limitations:timeline.limitations
      }
    });
    if (Buffer.byteLength(content,"utf8")>MAX_OBSERVATION_BYTES) {
      throw invalid();
    }
    return Object.freeze({
      observation:Object.freeze({
        sourceId:handle.sourceId,
        view:"transcribe_audio",
        derivedRelativePath:
          `${handle.sourceId}.transcript.json`,
        sha256:transcriptSha256,
        producedBy:PRODUCED_BY,
        content,
        limitations:Object.freeze(unique([
          ...transcript.limitations,...timeline.limitations
        ]))
      }),
      modelImageFiles:Object.freeze(
        timeline.images.map(item=>Object.freeze({...item}))
      )
    });
  }
}

function onceBestEffort(operation) {
  let invoked=false;
  let result=Promise.resolve();
  return ()=>{
    if (invoked) return result;
    invoked=true;
    result=typeof operation==="function"
      ?Promise.resolve().then(operation).catch(()=>{})
      :Promise.resolve();
    return result;
  };
}

async function ensureSidecar({
  workspaceDir,manifestPath,handle,now
}) {
  try {
    return await readManifest(manifestPath,handle);
  } catch (error) {
    if (error?.code!=="ENOENT") throw invalid();
  }
  await createSourceSidecarManifest({
    workspaceDir,
    original:{
      sourceId:handle.sourceId,
      relativePath:handle.relativePath,
      byteSize:handle.byteSize,
      sha256:handle.sha256,
      mime:"video/mp4",
      durationMs:handle.durationMs
    },
    now
  });
  return readManifest(manifestPath,handle);
}

async function readManifest(file,handle) {
  const value=JSON.parse(await readBounded(file,MAX_INDEX_BYTES));
  if (!plain(value)||value.version!==1||
      !plain(value.original)||
      value.original.sourceId!==handle.sourceId||
      value.original.relativePath!==handle.relativePath||
      value.original.byteSize!==handle.byteSize||
      value.original.sha256!==handle.sha256||
      value.original.mime!=="video/mp4"||
      value.original.durationMs!==handle.durationMs||
      !Array.isArray(value.derived)||
      value.derived.length>32) {
    throw invalid();
  }
  return value;
}

async function loadDerived({workspaceDir,manifest,kind}) {
  const entries=manifest.derived.filter(item=>item.kind===kind);
  if (!entries.length) return null;
  if (entries.length!==1) throw invalid();
  const entry=entries[0];
  const file=join(workspaceDir,entry.relativePath);
  if (await sha256File(file)!==entry.sha256) throw invalid();
  return {
    entry,
    value:JSON.parse(await readBounded(file,MAX_INDEX_BYTES))
  };
}

function buildTranscript({raw,handle,audioSha256}) {
  if (!plain(raw)||raw.audioSha256!==audioSha256) throw invalid();
  return validateTranscript({
    version:1,
    sourceId:handle.sourceId,
    originalDurationMs:handle.durationMs,
    providerDurationMs:raw.providerDurationMs,
    engine:"external_video_asr",
    runtime:{
      providerId:raw.providerId,
      apiVersion:raw.apiVersion,
      resourceId:raw.resourceId,
      requestProfile:raw.requestProfile
    },
    audioSha256,
    segments:raw.segments,
    coveredRanges:raw.coveredRanges,
    uncoveredRanges:raw.uncoveredRanges,
    coverageStatus:raw.coverageStatus,
    limitations:raw.limitations
  },handle);
}

function validateTranscript(value,handle) {
  if (!plain(value)||value.version!==1||
      value.sourceId!==handle.sourceId||
      value.originalDurationMs!==handle.durationMs||
      value.engine!=="external_video_asr"||
      !plain(value.runtime)||
      value.runtime.providerId!=="volcengine"||
      typeof value.runtime.apiVersion!=="string"||
      typeof value.runtime.resourceId!=="string"||
      typeof value.runtime.requestProfile!=="string"||
      !/^[a-f0-9]{64}$/u.test(value.audioSha256||"")||
      !Number.isSafeInteger(value.providerDurationMs)||
      Math.abs(value.providerDurationMs-handle.durationMs)>5_000||
      !Array.isArray(value.segments)||value.segments.length>2_048||
      !ranges(value.coveredRanges)||!ranges(value.uncoveredRanges)||
      value.coverageStatus!=="complete"||
      !limitations(value.limitations)) {
    throw invalid();
  }
  let previousEnd=0;
  for (const segment of value.segments) {
    if (!plain(segment)||
        !Number.isSafeInteger(segment.startMs)||
        !Number.isSafeInteger(segment.endMs)||
        segment.startMs<previousEnd||
        segment.endMs<=segment.startMs||
        segment.endMs>value.providerDurationMs||
        typeof segment.text!=="string"||!segment.text.trim()||
        !Array.isArray(segment.alternatives)||
        segment.isFinal!==true||
        typeof segment.status!=="string") {
      throw invalid();
    }
    previousEnd=segment.endMs;
  }
  return structuredClone(value);
}

async function buildTimeline({raw,handle,workspaceDir}) {
  return validateTimeline({
    value:{
      version:1,
      sourceId:handle.sourceId,
      originalSha256:handle.sha256,
      kind:"video_timeline",
      durationMs:raw?.durationMs,
      sampleCount:raw?.sampleCount,
      maxGapMs:raw?.maxGapMs,
      samples:raw?.samples,
      images:raw?.images,
      coverageStatus:"complete",
      limitations:raw?.limitations
    },
    handle,workspaceDir
  });
}

async function validateTimeline({value,handle,workspaceDir}) {
  if (!plain(value)||value.version!==1||
      value.sourceId!==handle.sourceId||
      value.originalSha256!==handle.sha256||
      value.kind!=="video_timeline"||
      value.durationMs!==handle.durationMs||
      !Number.isSafeInteger(value.sampleCount)||
      value.sampleCount<1||value.sampleCount>192||
      !Number.isSafeInteger(value.maxGapMs)||value.maxGapMs<1||
      !Array.isArray(value.samples)||
      value.samples.length!==value.sampleCount||
      !Array.isArray(value.images)||value.images.length<1||
      value.images.length>16||
      value.coverageStatus!=="complete"||
      !limitations(value.limitations)) {
    throw invalid();
  }
  let previousEnd=0,maxGap=0;
  for (const sample of value.samples) {
    if (!plain(sample)||sample.startMs!==previousEnd||
        !Number.isSafeInteger(sample.endMs)||
        sample.endMs<=sample.startMs||
        sample.endMs>handle.durationMs||
        !Number.isSafeInteger(sample.sampleMs)||
        sample.sampleMs<sample.startMs||
        sample.sampleMs>=sample.endMs) {
      throw invalid();
    }
    maxGap=Math.max(maxGap,sample.endMs-sample.startMs);
    previousEnd=sample.endMs;
  }
  if (previousEnd!==handle.durationMs||maxGap!==value.maxGapMs) {
    throw invalid();
  }
  await validateModelImageEvidence({
    workspaceDir,files:value.images
  });
  return structuredClone(value);
}

async function validateOriginal({workspaceDir,source,handle}) {
  if (handle.mediaClass!=="video"||handle.format!=="mp4"||
      handle.representationIndexPath!==
        `${handle.sourceId}.manifest.json`||
      !Number.isSafeInteger(handle.durationMs)) {
    throw invalid();
  }
  const file=source?.absolutePath;
  if (typeof file!=="string"||!isAbsolute(file)) throw invalid();
  const actualWorkspace=await realpath(workspaceDir);
  const actual=await realpath(file);
  const fromWorkspace=relative(actualWorkspace,actual);
  const info=await lstat(actual);
  if (!info.isFile()||info.isSymbolicLink()||
      info.uid!==process.getuid()||(info.mode&0o077)!==0||
      info.size!==handle.byteSize||
      fromWorkspace.startsWith("..")||isAbsolute(fromWorkspace)||
      await sha256File(actual)!==handle.sha256) {
    throw invalid();
  }
  return actual;
}

async function validateAudio(file,workspaceDir) {
  const actualWorkspace=await realpath(workspaceDir);
  const actual=await realpath(file);
  const fromWorkspace=relative(actualWorkspace,actual);
  const info=await lstat(actual);
  if (!info.isFile()||info.isSymbolicLink()||
      info.uid!==process.getuid()||(info.mode&0o077)!==0||
      info.size<12||
      fromWorkspace.startsWith("..")||isAbsolute(fromWorkspace)) {
    throw invalid();
  }
  return sha256File(actual);
}

async function atomicWriteJson(file,value) {
  const bytes=Buffer.from(`${JSON.stringify(value,null,2)}\n`,"utf8");
  if (bytes.length>MAX_INDEX_BYTES) throw invalid();
  try {
    await access(file);
    throw invalid();
  } catch (error) {
    if (error?.message==="task_public_video_reader_invalid") {
      throw error;
    }
    if (error?.code!=="ENOENT") throw invalid();
  }
  const temporary=`${file}.${randomUUID()}.tmp`;
  const handle=await open(temporary,"wx",0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary,file);
  await chmod(file,0o600);
}

async function readBounded(file,maxBytes) {
  const info=await lstat(file);
  if (!info.isFile()||info.isSymbolicLink()||
      info.uid!==process.getuid()||(info.mode&0o077)!==0||
      info.size<2||info.size>maxBytes) {
    throw invalid();
  }
  return readFile(file,"utf8");
}

async function loadOptionalJson(file) {
  try {
    return JSON.parse(await readBounded(file,MAX_INDEX_BYTES));
  } catch (error) {
    if (error?.code==="ENOENT") return null;
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

async function sha256File(file) {
  const hash=createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function ranges(value) {
  return Array.isArray(value)&&value.length<=2_048&&
    value.every(item=>plain(item)&&
      Number.isSafeInteger(item.startMs)&&item.startMs>=0&&
      Number.isSafeInteger(item.endMs)&&item.endMs>item.startMs);
}

function limitations(value) {
  return Array.isArray(value)&&value.length<=8&&
    value.every(item=>typeof item==="string"&&item&&
      Buffer.byteLength(item,"utf8")<=1_000);
}

function unique(values) {
  return [...new Set(values)].slice(0,8);
}

function canonicalIso(value) {
  return typeof value==="string"&&Number.isFinite(Date.parse(value))&&
    new Date(value).toISOString()===value;
}

function plain(value) {
  return value!==null&&typeof value==="object"&&!Array.isArray(value)&&
    Object.getPrototypeOf(value)===Object.prototype;
}

function invalid() {
  return new Error("task_public_video_reader_invalid");
}
