import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultWriter } from "../src/vault-writer.mjs";
import { parseManagedDocument } from "../src/managed-record.mjs";

async function vault() {
  const root = await mkdtemp(join(tmpdir(), "llw-vault-"));
  await mkdir(join(root, ".obsidian"));
  await mkdir(join(root, ".llw-system"));
  await writeFile(join(root, ".llw-system", "SYSTEM_MAP.md"), "# test\n");
  return root;
}

function record(overrides = {}) {
  return {
    occurred_date: "2026-07-18",
    occurred_time: "",
    occurred_end_time: "",
    title: "标品订单RV会议",
    people: [],
    location: "线上",
    summary: "公司线上召开标品订单RV会议，会上汇报了标品订单进展。EDR实施进展缓慢，会议要求对此特别重视。",
    follow_ups: ["下周完成EDR安装部署。"],
    original_text: "昨天下午，公司线上召开了标品订单RV会议。",
    ...overrides
  };
}

test("creates one Beijing-day file with organized content and a verbatim initial source", async () => {
  const root = await vault();
  const writer = new VaultWriter(root);
  const result = await writer.create({messageId: "m1", createTime: 1784426400000, records: [record()]});
  assert.deepEqual(result.files, ["亚信工作/每日工作/2026年07月18日/工作记录.md"]);
  assert.equal(result.recordIds.length, 1);
  assert.equal(result.inserted, true);
  const markdown = await readFile(join(root, result.files[0]), "utf8");
  assert.match(markdown, /### 整理后记录/);
  assert.match(markdown, /> \[!quote\]- 原始内容 1｜首次记录/);
  const [entry] = parseManagedDocument(markdown, "2026-07-18");
  assert.equal(entry.sources[0].text, record().original_text);
});

test("creates independent records in time order and duplicate delivery is a no-op", async () => {
  const root = await vault();
  const writer = new VaultWriter(root);
  await writer.create({messageId: "m-late", createTime: 1784426400000, records: [record({title: "晚记录", occurred_time: "10:00"})]});
  await writer.create({messageId: "m-early", createTime: 1784430000000, records: [record({title: "早记录", occurred_time: "09:00"})]});
  const duplicate = await writer.create({messageId: "m-early", createTime: 1784430000000, records: [record({title: "早记录", occurred_time: "09:00"})]});
  assert.equal(duplicate.inserted, false);
  const markdown = await readFile(join(root, "亚信工作", "每日工作", "2026年07月18日", "工作记录.md"), "utf8");
  assert.ok(markdown.indexOf("早记录") < markdown.indexOf("晚记录"));
  assert.equal(parseManagedDocument(markdown, "2026-07-18").length, 2);
});

test("supplements the existing record without creating a send-date file", async () => {
  const root = await vault();
  const writer = new VaultWriter(root);
  const created = await writer.create({messageId: "m-initial", createTime: 1784445864192, records: [record()]});
  const supplementText = "我补充一下，参会时间是下午4点30开始，到下午5:30。参会人员包括江苏区的销售。";
  const revised = record({
    occurred_time: "16:30",
    occurred_end_time: "17:30",
    people: ["江苏区销售"],
    summary: "公司线上召开标品订单RV会议，会上汇报了标品订单进展。EDR实施进展缓慢，会议要求对此特别重视；参会人员包括江苏区销售。",
    original_text: supplementText
  });
  const result = await writer.supplement({
    messageId: "m-supplement",
    createTime: 1784445972514,
    targetRecordId: created.recordIds[0],
    record: revised
  });
  assert.deepEqual(result.files, ["亚信工作/每日工作/2026年07月18日/工作记录.md"]);
  assert.equal(result.updated, true);
  await assert.rejects(access(join(root, "亚信工作", "每日工作", "2026年07月19日", "工作记录.md")));
  const path = join(root, result.files[0]);
  const [entry] = parseManagedDocument(await readFile(path, "utf8"), "2026-07-18");
  assert.equal(entry.id, created.recordIds[0]);
  assert.deepEqual(entry.record.follow_ups, ["下周完成EDR安装部署。"]);
  assert.deepEqual(entry.sources.map(source => source.text), [record().original_text, supplementText]);
  assert.deepEqual(entry.sources.map(source => source.kind), ["initial", "supplement"]);

  const duplicate = await writer.supplement({
    messageId: "m-supplement",
    createTime: 1784445972514,
    targetRecordId: created.recordIds[0],
    record: revised
  });
  assert.equal(duplicate.updated, false);
  const [afterDuplicate] = parseManagedDocument(await readFile(path, "utf8"), "2026-07-18");
  assert.equal(afterDuplicate.sources.length, 2);
});

test("rejects missing targets and refuses to move an existing record to another date", async () => {
  const root = await vault();
  const writer = new VaultWriter(root);
  const created = await writer.create({messageId: "m-initial", createTime: 1784445864192, records: [record()]});
  await assert.rejects(writer.supplement({
    messageId: "m2", createTime: 1784445972514, targetRecordId: "ffffffffffffffff", record: record()
  }), /target_record_not_found/);
  await assert.rejects(writer.supplement({
    messageId: "m3", createTime: 1784445972514, targetRecordId: created.recordIds[0], record: record({occurred_date: "2026-07-19"})
  }), /supplement_date_mismatch/);
});

test("refuses a directory that is not the configured Vault", async () => {
  const root = await mkdtemp(join(tmpdir(), "llw-not-vault-"));
  await assert.rejects(
    new VaultWriter(root).create({messageId: "m1", createTime: 1784426400000, records: [record()]}),
    /vault_marker_missing/
  );
});
