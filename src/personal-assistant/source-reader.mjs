import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {lstat,realpath} from "node:fs/promises";
import {isAbsolute,join,relative} from "node:path";
import {
  validateSourceReadRequest
} from "./source-read-request.mjs";

const MAX_CONTENT_BYTES=256*1024;

export class SourceReader {
  constructor({backends}) {
    if (!backends||typeof backends!=="object"||
        Array.isArray(backends)||
        !Object.values(backends).every(value=>typeof value==="function")) {
      throw new Error("source_reader_invalid");
    }
    this.backends={...backends};
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
      raw:requests,availableSources:sources
    });
    const actualWorkspace=await validateWorkspace(workspaceDir);
    const byId=new Map(sources.map(binding=>{
      const handle=binding?.handle??binding;
      return [handle.sourceId,binding];
    }));
    const observations=[];
    for (const request of normalized) {
      signal?.throwIfAborted();
      const key=`${actualWorkspace}\0${JSON.stringify(request)}`;
      if (this.cache.has(key)) {
        observations.push(structuredClone(this.cache.get(key)));
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
      const observation=await validateObservation({
        raw,request,workspaceDir:actualWorkspace
      });
      this.cache.set(key,observation);
      observations.push(structuredClone(observation));
    }
    return Object.freeze({
      observations:Object.freeze(
        observations.map(value=>Object.freeze(value))
      )
    });
  }
}

async function validateObservation({raw,request,workspaceDir}) {
  if (!raw||typeof raw!=="object"||Array.isArray(raw)||
      Object.keys(raw).length!==5||
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
      )) {
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
    sourceId:request.sourceId,
    view:request.view,
    derivedRelativePath:raw.derivedRelativePath,
    sha256:raw.sha256,
    producedBy:raw.producedBy,
    content:raw.content,
    limitations:Object.freeze([...raw.limitations])
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
