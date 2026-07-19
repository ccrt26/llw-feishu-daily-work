import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

const START = /<!-- llw-record-start: ([a-f0-9]{16}) ([0-9-]+) -->/g;

export class VaultWriter {
  constructor(vaultRoot) { this.vaultRoot = vaultRoot; }

  async commit({messageId, createTime, records}) {
    if (!messageId || !Number.isFinite(createTime) || !Array.isArray(records) || records.length === 0) {
      throw new Error("invalid_commit");
    }
    const vaultReal = await realpath(this.vaultRoot);
    try {
      await Promise.all([
        stat(join(vaultReal, ".obsidian")),
        stat(join(vaultReal, ".llw-system", "SYSTEM_MAP.md"))
      ]);
    } catch {
      throw new Error("vault_marker_missing");
    }

    const workRoot = join(vaultReal, "亚信工作", "每日工作");
    await mkdir(workRoot, {recursive: true, mode: 0o700});
    const workReal = await realpath(workRoot);
    if (workReal !== workRoot) throw new Error("work_root_mismatch");

    const grouped = new Map();
    records.forEach((record, index) => {
      validateRecord(record);
      const id = recordId(messageId, index);
      const sortKey = makeSortKey(record, createTime, index);
      const item = {id, sortKey, record};
      if (!grouped.has(record.occurred_date)) grouped.set(record.occurred_date, []);
      grouped.get(record.occurred_date).push(item);
    });

    const files = [];
    const ids = [];
    let inserted = false;
    for (const [date, additions] of grouped) {
      const folder = `${date.slice(0, 4)}年${date.slice(5, 7)}月${date.slice(8, 10)}日`;
      const dailyDir = join(workReal, folder);
      await mkdir(dailyDir, {recursive: true, mode: 0o700});
      const dailyReal = await realpath(dailyDir);
      if (!dailyReal.startsWith(`${workReal}${sep}`)) throw new Error("path_escape");
      const target = resolve(dailyReal, "工作记录.md");
      if (!target.startsWith(`${workReal}${sep}`)) throw new Error("path_escape");
      const before = await readOptional(target);
      const parsed = parseDocument(before, date);
      for (const addition of additions) {
        ids.push(addition.id);
        if (!parsed.entries.some(entry => entry.id === addition.id)) {
          parsed.entries.push({...addition, block: renderBlock(addition.record, addition.id, addition.sortKey, 0)});
          inserted = true;
        }
      }
      parsed.entries.sort((a, b) => a.sortKey.localeCompare(b.sortKey) || a.id.localeCompare(b.id));
      const after = renderDocument(date, parsed.entries);
      if (after !== before) await atomicReplace(target, before, after);
      const checked = await readFile(target, "utf8");
      for (const addition of additions) {
        if (!checked.includes(`<!-- llw-record-start: ${addition.id} `)) throw new Error("write_verification_failed");
      }
      files.push(relative(vaultReal, target).split(sep).join("/"));
    }
    return {files, recordIds: ids, inserted};
  }
}

export function recordId(messageId, index) {
  return createHash("sha256").update(`${messageId}:${index}`).digest("hex").slice(0, 16);
}

function validateRecord(record) {
  if (!record || !/^\d{4}-\d{2}-\d{2}$/.test(record.occurred_date)) throw new Error("invalid_record_date");
  if (record.occurred_time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(record.occurred_time)) throw new Error("invalid_record_time");
  for (const field of ["title", "summary", "original_text"]) {
    if (typeof record[field] !== "string" || !record[field]) throw new Error(`invalid_record_${field}`);
  }
  if (!Array.isArray(record.people) || !Array.isArray(record.follow_ups) || typeof record.location !== "string") {
    throw new Error("invalid_record_fields");
  }
}

function makeSortKey(record, createTime, index) {
  const fallback = beijingTime(createTime);
  const time = (record.occurred_time || fallback).replace(":", "");
  return `${record.occurred_date.replaceAll("-", "")}-${time}-${String(createTime).padStart(13, "0")}-${String(index).padStart(2, "0")}`;
}

function beijingTime(milliseconds) {
  const parts = new Intl.DateTimeFormat("en-GB", {timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23"})
    .formatToParts(new Date(milliseconds));
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.hour}:${value.minute}`;
}

function parseDocument(markdown, date) {
  if (!markdown) return {entries: []};
  const starts = [...markdown.matchAll(START)];
  const ends = [...markdown.matchAll(/<!-- llw-record-end: ([a-f0-9]{16}) -->/g)];
  if (starts.length !== ends.length) throw new Error("malformed_record_markers");
  const entries = [];
  const blockPattern = /<!-- llw-record-start: ([a-f0-9]{16}) ([0-9-]+) -->[\s\S]*?<!-- llw-record-end: \1 -->/g;
  for (const match of markdown.matchAll(blockPattern)) entries.push({id: match[1], sortKey: match[2], block: match[0]});
  if (entries.length !== starts.length) throw new Error("malformed_record_markers");
  if (!markdown.startsWith(`# ${date.slice(0, 4)}年${date.slice(5, 7)}月${date.slice(8, 10)}日工作记录`)) {
    throw new Error("unexpected_daily_file");
  }
  return {entries};
}

function renderDocument(date, entries) {
  const heading = `# ${date.slice(0, 4)}年${date.slice(5, 7)}月${date.slice(8, 10)}日工作记录`;
  const blocks = entries.map((entry, index) => renumber(entry.block, index + 1));
  return `${heading}\n\n${blocks.join("\n\n---\n\n")}\n`;
}

function renderBlock(record, id, sortKey, number) {
  const time = record.occurred_time || "时间未说明";
  const people = record.people.length ? record.people.map(safeInline).join("、") : "未说明";
  const location = record.location ? safeInline(record.location) : "未说明";
  const followUps = record.follow_ups.length ? record.follow_ups.map(item => `- ${safeLine(item)}`).join("\n") : "- 未说明";
  const original = record.original_text.split(/\r?\n/).map(line => `> ${line}`).join("\n");
  return `<!-- llw-record-start: ${id} ${sortKey} -->\n## 记录 ${number}｜${time}｜${safeInline(record.title)}\n\n> [!info] 关键信息\n> - 时间：${record.occurred_date}${record.occurred_time ? ` ${record.occurred_time}` : "（具体时间未说明）"}（北京时间）\n> - 人物：${people}\n> - 地点：${location}\n\n### 整理后记录\n\n${record.summary}\n\n### 后续事项\n\n${followUps}\n\n> [!quote]- 原始内容\n${original}\n\n<!-- llw-record-end: ${id} -->`;
}

function renumber(block, number) {
  return block.replace(/^## 记录 \d+｜/m, `## 记录 ${number}｜`);
}

function safeInline(value) { return String(value).replace(/[\r\n|#]/g, " ").trim(); }
function safeLine(value) { return String(value).replace(/[\r\n]/g, " ").trim(); }

async function readOptional(path) {
  try { return await readFile(path, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return ""; throw error; }
}

async function atomicReplace(target, expected, content) {
  const current = await readOptional(target);
  if (current !== expected) throw new Error("concurrent_file_change");
  const temporary = join(dirname(target), `.工作记录.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
}
