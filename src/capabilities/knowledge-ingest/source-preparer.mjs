import {createHash} from "node:crypto";

export function prepareKnowledgeText({text,maxSourceBytes}) {
  if (typeof text!=="string"||!text.trim()||text.includes("\0")||
      !Number.isSafeInteger(maxSourceBytes)||maxSourceBytes<1||
      maxSourceBytes>262_144) {
    throw new Error("knowledge_source_invalid");
  }
  const sizeBytes=Buffer.byteLength(text,"utf8");
  if (sizeBytes>maxSourceBytes) throw new Error("knowledge_source_invalid");
  return {
    version:1,
    sourceKind:"text",
    detectedFormat:"text",
    displayName:"message.txt",
    sizeBytes,
    sha256:createHash("sha256").update(text,"utf8").digest("hex"),
    jobSourceName:"source.txt",
    safeSourceReference:""
  };
}
