import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {
  lstat,readFile,realpath
} from "node:fs/promises";
import {isAbsolute,join,relative,resolve} from "node:path";
import {createSourceHandle} from "./source-handle.mjs";

const MAX_MANIFEST_BYTES=768*1024;
const HASH=/^[a-f0-9]{64}$/u;

export async function resolveKnowledgeEvidence({
  workspaceDir,sourceBindings,evidenceSourceIds,sourceIds
}) {
  try {
    if (typeof workspaceDir!=="string"||!isAbsolute(workspaceDir)||
        !Array.isArray(sourceBindings)||sourceBindings.length>8||
        !sourceIdList(evidenceSourceIds)||
        !sourceIdList(sourceIds)||
        sourceIds.some(id=>!evidenceSourceIds.includes(id))) reject();
    const actualWorkspace=await privateDirectory(workspaceDir);
    const bindings=new Map();
    for (const input of sourceBindings) {
      const handle=createSourceHandle(input?.handle??input);
      if (bindings.has(handle.sourceId)||
          typeof input?.absolutePath!=="string"||
          !isAbsolute(input.absolutePath)) reject();
      bindings.set(handle.sourceId,{handle,path:input.absolutePath});
    }
    const evidenceSources=[];
    for (const sourceId of evidenceSourceIds) {
      const binding=bindings.get(sourceId);
      if (!binding) reject();
      await verifyOriginal({
        workspaceDir:actualWorkspace,
        file:binding.path,
        handle:binding.handle
      });
      evidenceSources.push(
        binding.handle.mediaClass==="video"
          ?await videoEvidence({
            workspaceDir:actualWorkspace,
            handle:binding.handle
          })
          :basicEvidence(binding.handle)
      );
    }
    evidenceSources.sort((a,b)=>a.sourceId.localeCompare(b.sourceId));
    return Object.freeze({
      evidenceSources:Object.freeze(
        evidenceSources.map(value=>deepFreeze(value))
      ),
      sourceSetDigest:createKnowledgeEvidenceDigest({
        evidenceSources,sourceIds
      })
    });
  } catch (error) {
    if (error?.message==="knowledge_evidence_invalid") throw error;
    reject();
  }
}

export function createKnowledgeEvidenceDigest({
  evidenceSources,sourceIds
}) {
  try {
    if (!Array.isArray(evidenceSources)||!sourceIdList(sourceIds)) reject();
    const identity=evidenceSources.map(source=>({
      sourceId:source.sourceId,
      sha256:source.sha256,
      derivedEvidence:source.derivedEvidence.map(item=>({
        kind:item.kind,sha256:item.sha256
      }))
    }));
    return createHash("sha256")
      .update("llw-knowledge-evidence-v1\0")
      .update(JSON.stringify({
        evidenceSources:identity,
        copiedSourceIds:[...sourceIds].sort()
      }))
      .digest("hex");
  } catch (error) {
    if (error?.message==="knowledge_evidence_invalid") throw error;
    reject();
  }
}

async function videoEvidence({workspaceDir,handle}) {
  if (handle.format!=="mp4"||
      !Number.isSafeInteger(handle.durationMs)||
      handle.representationIndexPath!==
        `${handle.sourceId}.manifest.json`) reject();
  const manifestPath=join(
    workspaceDir,handle.representationIndexPath
  );
  await privateFile(workspaceDir,manifestPath);
  const manifest=JSON.parse(await boundedRead(manifestPath));
  if (!plain(manifest)||manifest.version!==1||
      !plain(manifest.original)||
      manifest.original.sourceId!==handle.sourceId||
      manifest.original.relativePath!==handle.relativePath||
      manifest.original.byteSize!==handle.byteSize||
      manifest.original.sha256!==handle.sha256||
      manifest.original.mime!=="video/mp4"||
      manifest.original.durationMs!==handle.durationMs||
      !Array.isArray(manifest.derived)||
      manifest.derived.length>32) reject();
  const derivedEvidence=[];
  for (const kind of ["timeline","transcript"]) {
    const entries=manifest.derived.filter(item=>item?.kind===kind);
    if (entries.length!==1) reject();
    const entry=entries[0];
    if (!plain(entry)||!safeRelative(entry.relativePath)||
        !entry.relativePath.startsWith(`${handle.sourceId}.`)||
        !HASH.test(entry.sha256||"")||
        !safeLimitations(entry.limitations)) reject();
    const file=join(workspaceDir,entry.relativePath);
    await privateFile(workspaceDir,file);
    if (await sha256File(file)!==entry.sha256) reject();
    const value=JSON.parse(await boundedRead(file));
    validateDerived({kind,value,handle,limitations:entry.limitations});
    derivedEvidence.push({
      kind,sha256:entry.sha256,
      limitations:[...entry.limitations]
    });
  }
  return {
    ...basicEvidence(handle),
    durationMs:handle.durationMs,
    derivedEvidence
  };
}

