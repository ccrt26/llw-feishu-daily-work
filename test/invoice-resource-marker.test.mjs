import test from "node:test";
import assert from "node:assert/strict";
import {parseInvoiceResource} from "../src/capabilities/invoice/resource-marker.mjs";

test("parses exact image and file resource markers", () => {
  assert.deepEqual(parseInvoiceResource({source:"feishu",attachments:[{type:"image",sourceAttachmentId:"img_abc-123"}]}), {fileKey:"img_abc-123", type:"image"});
  assert.deepEqual(parseInvoiceResource({source:"feishu",attachments:[{type:"file",sourceAttachmentId:"file_xyz-9"}]}), {fileKey:"file_xyz-9", type:"file"});
  assert.deepEqual(parseInvoiceResource({
    source:"wechat",attachments:[{type:"image",sourceAttachmentId:"wxr_0123456789abcdef0123456789abcdef",extension:""}]
  }),{resourceId:"wxr_0123456789abcdef0123456789abcdef",type:"image"});
  assert.deepEqual(parseInvoiceResource({
    source:"wechat",attachments:[{type:"file",sourceAttachmentId:"wxr_abcdefabcdefabcdefabcdefabcdefab",extension:"pdf"}]
  }),{resourceId:"wxr_abcdefabcdefabcdefabcdefabcdefab",type:"file"});
});

test("rejects malformed image attachment references", () => {
  for (const sourceAttachmentId of ["file_abc","img_","img a",""]) {
    assert.throws(() => parseInvoiceResource({source:"feishu",attachments:[{type:"image",sourceAttachmentId}]}), /invalid_resource_marker/);
  }
});

test("rejects malformed file attachment references", () => {
  for (const sourceAttachmentId of ["img_abc","file_","file a",""]) assert.throws(() => parseInvoiceResource({source:"feishu",attachments:[{type:"file",sourceAttachmentId}]}), /invalid_resource_marker/);
});

test("rejects unsupported or non-single attachment sets", () => {
  assert.throws(() => parseInvoiceResource({source:"feishu",attachments:[]}), /unsupported_resource_type/);
  assert.throws(() => parseInvoiceResource({source:"feishu",attachments:[{type:"audio",sourceAttachmentId:"x"}]}), /unsupported_resource_type/);
  assert.throws(() => parseInvoiceResource({source:"feishu",attachments:[{type:"image",sourceAttachmentId:"img_a"},{type:"file",sourceAttachmentId:"file_a"}]}), /unsupported_resource_type/);
  for (const attachment of [
    {type:"file",sourceAttachmentId:"wxr_0123456789abcdef0123456789abcdef",extension:"txt"},
    {type:"image",sourceAttachmentId:"img_abc",extension:""}
  ]) assert.throws(()=>parseInvoiceResource({source:"wechat",attachments:[attachment]}),/invalid_resource_marker/);
  assert.throws(()=>parseInvoiceResource({source:"email",attachments:[{type:"image",sourceAttachmentId:"img_a"}]}),/unsupported_resource_type/);
});
