import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {prepareKnowledgeText} from "../src/capabilities/knowledge-ingest/source-preparer.mjs";

test("prepares one exact bounded text source with program-owned metadata",()=>{
  const text="Save this synthetic note: Aurora uses staged communication.";
  const result=prepareKnowledgeText({text,maxSourceBytes:262144});
  assert.deepEqual(result,{
    version:1,
    sourceKind:"text",
    detectedFormat:"text",
    displayName:"message.txt",
    sizeBytes:Buffer.byteLength(text),
    sha256:createHash("sha256").update(text).digest("hex"),
    jobSourceName:"source.txt",
    safeSourceReference:""
  });
});

test("rejects empty, non-string, NUL, invalid limits and oversized direct text",()=>{
  for (const input of [
    {text:"",maxSourceBytes:262144},
    {text:"   ",maxSourceBytes:262144},
    {text:Buffer.from("text"),maxSourceBytes:262144},
    {text:"unsafe\0text",maxSourceBytes:262144},
    {text:"text",maxSourceBytes:0},
    {text:"x".repeat(11),maxSourceBytes:10}
  ]) {
    assert.throws(
      ()=>prepareKnowledgeText(input),
      /knowledge_source_invalid/
    );
  }
});
