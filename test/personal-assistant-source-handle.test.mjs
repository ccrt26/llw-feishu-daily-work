import test from "node:test";
import assert from "node:assert/strict";
import {
  createSourceHandle,
  projectSourceForModel
} from "../src/personal-assistant/source-handle.mjs";

const binding={
  sourceId:"source-001",
  displayName:"交流方案.docx",
  mediaClass:"document",
  format:"docx",
  relativePath:"source-001.docx",
  byteSize:37_100,
  sha256:"a".repeat(64),
  availability:"ready",
  absolutePath:"/private/turn/source-001.docx",
  sourceAttachmentId:"file_private",
  contextToken:"reply-private",
  sourceBytes:Buffer.from("private")
};

test("creates an immutable source handle from only bounded model-safe metadata",() => {
  const handle=createSourceHandle(binding);
  assert.deepEqual(handle,{
    sourceId:"source-001",
    displayName:"交流方案.docx",
    mediaClass:"document",
    format:"docx",
    relativePath:"source-001.docx",
    byteSize:37_100,
    sha256:"a".repeat(64),
    availability:"ready"
  });
  assert.equal(Object.isFrozen(handle),true);
});

test("projects a source binding without platform IDs, absolute paths or bytes",() => {
  const projected=projectSourceForModel(binding);
  assert.deepEqual(projected,{
    sourceId:"source-001",
    displayName:"交流方案.docx",
    mediaClass:"document",
    format:"docx",
    relativePath:"source-001.docx",
    byteSize:37_100,
    sha256:"a".repeat(64),
    availability:"ready"
  });
  for (const privateField of [
    "absolutePath","sourceAttachmentId","contextToken","sourceBytes"
  ]) assert.equal(privateField in projected,false);
});

test("rejects oversized names, unsafe relative paths and malformed metadata",() => {
  for (const invalid of [
    {...binding,displayName:"x".repeat(256)},
    {...binding,displayName:"folder/file.pdf"},
    {...binding,relativePath:"../source-001.docx"},
    {...binding,relativePath:"/private/source-001.docx"},
    {...binding,byteSize:20*1024*1024+1},
    {...binding,sha256:"A".repeat(64)},
    {...binding,sourceId:"source-009"},
    {...binding,availability:"parsed"}
  ]) assert.throws(()=>createSourceHandle(invalid),/invalid_source_handle/);
});
