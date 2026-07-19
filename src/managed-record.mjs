const ID = /^[a-f0-9]{16}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^$|^([01]\d|2[0-3]):[0-5]\d$/;
const SORT_KEY = /^[0-9-]+$/;

export function encodeRecordData(entry) {
  validateEntry(entry);
  return Buffer.from(JSON.stringify(entry), "utf8").toString("base64url");
}

export function decodeRecordData(encoded) {
  if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("invalid_record_data");
  let value;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid_record_data");
  }
  validateEntry(value);
  return value;
}

export function parseManagedDocument(markdown, date) {
  if (typeof markdown !== "string" || !DATE.test(date)) throw new Error("invalid_managed_document");
  const expectedHeading = `# ${date.slice(0, 4)}年${date.slice(5, 7)}月${date.slice(8, 10)}日工作记录`;
  if (!markdown.startsWith(expectedHeading)) throw new Error("unexpected_daily_file");
  const headers = [...markdown.matchAll(/(?:^# [^\n]+\n\n|^---\n\n)> \[!abstract\]- 内部数据（程序使用）$/gm)];
  if (headers.length === 0) return parseLegacyManagedDocument(markdown, date);
  if (/^<!-- llw-record-start:/m.test(markdown)) throw new Error("mixed_record_formats");
  const blocks = [...markdown.matchAll(/(?:^# [^\n]+\n\n|^---\n\n)> \[!abstract\]- 内部数据（程序使用）\n> llw-record-data: ([A-Za-z0-9_-]+)\n\n(?=## )/gm)];
  if (blocks.length !== headers.length) throw new Error("malformed_record_markers");
  return blocks.map(match => {
    const entry = decodeRecordData(match[1]);
    if (entry.record.occurred_date !== date) throw new Error("record_date_mismatch");
    return entry;
  });
}

export function parseLegacyManagedDocument(markdown, date) {
  if (typeof markdown !== "string" || !DATE.test(date)) throw new Error("invalid_managed_document");
  const expectedHeading = `# ${date.slice(0, 4)}年${date.slice(5, 7)}月${date.slice(8, 10)}日工作记录`;
  if (!markdown.startsWith(expectedHeading)) throw new Error("unexpected_daily_file");
  const starts = [...markdown.matchAll(/^<!-- llw-record-start: ([a-f0-9]{16}) ([0-9-]+) -->$/gm)];
  const ends = [...markdown.matchAll(/^<!-- llw-record-end: ([a-f0-9]{16}) -->$/gm)];
  if (starts.length !== ends.length) throw new Error("malformed_record_markers");
  const blocks = [...markdown.matchAll(/^<!-- llw-record-start: ([a-f0-9]{16}) ([0-9-]+) -->$[\s\S]*?^<!-- llw-record-end: \1 -->$/gm)];
  if (blocks.length !== starts.length) throw new Error("malformed_record_markers");
  return blocks.map(match => {
    const data = match[0].match(/^<!-- llw-record-data: ([A-Za-z0-9_-]+) -->$/m);
    if (!data) throw new Error("record_data_missing");
    const entry = decodeRecordData(data[1]);
    if (entry.id !== match[1] || entry.sortKey !== match[2]) throw new Error("record_data_mismatch");
    if (entry.record.occurred_date !== date) throw new Error("record_date_mismatch");
    return entry;
  });
}

export function renderLegacyManagedDocument(date, entries) {
  if (!DATE.test(date) || !Array.isArray(entries)) throw new Error("invalid_managed_document");
  for (const entry of entries) {
    validateEntry(entry);
    if (entry.record.occurred_date !== date) throw new Error("record_date_mismatch");
  }
  const heading = `# ${date.slice(0, 4)}年${date.slice(5, 7)}月${date.slice(8, 10)}日工作记录`;
  const blocks = entries.map((entry, index) => renderLegacyBlock(entry, index + 1));
  return `${heading}\n\n${blocks.join("\n\n---\n\n")}\n`;
}

export function renderManagedDocument(date, entries) {
  if (!DATE.test(date) || !Array.isArray(entries)) throw new Error("invalid_managed_document");
  for (const entry of entries) {
    validateEntry(entry);
    if (entry.record.occurred_date !== date) throw new Error("record_date_mismatch");
  }
  const heading = `# ${date.slice(0, 4)}年${date.slice(5, 7)}月${date.slice(8, 10)}日工作记录`;
  const blocks = entries.map((entry, index) => renderBlock(entry, index + 1));
  return `${heading}\n\n${blocks.join("\n\n---\n\n")}\n`;
}

function validateEntry(entry) {
  if (!entry || typeof entry !== "object" || !ID.test(entry.id || "")) throw new Error("invalid_record_id");
  if (!SORT_KEY.test(entry.sortKey || "")) throw new Error("invalid_sort_key");
  validateRecord(entry.record);
  if (!Array.isArray(entry.sources) || entry.sources.length === 0) throw new Error("invalid_sources");
  const sourceIds = new Set();
  entry.sources.forEach((source, index) => {
    if (!source || !["initial", "supplement"].includes(source.kind)) throw new Error("invalid_source_kind");
    if (index === 0 && source.kind !== "initial") throw new Error("first_source_not_initial");
    if (index > 0 && source.kind !== "supplement") throw new Error("later_source_not_supplement");
    if (typeof source.text !== "string" || !source.text) throw new Error("invalid_source_text");
    if (!ID.test(source.sourceId || "")) throw new Error("invalid_source_id");
    if (sourceIds.has(source.sourceId)) throw new Error("duplicate_source_id");
    sourceIds.add(source.sourceId);
  });
}

function validateRecord(record) {
  if (!record || !DATE.test(record.occurred_date || "")) throw new Error("invalid_record_date");
  if (!TIME.test(record.occurred_time ?? "") || !TIME.test(record.occurred_end_time ?? "")) throw new Error("invalid_record_time");
  if (record.occurred_end_time && !record.occurred_time) throw new Error("end_time_without_start");
  for (const field of ["title", "summary"]) {
    if (typeof record[field] !== "string" || !record[field]) throw new Error(`invalid_record_${field}`);
  }
  if (!Array.isArray(record.people) || !Array.isArray(record.follow_ups) || typeof record.location !== "string") {
    throw new Error("invalid_record_fields");
  }
}

function renderBlock(entry, number) {
  return `> [!abstract]- 内部数据（程序使用）\n> llw-record-data: ${encodeRecordData(entry)}\n\n${renderVisibleBlock(entry, number)}`;
}

function renderLegacyBlock(entry, number) {
  return `<!-- llw-record-start: ${entry.id} ${entry.sortKey} -->\n<!-- llw-record-data: ${encodeRecordData(entry)} -->\n${renderVisibleBlock(entry, number)}\n\n<!-- llw-record-end: ${entry.id} -->`;
}

function renderVisibleBlock(entry, number) {
  const {record} = entry;
  const time = record.occurred_time
    ? `${record.occurred_time}${record.occurred_end_time ? `–${record.occurred_end_time}` : ""}`
    : "时间未说明";
  const people = record.people.length ? record.people.map(safeInline).join("、") : "未说明";
  const location = record.location ? safeInline(record.location) : "未说明";
  const followUps = record.follow_ups.length ? record.follow_ups.map(value => `- ${safeLine(value)}`).join("\n") : "- 未说明";
  const sources = entry.sources.map((source, index) => {
    const label = source.kind === "initial" ? "首次记录" : "补充";
    const quoted = source.text.split(/\r?\n/).map(line => `> ${line}`).join("\n");
    return `> [!quote]- 原始内容 ${index + 1}｜${label}\n${quoted}`;
  }).join("\n\n");
  return `## 记录 ${number}｜${time}｜${safeInline(record.title)}\n\n> [!info] 关键信息\n> - 时间：${record.occurred_date}${record.occurred_time ? ` ${time}` : "（具体时间未说明）"}（北京时间）\n> - 人物：${people}\n> - 地点：${location}\n\n### 整理后记录\n\n${safeParagraph(record.summary)}\n\n### 后续事项\n\n${followUps}\n\n${sources}`;
}

function safeInline(value) { return String(value).replace(/[\r\n|#]/g, " ").trim(); }
function safeLine(value) { return String(value).replace(/[\r\n]/g, " ").replace(/<!-- llw-record-/g, "&lt;!-- llw-record-").trim(); }
function safeParagraph(value) { return String(value).replace(/<!-- llw-record-/g, "&lt;!-- llw-record-").trim(); }
