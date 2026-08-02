import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {spawn} from "node:child_process";
import {
  chmod,constants as fsConstants,copyFile,lstat,mkdir,mkdtemp,
  open,readdir,realpath,rm,writeFile
} from "node:fs/promises";
import {isAbsolute,join,relative,resolve} from "node:path";
import {
  publishTaskDocxEvidence,reuseTaskDocxEvidence
} from "./task-docx-evidence.mjs";

const PNG_SIGNATURE=Buffer.from([
  0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a
]);
const MAX_HELPER_OUTPUT_BYTES=2*1024*1024;
const PRODUCED_BY="llw-task-docx-reader-v1";

export class TaskDocxReader {
  constructor({
    helperPath,tempRoot,runHelper=runDocxEvidenceHelper,
    timeoutMs=60_000,maxTextBytes=220_000,maxImages=16
  }) {
    if (typeof helperPath!=="string"||!isAbsolute(helperPath)||
        typeof tempRoot!=="string"||!isAbsolute(tempRoot)||
        typeof runHelper!=="function"||!bounded(timeoutMs,1,60_000)||
        !bounded(maxTextBytes,1,220_000)||!bounded(maxImages,0,16)) {
      throw new Error("task_docx_reader_invalid");
    }
    this.helperPath=helperPath;
    this.tempRoot=tempRoot;
    this.runHelper=runHelper;
    this.timeoutMs=timeoutMs;
    this.maxTextBytes=maxTextBytes;
    this.maxImages=maxImages;
  }

  async prepare({workspaceDir,sources,signal,now}={}) {
    if (typeof workspaceDir!=="string"||!isAbsolute(workspaceDir)||
        !Array.isArray(sources)||sources.length>8||
        !(signal===undefined||signal instanceof AbortSignal)||
        !canonicalIso(now)) throw new Error("docx_prepare_failed");
    signal?.throwIfAborted();
    const deadline=new AbortController();
    const timer=setTimeout(()=>{
      deadline.abort(new Error("docx_prepare_timeout"));
    },this.timeoutMs);
    const combined=signal
      ?AbortSignal.any([signal,deadline.signal])
      :deadline.signal;
    try {
      return await this.prepareAll({workspaceDir,sources,signal:combined,now});
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error?.name==="AbortError") throw error;
      throw new Error("docx_prepare_failed");
    } finally {
      clearTimeout(timer);
    }
  }

  async prepareAll({workspaceDir,sources,signal,now}) {
    signal.throwIfAborted();
    const observations=[];
    const modelImageFiles=[];
    const coverageBySource={};
    const docxSources=sources.filter(source=>(source?.handle??source)?.format==="docx");
    if (docxSources.length===0) {
      return freezeResult({observations,modelImageFiles,coverageBySource});
    }
    await this.ensureTempRoot();
    for (const source of docxSources) {
      signal.throwIfAborted();
      let evidence=await reuseTaskDocxEvidence({
        workspaceDir,source,signal
      });
      if (!evidence) {
        evidence=await this.prepareOne({
          workspaceDir,source,signal,now,
          maxImages:Math.max(0,this.maxImages-modelImageFiles.length)
        });
      }
      const sourceId=source.handle.sourceId;
      if (coverageBySource[sourceId]) throw new Error("task_docx_reader_invalid");
      observations.push(...evidence.observations);
      modelImageFiles.push(...evidence.modelImageFiles);
      coverageBySource[sourceId]=evidence.coverage;
    }
    return freezeResult({observations,modelImageFiles,coverageBySource});
  }

  async prepareOne({workspaceDir,source,signal,now,maxImages}) {
    const job=await mkdtemp(join(this.tempRoot,"llw-task-docx-"));
    await chmod(job,0o700);
    try {
      signal.throwIfAborted();
      const sourceCopy=join(job,"source.docx");
      await copyFile(source.absolutePath,sourceCopy,fsConstants.COPYFILE_EXCL);
      await chmod(sourceCopy,0o600);
      if (await sha256File(sourceCopy)!==source.handle.sha256) {
        throw new Error("task_docx_reader_invalid");
      }
      const outputDir=join(job,"output");
      await mkdir(outputDir,{mode:0o700});
      await chmod(outputDir,0o700);
      const helperResult=await this.runHelper({
        helperPath:this.helperPath,
        job:{
          inputPath:sourceCopy,expectedSha256:source.handle.sha256,
          outputDir,
          limits:{maxTextBytes:this.maxTextBytes,maxImages}
        },
        signal
      });
      signal.throwIfAborted();
      const prepared=await validateHelperResult({
        value:helperResult,source,outputDir
      });
      const textValue={
        version:1,sourceId:source.handle.sourceId,
        originalSha256:source.handle.sha256,
        observations:prepared.observations
      };
      const textBytes=Buffer.from(
        `${JSON.stringify(textValue,null,2)}\n`,"utf8"
      );
      const stagedText=join(job,"docx-text.json");
      await writeFile(stagedText,textBytes,{flag:"wx",mode:0o600});
      await chmod(stagedText,0o600);
      const sourceId=source.handle.sourceId;
      const text={
        relativePath:`${sourceId}.docx-text.json`,
        sha256:sha256Bytes(textBytes),byteSize:textBytes.length,
        observationCount:prepared.observations.length
      };
      const images=prepared.images.map((image,index)=>({
        relativePath:
          `${sourceId}.docx-image-${String(index+1).padStart(3,"0")}.png`,
        sha256:image.sha256,byteSize:image.byteSize,
        width:image.width,height:image.height,
        documentOrder:image.documentOrder,
        ownerPartName:image.ownerPartName,
        relationshipId:image.relationshipId,
        targetMediaPartName:image.targetMediaPartName
      }));
      return await publishTaskDocxEvidence({
        workspaceDir,source,
        stagedFiles:[
          {absolutePath:stagedText,relativePath:text.relativePath},
          ...prepared.images.map((image,index)=>({
            absolutePath:image.absolutePath,
            relativePath:images[index].relativePath
          }))
        ],
        representationIndex:{
          version:1,sourceId,originalSha256:source.handle.sha256,
          kind:"docx",text,images,coverage:prepared.coverage
        },
        producedBy:PRODUCED_BY,now,signal
      });
    } finally {
      await rm(job,{recursive:true,force:true});
    }
  }

  async ensureTempRoot() {
    try {
      await ensurePrivateTempRoot(this.tempRoot);
    } catch {
      throw new Error("task_docx_reader_invalid");
    }
  }
}

