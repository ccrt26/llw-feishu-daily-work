import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, realpath, rename, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseManagedDocument, renderManagedDocument } from "./managed-record.mjs";

const DATE_FOLDER = /^(\d{4})年(\d{2})月(\d{2})日$/;

export class VaultWriter {
  constructor(vaultRoot) { this.vaultRoot = vaultRoot; }

  async create({messageId, createTime, records}) {
    validateJob(messageId, createTime);
    if (!Array.isArray(records) || records.length === 0) throw new Error("invalid_create_records");
    const {vaultReal, workReal} = await this.openRoots();
    const grouped = new Map();
    records.forEach((record, index) => {
      validateInputRecord(record);
      const item = {
        id: recordId(messageId, index),
        sortKey: makeSortKey(record, createTime, index),
        record: withoutOriginal(record),
        sources: [{kind: "initial", text: record.original_text, sourceId: sourceId(messageId, index)}]
      };
      if (!grouped.has(record.occurred_date)) grouped.set(record.occurred_date, []);
      grouped.get(record.occurred_date).push(item);
    });
    const files = [];
    const recordIds = [];
    let inserted = false;
    for (const [date, additions] of grouped) {
      const target = await dailyTarget(workReal, date);
      const before = await readOptional(target);
      const entries = before ? parseManagedDocument(before, date) : [];
      for (const addition of additions) {
        recordIds.push(addition.id);
        if (!entries.some(entry => entry.id === addition.id)) {
          entries.push(addition);
          inserted = true;
        }
      }
      entries.sort(compareEntries);
      const after = renderManagedDocument(date, entries);
      if (after !== before) await atomicReplace(target, before, after);
      const checked = parseManagedDocument(await readFile(target, "utf8"), date);
      for (const addition of additions) {
        if (!checked.some(entry => entry.id === addition.id)) throw new Error("write_verification_failed");
      }
      files.push(relative(vaultReal, target).split(sep).join("/"));
    }
    return {files, recordIds, inserted};
  }

  async supplement({messageId, createTime, targetRecordId, record}) {
    validateJob(messageId, createTime);
    if (!/^[a-f0-9]{16}$/.test(targetRecordId || "")) throw new Error("invalid_target_record_id");
    validateInputRecord(record);
    const {vaultReal, workReal} = await this.openRoots();
    const matches = await findTarget(workReal, targetRecordId);
    if (matches.length === 0) throw new Error("target_record_not_found");
    if (matches.length !== 1) throw new Error("target_record_not_unique");
    const match = matches[0];
    if (record.occurred_date !== match.date) throw new Error("supplement_date_mismatch");
    const newSourceId = sourceId(messageId, 0);
    const existing = match.entries[match.index];
    if (existing.sources.some(source => source.sourceId === newSourceId)) {
      return {files: [relative(vaultReal, match.target).split(sep).join("/")], recordIds: [targetRecordId], updated: false};
    }
    match.entries[match.index] = {
      ...existing,
      sortKey: makeSortKey(record, createTime, 0),
      record: withoutOriginal(record),
      sources: [...existing.sources, {kind: "supplement", text: record.original_text, sourceId: newSourceId}]
    };
    match.entries.sort(compareEntries);
    const after = renderManagedDocument(match.date, match.entries);
    await atomicReplace(match.target, match.before, after);
    const checked = parseManagedDocument(await readFile(match.target, "utf8"), match.date);
    const updated = checked.find(entry => entry.id === targetRecordId);
    if (!updated || !updated.sources.some(source => source.sourceId === newSourceId)) throw new Error("write_verification_failed");
    return {
      files: [relative(vaultReal, match.target).split(sep).join("/")],
      recordIds: [targetRecordId],
      updated: true
    };
  }

  async openRoots() {
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
    return {vaultReal, workReal};
  }
}

export function recordId(messageId, index) {
  return createHash("sha256").update(`${messageId}:${index}`).digest("hex").slice(0, 16);
}

function sourceId(messageId, index) {
  return createHash("sha256").update(`source:${messageId}:${index}`).digest("hex").slice(0, 16);
}

function validateJob(messageId, createTime) {
  if (typeof messageId !== "string" || !messageId || !Number.isFinite(createTime)) throw new Error("invalid_write_job");
}

function validateInputRecord(record) {
  if (!record || !/^\d{4}-\d{2}-\d{2}$/.test(record.occurred_date || "")) throw new Error("invalid_record_date");
  for (const field of ["occurred_time", "occurred_end_time"]) {
    if (record[field] && !/^([01]\d|2[0-3]):[0-5]\d$/.test(record[field])) throw new Error("invalid_record_time");
  }
  if (record.occurred_end_time && !record.occurred_time) throw new Error("end_time_without_start");
  for (const field of ["title", "summary", "original_text"]) {
    if (typeof record[field] !== "string" || !record[field]) throw new Error(`invalid_record_${field}`);
  }
  if (!Array.isArray(record.people) || !Array.isArray(record.follow_ups) || typeof record.location !== "string") {
    throw new Error("invalid_record_fields");
  }
}

function withoutOriginal(record) {
  return {
    occurred_date: record.occurred_date,
    occurred_time: record.occurred_time,
    occurred_end_time: record.occurred_end_time,
    title: record.title,
    people: [...record.people],
    location: record.location,
    summary: record.summary,
    follow_ups: [...record.follow_ups]
  };
}

function compareEntries(a, b) { return a.sortKey.localeCompare(b.sortKey) || a.id.localeCompare(b.id); }

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

async function dailyTarget(workReal, date) {
  const folder = `${date.slice(0, 4)}年${date.slice(5, 7)}月${date.slice(8, 10)}日`;
  const dailyDir = join(workReal, folder);
  await mkdir(dailyDir, {recursive: true, mode: 0o700});
  const dailyReal = await realpath(dailyDir);
  if (!dailyReal.startsWith(`${workReal}${sep}`)) throw new Error("path_escape");
  const target = resolve(dailyReal, "工作记录.md");
  if (!target.startsWith(`${workReal}${sep}`)) throw new Error("path_escape");
  return target;
}

async function findTarget(workReal, targetRecordId) {
  const matches = [];
  const folders = await readdir(workReal, {withFileTypes: true});
  for (const folder of folders) {
    const dateParts = folder.isDirectory() && folder.name.match(DATE_FOLDER);
    if (!dateParts) continue;
    const date = `${dateParts[1]}-${dateParts[2]}-${dateParts[3]}`;
    const target = resolve(workReal, folder.name, "工作记录.md");
    if (!target.startsWith(`${workReal}${sep}`)) throw new Error("path_escape");
    const before = await readOptional(target);
    if (!before) continue;
    const entries = parseManagedDocument(before, date);
    entries.forEach((entry, index) => {
      if (entry.id === targetRecordId) matches.push({date, target, before, entries, index});
    });
  }
  return matches;
}

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
