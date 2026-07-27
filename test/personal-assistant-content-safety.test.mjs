import test from "node:test";
import assert from "node:assert/strict";
import {assertContentSafe} from "../src/personal-assistant/content-safety.mjs";

const evidence={
  kind:"docx",
  displayName:"资料.docx",
  byteSize:4096,
  sha256:"a".repeat(64),
  text:"普通业务资料",
  structure:[],
  integrity:"partial",
  limitations:["embedded_images_not_extracted"],
  jobRef:"source.docx"
};

test("accepts real Office evidence fields without comparing byte size to extracted text",() => {
  assert.doesNotThrow(()=>assertContentSafe({
    instructionText:"整理这份资料",
    evidence,
    conversation:null,
    limits:{maxContextBytes:512*1024}
  }));
});

test("rejects credentials and payment secrets without echoing values",() => {
  for (const instructionText of [
    "Authorization: Bearer secret-value",
    "密码：not-for-model",
    "验证码：123456",
    "银行卡号 4539 1488 0343 6467",
    "CVV: 123"
  ]) {
    assert.throws(
      ()=>assertContentSafe({
        instructionText,evidence:null,conversation:null,
        limits:{maxContextBytes:512*1024}
      }),
      error=>error.message==="content_safety_rejected"
    );
  }
});

test("accepts ordinary financial discussion and safe relative business labels",() => {
  for (const instructionText of [
    "解释银行卡号通常有多少位",
    "这张发票金额是 123.45 元",
    "保存到日常生活/学习资料"
  ]) assert.doesNotThrow(()=>assertContentSafe({
    instructionText,evidence:null,conversation:null,
    limits:{maxContextBytes:512*1024}
  }));
});

test("rejects oversized context and explicit escaping paths",() => {
  for (const instructionText of [
    "x".repeat(32_769),
    "保存到 ../../private",
    "保存到 /Users/example/secret",
    "保存到 ~/secret"
  ]) assert.throws(()=>assertContentSafe({
    instructionText,evidence:null,conversation:null,
    limits:{maxContextBytes:32*1024}
  }),/content_safety_rejected/);
});
