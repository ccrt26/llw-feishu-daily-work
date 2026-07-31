import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {lstat,realpath} from "node:fs/promises";
import {isAbsolute,join,relative} from "node:path";
import {
  validateSourceReadRequest
} from "./source-read-request.mjs";
import {
  validateModelImageEvidence
} from "./model-image-evidence.mjs";

const MAX_CONTENT_BYTES=256*1024;

export class SourceReader {
  constructor({
    backends,
    maxRequests=8,
    maxRangeMs=60_000,
    maxTotalRangeMs=180_000,
    maxModelImageFiles=16
  }) {
    if (!backends||typeof backends!=="object"||
        Array.isArray(backends)||
        !Object.values(backends).every(value=>typeof value==="function")||
        !bounded(maxRequests,1,8)||
        !bounded(maxRangeMs,1,60_000)||
        !bounded(maxTotalRangeMs,maxRangeMs,180_000)||
        !bounded(maxModelImageFiles,1,16)) {
      throw new Error("source_reader_invalid");
    }
    this.backends={...backends};
    this.maxRequests=maxRequests;
    this.maxRangeMs=maxRangeMs;
    this.maxTotalRangeMs=maxTotalRangeMs;
    this.maxModelImageFiles=maxModelImageFiles;
    this.cache=new Map();
  }

  async read({
    requests,sources,workspaceDir,signal
  }) {
    if (typeof workspaceDir!=="string"||!isAbsolute(workspaceDir)||
        !Array.isArray(sources)||
        !(signal===undefined||signal instanceof AbortSignal)) {
      throw new Error("source_reader_invalid");
    }
    signal?.throwIfAborted();
    const normalized=validateSourceReadRequest({
      raw:requests,
      availableSources:sources,
      maxRequests:this.maxRequests,
      maxRangeMs:this.maxRangeMs,
      maxTotalRangeMs:this.maxTotalRangeMs
    });
    const actualWorkspace=await validateWorkspace(workspaceDir);
    const byId=new Map(sources.map(binding=>{
      const handle=binding?.handle??binding;
      return [handle.sourceId,binding];
    }));
    const observations=[];
    const modelImageFiles=[];
    for (const request of normalized) {
      signal?.throwIfAborted();
      const key=`${actualWorkspace}\0${JSON.stringify(request)}`;
      if (this.cache.has(key)) {
        const cached=structuredClone(this.cache.get(key));
        observations.push(cached.observation);
        modelImageFiles.push(...cached.modelImageFiles);
        continue;
      }
      const backend=this.backends[request.view];
      if (!backend) throw new Error("source_reader_unsupported");
      const raw=await backend({
        request:structuredClone(request),
        source:byId.get(request.sourceId),
        workspaceDir:actualWorkspace,
        signal
      });
      signal?.throwIfAborted();
      const validated=await validateObservation({
        raw,request,workspaceDir:actualWorkspace
      });
      try {
        await validateModelImageEvidence({
          workspaceDir:actualWorkspace,
          files:validated.modelImageFiles,
          maxFiles:1
        });
      } catch {
        throw new Error("source_reader_result_invalid");
      }
      this.cache.set(key,validated);
      observations.push(structuredClone(validated.observation));
      modelImageFiles.push(...structuredClone(validated.modelImageFiles));
    }
    try {
      await validateModelImageEvidence({
        workspaceDir:actualWorkspace,
        files:modelImageFiles,
        maxFiles:this.maxModelImageFiles
      });
    } catch {
      throw new Error("source_reader_result_invalid");
    }
    return Object.freeze({
      observations:Object.freeze(
        observations.map(value=>Object.freeze(value))
      ),
      modelImageFiles:Object.freeze(
        modelImageFiles.map(value=>Object.freeze(value))
      )
    });
  }
}

async function validateObservation({raw,request,workspaceDir}) {
  const interval=request.view==="inspect_time_range";
  const expectedFields=interval?6:5;
  if (!raw||typeof raw!=="object"||Array.isArray(raw)||
      Object.keys(raw).length!==expectedFields||
      typeof raw.content!=="string"||!raw.content.trim()||
      Buffer.byteLength(raw.content,"utf8")>MAX_CONTENT_BYTES||
      !safeRelative(raw.derivedRelativePath,request.sourceId)||
      !/^[a-f0-9]{64}$/u.test(raw.sha256||"")||
      typeof raw.producedBy!=="string"||
      !/^[A-Za-z0-9._-]{1,128}$/u.test(raw.producedBy)||
      !Array.isArray(raw.limitations)||raw.limitations.length>8||
      raw.limitations.some(value=>
        typeof value!=="string"||!value||
        Buffer.byteLength(value,"utf8")>1_000
      )||
      (
        interval&&(
          !Array.isArray(raw.modelImageFiles)||
          raw.modelImageFiles.length!==1||
          raw.modelImageFiles.some(value=>
            !value||typeof value!=="object"||Array.isArray(value)||
            value.sourceId!==request.sourceId||
            value.startMs!==request.startMs||
            value.endMs!==request.endMs
          )
        )
      )||
      (!interval&&Object.hasOwn(raw,"modelImageFiles"))) {
    throw new Error("source_reader_result_invalid");
  }
  const file=join(workspaceDir,raw.derivedRelativePath);
  const info=await lstat(file);
  const actual=await realpath(file);
  const fromWorkspace=relative(workspaceDir,actual);
  if (!info.isFile()||info.isSymbolicLink()||
      info.uid!==process.getuid()||(info.mode&0o077)!==0||
      fromWorkspace.startsWith("..")||isAbsolute(fromWorkspace)||
      await sha256(actual)!==raw.sha256) {
    throw new Error("source_reader_result_invalid");
  }
  return Object.freeze({
    observation:Object.freeze({
      sourceId:request.sourceId,
      view:request.view,
      derivedRelativePath:raw.derivedRelativePath,
      sha256:raw.sha256,
      producedBy:raw.producedBy,
      content:raw.content,
      limitations:Object.freeze([...raw.limitations])
    }),
    modelImageFiles:Object.freeze(
      interval
        ?raw.modelImageFiles.map(value=>Object.freeze({...value}))
        :[]
    )
  });
}

async function validateWorkspace(value) {
  const info=await lstat(value);
  if (!info.isDirectory()||info.isSymbolicLink()||
      info.uid!==process.getuid()||(info.mode&0o077)!==0) {
    throw new Error("source_reader_invalid");
  }
  return realpath(value);
}

function safeRelative(value,sourceId) {
  return typeof value==="string"&&!isAbsolute(value)&&
    !value.includes("/")&&!value.includes("\\")&&
    !value.includes("\0")&&value.startsWith(`${sourceId}.`)&&
    /^[A-Za-z0-9._-]+$/u.test(value);
}

async function sha256(file) {
  const hash=createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function bounded(value,min,max) {
  return Number.isSafeInteger(value)&&value>=min&&value<=max;
}
