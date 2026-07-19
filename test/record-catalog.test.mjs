import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderManagedDocument } from "../src/managed-record.mjs";
import { RecordCatalog } from "../src/record-catalog.mjs";

async function vault() {
  const root = await mkdtemp(join(tmpdir(), "llw-catalog-"));
  await mkdir(join(root, ".obsidian"));
  await mkdir(join(root, ".llw-system"));
  await writeFile(join(root, ".llw-system", "SYSTEM_MAP.md"), "# test\n");
  return root;
}

function entry(index) {
  const number = String(index).padStart(2, "0");
  return {
    id: index.toString(16).padStart(16, "0"),
    sortKey: `20260719-${number}00-1784426400000-${number}`,
    record: {
      occurred_date: "2026-07-19",
      occurred_time: `${number}:00`,
      occurred_end_time: "",
      title: `事项${number}`,
      people: ["张三"],
      location: "会议室",
      summary: `完成事项${number}。`,
      follow_ups: []
    },
    sources: [{kind: "initial", text: `原文${number}`, sourceId: (100 + index).toString(16).padStart(16, "0")}]
  };
}

test("lists at most twenty recent candidates without sources or paths", async () => {
  const root = await vault();
  const daily = join(root, "亚信工作", "每日工作", "2026年07月19日");
  await mkdir(daily, {recursive: true});
  await writeFile(join(daily, "工作记录.md"), renderManagedDocument("2026-07-19", Array.from({length: 21}, (_, index) => entry(index))));
  const candidates = await new RecordCatalog(root).list({limit: 20});
  assert.equal(candidates.length, 20);
  assert.equal(candidates[0].title, "事项20");
  assert.deepEqual(Object.keys(candidates[0]).sort(), [
    "date", "follow_ups", "location", "occurred_end_time", "occurred_time", "people", "record_id", "summary", "title"
  ].sort());
  assert.equal(JSON.stringify(candidates).includes("原文"), false);
  assert.equal(JSON.stringify(candidates).includes(root), false);
});

test("ignores unrelated markdown outside the managed daily-work shape", async () => {
  const root = await vault();
  await mkdir(join(root, "亚信工作", "每日工作", "随手记"), {recursive: true});
  await writeFile(join(root, "亚信工作", "每日工作", "随手记", "工作记录.md"), "# 不受管理\n");
  assert.deepEqual(await new RecordCatalog(root).list(), []);
});