export async function scavengeTaskDocxTempRoot(tempRoot) {
  if (typeof tempRoot!=="string"||!isAbsolute(tempRoot)) {
    throw new Error("task_docx_scavenge_invalid");
  }
  try {
    await ensurePrivateTempRoot(tempRoot);
    for (const entry of await readdir(tempRoot,{withFileTypes:true})) {
      if (!/^llw-task-docx-[A-Za-z0-9_-]{1,128}$/u.test(entry.name)) {
        continue;
      }
      const path=join(tempRoot,entry.name);
      const info=await lstat(path);
      if (!entry.isDirectory()||!info.isDirectory()||info.isSymbolicLink()||
          info.uid!==process.getuid()||(info.mode&0o077)!==0) {
        throw new Error("invalid_job");
      }
      await rm(path,{recursive:true,force:true});
    }
  } catch {
    throw new Error("task_docx_scavenge_invalid");
  }
}

async function ensurePrivateTempRoot(directory) {
  await mkdir(directory,{recursive:true,mode:0o700});
  const before=await lstat(directory);
  if (!before.isDirectory()||before.isSymbolicLink()||
      before.uid!==process.getuid()) throw new Error("unsafe_root");
  await chmod(directory,0o700);
  const after=await lstat(directory);
  if (!after.isDirectory()||after.isSymbolicLink()||
      after.uid!==process.getuid()||(after.mode&0o077)!==0) {
    throw new Error("unsafe_root");
  }
  await realpath(directory);
}

