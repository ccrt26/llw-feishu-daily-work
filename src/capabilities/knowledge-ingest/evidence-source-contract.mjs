import {createHash} from "node:crypto";

const SOURCE_ID=/^source-00[1-8]$/u;
const HASH=/^[a-f0-9]{64}$/u;
const FORMATS=new Map([
  ["document",new Set(["txt","md","docx","pptx","xlsx","pdf"])],
  ["image",new Set(["png","jpg","jpeg","webp"])],
  ["video",new Set(["mp4"])]
]);

export function normalizeKnowledgeEvidenceSources(value) {
  if (!Array.isArray(value)||value.length>8) reject();
  const seen=new Set();
  const normalized=value.map(source=>{
    const video=source?.mediaClass==="video";
    const fields=new Set([
      "sourceId","displayName","mediaClass","format","byteSize","sha256",
      "derivedEvidence","limitations",...(video?["durationMs"]:[])
    ]);
    if (!plainExact(source,fields)||
        !SOURCE_ID.test(source.sourceId||"")||
        seen.has(source.sourceId)||
        typeof source.displayName!=="string"||!source.displayName||
        [...source.displayName].length>255||
        /[\\/\u0000-\u001f\u007f]/u.test(source.displayName)||
        !FORMATS.get(source.mediaClass)?.has(source.format)||
        !Number.isSafeInteger(source.byteSize)||source.byteSize<1||
        !HASH.test(source.sha256||"")||
        !safeLimitations(source.limitations)||
        !Array.isArray(source.derivedEvidence)||
        source.derivedEvidence.length>8||
        (video&&(
          !Number.isSafeInteger(source.durationMs)||
          source.durationMs<1||source.durationMs>7*24*60*60*1000
        ))) reject();
    seen.add(source.sourceId);
    const derivedSeen=new Set();
    const derived=source.derivedEvidence.map(item=>{
      if (!plainExact(item,new Set(["kind","sha256","limitations"]))||
          !new Set(["timeline","transcript"]).has(item.kind)||
          derivedSeen.has(item.kind)||!HASH.test(item.sha256||"")||
          !safeLimitations(item.limitations)) reject();
      derivedSeen.add(item.kind);
      return {
        kind:item.kind,sha256:item.sha256,
        limitations:[...item.limitations]
      };
    }).sort((a,b)=>a.kind.localeCompare(b.kind));
    if (video&&(
      derived.length!==2||
      derived[0].kind!=="timeline"||
      derived[1].kind!=="transcript"
    )) reject();
    if (!video&&derived.length) reject();
    return {
      sourceId:source.sourceId,
      displayName:source.displayName,
      mediaClass:source.mediaClass,
      format:source.format,
      byteSize:source.byteSize,
      sha256:source.sha256,
      ...(video?{durationMs:source.durationMs}:{}),
      derivedEvidence:derived,
      limitations:[...source.limitations]
    };
  }).sort((a,b)=>a.sourceId.localeCompare(b.sourceId));
  return normalized;
}

export function createKnowledgeEvidenceDigest({
  evidenceSources,sourceIds
}) {
  const normalized=normalizeKnowledgeEvidenceSources(evidenceSources);
  if (!Array.isArray(sourceIds)||sourceIds.length>8||
      new Set(sourceIds).size!==sourceIds.length||
      sourceIds.some(id=>!SOURCE_ID.test(id))) reject();
  const evidenceIds=new Set(normalized.map(source=>source.sourceId));
  if (sourceIds.some(id=>!evidenceIds.has(id))) reject();
  const identity=normalized.map(source=>({
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
}

function safeLimitations(value) {
  return Array.isArray(value)&&value.length<=8&&
    value.every(item=>typeof item==="string"&&item&&
      Buffer.byteLength(item,"utf8")<=1_000);
}

function plainExact(value,fields) {
  return Boolean(
    value&&typeof value==="object"&&!Array.isArray(value)&&
    Object.getPrototypeOf(value)===Object.prototype&&
    Object.keys(value).length===fields.size&&
    Object.keys(value).every(key=>fields.has(key))
  );
}

function reject() {
  throw new Error("knowledge_evidence_invalid");
}
