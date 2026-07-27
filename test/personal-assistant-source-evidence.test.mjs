import test from "node:test";
import assert from "node:assert/strict";
import {createSourceEvidence} from "../src/personal-assistant/source-evidence.mjs";

const sha="a".repeat(64);

test("accepts the real preparer fields without a duplicate business whitelist",() => {
  const evidence=createSourceEvidence({
    version:1,
    sourceKind:"file",
    detectedFormat:"docx",
    displayName:"方案.docx",
    sizeBytes:4096,
    sha256:sha,
    jobSourceName:"source.docx",
    safeSourceReference:"",
    extractionIntegrity:"partial",
    extractionLimitations:["embedded_images_not_extracted"],
    content:"第一部分\n第二部分",
    sourceBytes:Buffer.from("program-owned")
  });
  assert.deepEqual(evidence,{
    kind:"docx",
    displayName:"方案.docx",
    byteSize:4096,
    sha256:sha,
    text:"第一部分\n第二部分",
    structure:[],
    integrity:"partial",
    limitations:["embedded_images_not_extracted"],
    jobRef:"source.docx"
  });
});

test("keeps source bytes and paths out of SourceEvidence",() => {
  const evidence=createSourceEvidence({
    version:1,
    sourceKind:"text",
    detectedFormat:"text",
    displayName:"message.txt",
    sizeBytes:6,
    sha256:sha,
    jobSourceName:"source.txt",
    safeSourceReference:"",
    extractionIntegrity:"complete",
    extractionLimitations:[],
    content:"资料"
  });
  assert.equal("sourceBytes" in evidence,false);
  assert.equal("file" in evidence,false);
  assert.equal("path" in evidence,false);
});

test("rejects unreadable, malformed or over-broad source evidence",() => {
  for (const input of [
    null,
    {detectedFormat:"docx"},
    {
      version:1,sourceKind:"file",detectedFormat:"docx",displayName:"../方案.docx",
      sizeBytes:1,sha256:sha,jobSourceName:"source.docx",safeSourceReference:"",
      extractionIntegrity:"complete",extractionLimitations:[],content:"x"
    },
    {
      version:1,sourceKind:"file",detectedFormat:"docx",displayName:"方案.docx",
      sizeBytes:1,sha256:sha,jobSourceName:"source.docx",safeSourceReference:"",
      extractionIntegrity:"partial",extractionLimitations:[],content:"x"
    }
  ]) assert.throws(()=>createSourceEvidence(input),/source_evidence_invalid/);
});