export function runDocxEvidenceHelper({helperPath,job,signal}) {
  if (typeof helperPath!=="string"||!isAbsolute(helperPath)||
      !job||typeof job!=="object"||
      !(signal instanceof AbortSignal)) {
    return Promise.reject(new Error("docx_helper_invalid"));
  }
  return new Promise((resolvePromise,rejectPromise)=>{
    let settled=false;
    const stdout=[];
    let stdoutBytes=0,stderrBytes=0;
    const child=spawn(process.execPath,[helperPath],{
      cwd:job.outputDir,
      stdio:["pipe","pipe","pipe"],
      env:{
        PATH:process.env.PATH||"/usr/bin:/bin",
        LANG:"en_US.UTF-8"
      }
    });
    const finish=(error,value)=>{
      if (settled) return;
      settled=true;
      signal.removeEventListener("abort",onAbort);
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const onAbort=()=>{
      child.kill("SIGKILL");
      finish(signal.reason||new Error("docx_helper_aborted"));
    };
    signal.addEventListener("abort",onAbort,{once:true});
    if (signal.aborted) {
      onAbort();
      return;
    }
    child.stdout.on("data",chunk=>{
      stdoutBytes+=chunk.length;
      if (stdoutBytes>MAX_HELPER_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(new Error("docx_helper_output_invalid"));
      } else stdout.push(chunk);
    });
    child.stderr.on("data",chunk=>{
      stderrBytes+=chunk.length;
      if (stderrBytes>4096) {
        child.kill("SIGKILL");
        finish(new Error("docx_helper_output_invalid"));
      }
    });
    child.once("error",error=>finish(error));
    child.once("close",code=>{
      if (settled) return;
      if (code!==0) {
        finish(new Error("docx_helper_failed"));
        return;
      }
      try {
        finish(null,JSON.parse(Buffer.concat(stdout).toString("utf8")));
      } catch {
        finish(new Error("docx_helper_output_invalid"));
      }
    });
    child.stdin.on("error",error=>finish(error));
    child.stdin.end(JSON.stringify(job));
  });
}

async function validateHelperResult({value,source,outputDir}) {
  if (!exact(value,new Set([
    "originalSha256","observations","imageCandidates","coverage"
  ]))||value.originalSha256!==source.handle.sha256||
      !Array.isArray(value.observations)||
      !Array.isArray(value.imageCandidates)||value.imageCandidates.length>16||
      !exact(value.coverage,new Set(["status","limitations","parts"]))||
      !new Set(["complete","partial"]).has(value.coverage.status)||
      !safeLimitations(value.coverage.limitations)||
      (value.coverage.status==="complete")!==
        (value.coverage.limitations.length===0)||
      !exact(value.coverage.parts,new Set([
        "parsed","relationships","representedMedia"
      ]))) throw new Error("task_docx_reader_invalid");
  for (const key of ["parsed","relationships","representedMedia"]) {
    const list=value.coverage.parts[key];
    if (!Array.isArray(list)||list.length>2048||
        !sameSortedUnique(list)||list.some(item=>!safePackagePart(item))) {
      throw new Error("task_docx_reader_invalid");
    }
  }
  const images=[];
  let lastOrder=0;
  for (const [index,candidate] of value.imageCandidates.entries()) {
    if (!exact(candidate,new Set([
      "documentOrder","ownerPartName","relationshipId",
      "targetMediaPartName","jobRelativePath","sha256"
    ]))||candidate.jobRelativePath!==
        `image-${String(index+1).padStart(3,"0")}.png`||
        !/^[a-f0-9]{64}$/u.test(candidate.sha256||"")||
        !bounded(candidate.documentOrder,1,8_999_999)||
        candidate.documentOrder<=lastOrder) {
      throw new Error("task_docx_reader_invalid");
    }
    const absolutePath=join(outputDir,candidate.jobRelativePath);
    const info=await privateJobFile(absolutePath,outputDir);
    if (await sha256File(absolutePath)!==candidate.sha256) {
      throw new Error("task_docx_reader_invalid");
    }
    const {width,height}=await readPngHeader(absolutePath);
    images.push(Object.freeze({
      ...structuredClone(candidate),absolutePath,byteSize:info.size,width,height
    }));
    lastOrder=candidate.documentOrder;
  }
  const actual=(await readdir(outputDir)).sort();
  const expected=value.imageCandidates.map(item=>item.jobRelativePath).sort();
  if (JSON.stringify(actual)!==JSON.stringify(expected)) {
    throw new Error("task_docx_reader_invalid");
  }
  return {
    observations:structuredClone(value.observations),
    images,
    coverage:structuredClone(value.coverage)
  };
}

async function privateJobFile(file,outputDir) {
  const info=await lstat(file);
  const actual=await realpath(file);
  const actualOutput=await realpath(outputDir);
  const inside=relative(actualOutput,actual);
  if (!info.isFile()||info.isSymbolicLink()||
      info.uid!==process.getuid()||(info.mode&0o077)!==0||
      inside.startsWith("..")||isAbsolute(inside)||
      resolve(actualOutput,inside)!==actual) {
    throw new Error("task_docx_reader_invalid");
  }
  return info;
}

async function readPngHeader(file) {
  const handle=await open(file,"r");
  try {
    const header=Buffer.alloc(24);
    const {bytesRead}=await handle.read(header,0,header.length,0);
    if (bytesRead!==header.length||
        !header.subarray(0,8).equals(PNG_SIGNATURE)||
        header.readUInt32BE(8)!==13||
        header.toString("ascii",12,16)!=="IHDR") {
      throw new Error("task_docx_reader_invalid");
    }
    const width=header.readUInt32BE(16);
    const height=header.readUInt32BE(20);
    if (!width||!height||width>3508||height>3508||
        width*height>12_306_064) throw new Error("task_docx_reader_invalid");
    return {width,height};
  } finally { await handle.close(); }
}

async function sha256File(file) {
  const hash=createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function freezeResult({observations,modelImageFiles,coverageBySource}) {
  return Object.freeze({
    observations:Object.freeze([...observations]),
    modelImageFiles:Object.freeze([...modelImageFiles]),
    coverageBySource:Object.freeze({...coverageBySource})
  });
}

function safeLimitations(value) {
  return Array.isArray(value)&&value.length<=32&&sameSortedUnique(value)&&
    value.every(item=>typeof item==="string"&&
      /^[a-z0-9_]{1,64}$/u.test(item));
}

function sameSortedUnique(value) {
  return new Set(value).size===value.length&&
    JSON.stringify(value)===JSON.stringify([...value].sort());
}

function safePackagePart(value) {
  return typeof value==="string"&&value.length>0&&value.length<=512&&
    !value.startsWith("/")&&!value.includes("\\")&&!value.includes("\0")&&
    value.split("/").every(part=>part&&part!=="."&&part!=="..");
}

function exact(value,fields) {
  return value&&typeof value==="object"&&!Array.isArray(value)&&
    Object.getPrototypeOf(value)===Object.prototype&&
    Object.keys(value).length===fields.size&&
    Object.keys(value).every(key=>fields.has(key));
}

function bounded(value,min,max) {
  return Number.isSafeInteger(value)&&value>=min&&value<=max;
}

function canonicalIso(value) {
  return typeof value==="string"&&Number.isFinite(Date.parse(value))&&
    new Date(value).toISOString()===value;
}
