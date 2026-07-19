import test from "node:test";
import assert from "node:assert/strict";
import {parseInvoiceResource} from "../src/capabilities/invoice/resource-marker.mjs";

test("parses exact image and file resource markers", () => {
  assert.deepEqual(parseInvoiceResource({messageType:"image", content:"![Image](img_abc-123)"}), {fileKey:"img_abc-123", type:"image"});
  assert.deepEqual(parseInvoiceResource({messageType:"image", content:"  ![Image](img_abc-123)\n"}), {fileKey:"img_abc-123", type:"image"});
  assert.deepEqual(parseInvoiceResource({messageType:"file", content:'<file name="票.jpg" key="file_abc"/>'}), {fileKey:"file_abc", type:"file"});
  assert.deepEqual(parseInvoiceResource({messageType:"file", content:'<file key="file_xyz-9" name="票.jpg" />'}), {fileKey:"file_xyz-9", type:"file"});
  assert.deepEqual(parseInvoiceResource({messageType:"file", content:'\n<file key="file_xyz-9"/>  '}), {fileKey:"file_xyz-9", type:"file"});
});

test("rejects malformed image resource markers", () => {
  for (const content of ["![Image](file_abc)", "![Image](img_)", "x![Image](img_abc)", "![Image](img_a) tail", "![Image](img_a)![Image](img_b)"]) {
    assert.throws(() => parseInvoiceResource({messageType:"image", content}), /invalid_resource_marker/);
  }
});

test("rejects malformed file resource markers", () => {
  for (const content of [
    '<file key="img_abc"/>', '<file key="file_"/>', 'x <file key="file_abc"/>',
    '<file key="file_a" key="file_b"/>', '<file name="票.jpg"/>', '<file key="file_a"></file>'
  ]) assert.throws(() => parseInvoiceResource({messageType:"file", content}), /invalid_resource_marker/);
});

test("rejects unsupported message types", () => {
  assert.throws(() => parseInvoiceResource({messageType:"text", content:"![Image](img_a)"}), /unsupported_resource_type/);
});