function validateDerived({kind,value,handle,limitations}) {
  if (!plain(value)||value.version!==1||
      value.sourceId!==handle.sourceId||
      value.coverageStatus!=="complete"||
      !safeLimitations(value.limitations)||
      JSON.stringify(value.limitations)!==JSON.stringify(limitations)) {
    reject();
  }
  if (kind==="transcript") {
    if (value.originalDurationMs!==handle.durationMs) reject();
    return;
  }
  if (value.kind!=="video_timeline"||
      value.originalSha256!==handle.sha256||
      value.durationMs!==handle.durationMs) reject();
}

function basicEvidence(handle) {
  return {
    sourceId:handle.sourceId,
    displayName:handle.displayName,
    mediaClass:handle.mediaClass,
    format:handle.format,
    byteSize:handle.byteSize,
    sha256:handle.sha256,
    derivedEvidence:[],
    limitations:[...(handle.limitations??[])]
  };
}

async function verifyOriginal({workspaceDir,file,handle}) {
  const actual=await privateFile(workspaceDir,file);
  const info=await lstat(actual);
  if (info.size!==handle.byteSize||
      await sha256File(actual)!==handle.sha256) reject();
}

async function privateDirectory(path) {
  const info=await lstat(path);
  if (!info.isDirectory()||info.isSymbolicLink()||
      info.uid!==process.getuid()||(info.mode&0o077)!==0) reject();
  return realpath(path);
}

async function privateFile(workspaceDir,file) {
  const actual=await realpath(file);
  const fromWorkspace=relative(workspaceDir,actual);
  const info=await lstat(actual);
  if (!info.isFile()||info.isSymbolicLink()||
      info.uid!==process.getuid()||(info.mode&0o077)!==0||
      fromWorkspace.startsWith("..")||isAbsolute(fromWorkspace)||
      resolve(workspaceDir,fromWorkspace)!==actual) reject();
  return actual;
}

async function boundedRead(file) {
  const info=await lstat(file);
  if (info.size<2||info.size>MAX_MANIFEST_BYTES) reject();
  return readFile(file,"utf8");
}

async function sha256File(file) {
  const hash=createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function sourceIdList(value) {
  return Array.isArray(value)&&value.length<=8&&
    new Set(value).size===value.length&&
    value.every(id=>/^source-00[1-8]$/u.test(id));
}

function safeRelative(value) {
  return typeof value==="string"&&
    /^[A-Za-z0-9._-]+$/u.test(value)&&
    !value.includes("..")&&!value.includes("\\")&&!value.includes("\0");
}

function safeLimitations(value) {
  return Array.isArray(value)&&value.length<=8&&
    value.every(item=>typeof item==="string"&&item&&
      Buffer.byteLength(item,"utf8")<=1_000);
}

function plain(value) {
  return value&&typeof value==="object"&&!Array.isArray(value);
}

function deepFreeze(value) {
  if (!value||typeof value!=="object"||Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function reject() {
  throw new Error("knowledge_evidence_invalid");
}
