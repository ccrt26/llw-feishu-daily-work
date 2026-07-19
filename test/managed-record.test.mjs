import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeRecordData,
  encodeRecordData,
  parseManagedDocument,
  renderManagedDocument
} from "../src/managed-record.mjs";

function entry(overrides = {}) {
  return {
    id: "90f29b02eb9ec9bb",
    sortKey: "20260718-1630-1784445864192-00",
    record: {
      occurred_date: "2026-07-18",
      occurred_time: "16:30",
      occurred_end_time: "17:30",
      title: "标品订单RV会议",
      people: ["江苏区销售"],
      location: "线上",
      summary: "公司线上召开标品订单RV会议。",
      follow_ups: ["下周完成EDR安装部署。"]
    },
    sources: [{kind: "initial", text: "初始原文", sourceId: "aaaaaaaaaaaaaaaa"}],
    ...overrides
  };
}

test("encodes managed data on one base64url line and decodes it exactly", () => {
  const value = entry();
  const encoded = encodeRecordData(value);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.equal(encoded.includes("\n"), false);
  assert.deepEqual(decodeRecordData(encoded), value);
});

test("renders a readable time range and distinctly labeled verbatim sources", () => {
  const value = entry({
    sources: [
      {kind: "initial", text: "初始原文", sourceId: "aaaaaaaaaaaaaaaa"},
      {kind: "supplement", text: "补充第一行\n补充第二行", sourceId: "bbbbbbbbbbbbbbbb"}
    ]
  });
  const markdown = renderManagedDocument("2026-07-18", [value]);
  assert.match(markdown, /^# 2026年07月18日工作记录/m);
  assert.match(markdown, /^## 记录 1｜16:30–17:30｜标品订单RV会议$/m);
  assert.match(markdown, /> \[!quote\]- 原始内容 1｜首次记录\n> 初始原文/);
  assert.match(markdown, /> \[!quote\]- 原始内容 2｜补充\n> 补充第一行\n> 补充第二行/);
  assert.match(markdown, /<!-- llw-record-data: [A-Za-z0-9_-]+ -->/);
});

test("round-trips a complete managed document", () => {
  const value = entry();
  const markdown = renderManagedDocument("2026-07-18", [value]);
  assert.deepEqual(parseManagedDocument(markdown, "2026-07-18"), [value]);
});

test("rejects invalid ids, duplicate source ids, and malformed markers", () => {
  assert.throws(() => encodeRecordData(entry({id: "bad"})), /invalid_record_id/);
  assert.throws(() => encodeRecordData(entry({sources: [
    {kind: "initial", text: "一", sourceId: "aaaaaaaaaaaaaaaa"},
    {kind: "supplement", text: "二", sourceId: "aaaaaaaaaaaaaaaa"}
  ]})), /duplicate_source_id/);
  const markdown = renderManagedDocument("2026-07-18", [entry()]);
  assert.throws(() => parseManagedDocument(markdown.replace(/<!-- llw-record-end:[^>]+ -->/, ""), "2026-07-18"), /malformed_record_markers/);
});
