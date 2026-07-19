import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseManagedDocument } from "./managed-record.mjs";

const FOLDER = /^(\d{4})年(\d{2})月(\d{2})日$/;

export class RecordCatalog {
  constructor(vaultRoot) { this.vaultRoot = vaultRoot; }

  async list({limit = 20} = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid_catalog_limit");
    const vaultReal = await realpath(this.vaultRoot);
    await Promise.all([
      stat(join(vaultReal, ".obsidian")),
      stat(join(vaultReal, ".llw-system", "SYSTEM_MAP.md"))
    ]);
    const root = join(vaultReal, "亚信工作", "每日工作");
    let folders;
    try { folders = await readdir(root, {withFileTypes: true}); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    const dated = folders.flatMap(item => {
      const match = item.isDirectory() && item.name.match(FOLDER);
      return match ? [{name: item.name, date: `${match[1]}-${match[2]}-${match[3]}`}] : [];
    }).sort((a, b) => b.date.localeCompare(a.date));
    const entries = [];
    for (const folder of dated) {
      const file = join(root, folder.name, "工作记录.md");
      let markdown;
      try { markdown = await readFile(file, "utf8"); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      for (const entry of parseManagedDocument(markdown, folder.date)) entries.push(entry);
    }
    return entries
      .sort((a, b) => b.record.occurred_date.localeCompare(a.record.occurred_date) || b.sortKey.localeCompare(a.sortKey) || b.id.localeCompare(a.id))
      .slice(0, limit)
      .map(({id, record}) => ({
        record_id: id,
        date: record.occurred_date,
        occurred_time: record.occurred_time,
        occurred_end_time: record.occurred_end_time,
        title: record.title,
        people: [...record.people],
        location: record.location,
        summary: record.summary,
        follow_ups: [...record.follow_ups]
      }));
  }
}
