import test from "node:test";
import assert from "node:assert/strict";
import {
  extractFeishuDocumentRequests
} from "../src/core/feishu-document-link.mjs";

function message(instructionText,overrides={}) {
  return {
    source:"feishu",instructionText,attachments:[],
    ...overrides
  };
}

test("extracts one allowed Feishu cloud-document URL and replaces only that URL",()=>{
  for (const path of [
    "doc/token_doc","docx/token_docx","sheets/token_sheet",
    "slides/token_slides","wiki/token_wiki"
  ]) {
    const url=`https://example.feishu.cn/${path}`;
    assert.deepEqual(
      extractFeishuDocumentRequests(
        message(`请总结，不保存：${url}，保留这段说明`)
      ),
      {
        requests:[{url}],
        safeInstructionText:
          "请总结，不保存：[飞书文档快照]，保留这段说明"
      }
    );
  }
});

test("extracts multiple cloud-document links in order and rejects cross-entry or unsupported links",()=>{
  const first="https://example.feishu.cn/docx/token_one";
  const second="https://example.feishu.cn/sheets/token_two";
  assert.deepEqual(
    extractFeishuDocumentRequests(
      message(`比较 ${first} 和 ${second}`)
    ),
    {
      requests:[{url:first},{url:second}],
      safeInstructionText:
        "比较 [飞书文档快照 1] 和 [飞书文档快照 2]"
    }
  );
  const valid="https://example.feishu.cn/docx/token_one";
  for (const value of [
    message(valid,{source:"wechat"}),
    message("https://evil.example.com/docx/token"),
    message("https://example.feishu.cn/base/token"),
    message("https://example.feishu.cn/bitable/token")
  ]) {
    assert.equal(extractFeishuDocumentRequests(value),null);
  }
});
