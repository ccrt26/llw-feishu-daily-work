const KINDS=new Set(["text","txt","md","docx","pptx","xlsx","pdf","image","feishu_snapshot"]);
const INTEGRITY=new Set(["complete","partial","unreadable"]);

export function createSourceEvidence(prepared) {
  try {
    if (!prepared||typeof prepared!=="object"||Array.isArray(prepared)) reject();
    const kind=prepared.detectedFormat==="text"
      ?"text"
      :prepared.detectedFormat;
    if (!KINDS.has(kind)||
        !safeLabel(prepared.displayName,255)||
        !Number.isSafeInteger(prepared.sizeBytes)||
        prepared.sizeBytes<1||
        !/^[a-f0-9]{64}$/u.test(prepared.sha256)||
        !safeJobRef(prepared.jobSourceName)||
        !INTEGRITY.has(prepared.extractionIntegrity)||
        !limitations(prepared.extractionLimitations,prepared.extractionIntegrity)) {
      reject();
    }
    const text=typeof prepared.content==="string"?prepared.content:"";
    if (text.includes("\0")||Buffer.byteLength(text,"utf8")>262_144) reject();
    const structure=Array.isArray(prepared.structure)
      ?structuredClone(prepared.structure)
      :[];
    return Object.freeze({
      kind,
      displayName:prepared.displayName,
      byteSize:prepared.sizeBytes,
      sha256:prepared.sha256,
      text,
      structure,
      integrity:prepared.extractionIntegrity,
      limitations:Object.freeze([...prepared.extractionLimitations]),
      jobRef:prepared.jobSourceName
    });
  } catch (error) {
    if (error?.message==="source_evidence_invalid") throw error;
    reject();
  }
}

function limitations(values,integrity) {
  if (!Array.isArray(values)||values.length>16||
      values.some(value=>typeof value!=="string"||
        !/^[a-z0-9_]{1,64}$/u.test(value))) {
    return false;
  }
  if (integrity==="complete") return values.length===0;
  return values.length>0;
}

function safeLabel(value,max) {
  return typeof value==="string"&&value===value.trim()&&value.length>0&&
    [...value].length<=max&&!/[\\/\u0000-\u001f\u007f]/u.test(value);
}

function safeJobRef(value) {
  return typeof value==="string"&&
    /^source\.(?:txt|md|docx|pptx|xlsx|pdf|png|jpg|jpeg|webp)$/u.test(value);
}

function reject() {
  throw new Error("source_evidence_invalid");
}
