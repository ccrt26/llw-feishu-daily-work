import test from "node:test";
import assert from "node:assert/strict";
import {parseInvoiceResource} from "../src/capabilities/invoice/resource-marker.mjs";

test("parses exact image and file resource markers", () => {
  assert.deepEqual(parseInvoiceResource({attachments:[{type:"image",sourceAttachmentId:"img_abc-123"}]}), {fileKey:"img_abc-123", type:"image"});
  assert.deepEqual(parseInvoiceResource({attachments:[{type:"file",sourceAttachmentId:"file_xyz-9"}]}), {fileKey:"file_xyz-9", type:"file"});
});

test("rejects malformed image attachment references", () => {
  for (const sourceAttachmentId of ["file_abc","img_","img a",""]) {
    assert.throws(() => parseInvoiceResource({attachments:[{type:"image",sourceAttachmentId}]}), /invalid_resource_marker/);
  }
});

test("rejects malformed file attachment references", () => {
  for (const sourceAttachmentId of ["img_abc","file_","file a",""]) assert.throws(() => parseInvoiceResource({attachments:[{type:"file",sourceAttachmentId}]}), /invalid_resource_marker/);
});

test("rejects unsupported or non-single attachment sets", () => {
  assert.throws(() => parseInvoiceResource({attachments:[]}), /unsupported_resource_type/);
  assert.throws(() => parseInvoiceResource({attachments:[{type:"audio",sourceAttachmentId:"x"}]}), /unsupported_resource_type/);
  assert.throws(() => parseInvoiceResource({attachments:[{type:"image",sourceAttachmentId:"img_a"},{type:"file",sourceAttachmentId:"file_a"}]}), /unsupported_resource_type/);
});
