import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultWriter } from "../src/vault-writer.mjs";

async function vault() {
  const root = await mkdtemp(join(tmpdir(), "llw-vault-"));
  await mkdir(join(root, ".obsidian"));
  await mkdir(join(root, ".llw-system"));
  await writeFile(join(root, ".llw-system", "SYSTEM_MAP.md"), "# test\n");
  return root;
}

function record(overrides = {}) {
  return {
    occurred_date: "2026-07-19",
    occurred_time: "10:00",
    title: "方案评审",
    people: ["张三"],
    location: "会议室",
    summary: "与张三完成方案评审。",
    follow_ups: ["更新评审意见"],
    original_text: "十点和张三在会议室完成方案评审。",
    ...overrides
  };
}

test("writes one Beijing-day file with organized and verbatim sections", async () => {
  const root = await vault();
  const writer = new VaultWriter(root);
  const result = await writer.commit({messageId: "m1", createTime: 1784426400000, records: [record()]});
  assert.deepEqual(result.files, ["亚信工作/每日工作/2026年07月19日/工作记录.md"]);
  assert.equal(result.recordIds.length, 1);
  assert.equal(result.inserted, true);
  const markdown = await readFile(join(root, result.files[0]), "utf8");
  assert.match(markdown, /^# 2026年07月19日工作记录/m);
  assert.match(markdown, /### 整理后记录\n\n与张三完成方案评审。/);
  assert.match(markdown, /> \[!quote\]- 原始内容\n> 十点和张三在会议室完成方案评审。/);
  assert.match(markdown, /<!-- llw-record-start:/);
  assert.match(markdown, /<!-- llw-record-end:/);
});

test("appends to the existing daily file and sorts independent records", async () => {
  const root = await vault();
  const writer = new VaultWriter(root);
  await writer.commit({messageId: "m-late", createTime: 1784426400000, records: [record({title: "晚记录", occurred_time: "10:00"})]});
  await writer.commit({messageId: "m-early", createTime: 1784430000000, records: [record({title: "早记录", occurred_time: "09:00"})]});
  const path = join(root, "亚信工作", "每日工作", "2026年07月19日", "工作记录.md");
  const markdown = await readFile(path, "utf8");
  assert.ok(markdown.indexOf("早记录") < markdown.indexOf("晚记录"));
  assert.equal((markdown.match(/^## 记录 /gm) || []).length, 2);
  assert.match(markdown, /<!-- llw-record-end:[^>]+ -->\n\n---\n\n<!-- llw-record-start:/);
});

test("duplicate message is a no-op", async () => {
  const root = await vault();
  const writer = new VaultWriter(root);
  const first = await writer.commit({messageId: "m1", createTime: 1784426400000, records: [record()]});
  const second = await writer.commit({messageId: "m1", createTime: 1784426400000, records: [record()]});
  assert.equal(first.inserted, true);
  assert.equal(second.inserted, false);
  const markdown = await readFile(join(root, first.files[0]), "utf8");
  assert.equal((markdown.match(/^## 记录 /gm) || []).length, 1);
});

test("refuses a directory that is not the configured Vault", async () => {
  const root = await mkdtemp(join(tmpdir(), "llw-not-vault-"));
  await assert.rejects(
    new VaultWriter(root).commit({messageId: "m1", createTime: 1784426400000, records: [record()]}),
    /vault_marker_missing/
  );
});
