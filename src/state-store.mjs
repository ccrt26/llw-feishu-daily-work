import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export class StateStore {
  constructor(file, data, maxOutcomes) {
    this.file = file;
    this.data = data;
    this.maxOutcomes = maxOutcomes;
  }

  static async open(file, {maxOutcomes = 1000} = {}) {
    let data = {version: 1, pending: null, outcomes: {}};
    try {
      const parsed = JSON.parse(await readFile(file, "utf8"));
      if (parsed?.version === 1 && parsed.outcomes && typeof parsed.outcomes === "object") data = parsed;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return new StateStore(file, data, maxOutcomes);
  }

  getPending() { return structuredClone(this.data.pending); }
  hasOutcome(messageId) { return Object.hasOwn(this.data.outcomes, messageId); }

  unreplied() {
    return Object.entries(this.data.outcomes)
      .filter(([, outcome]) => !outcome.replied)
      .map(([messageId, outcome]) => ({messageId, ...structuredClone(outcome)}));
  }

  async setPending(pending) {
    this.data.pending = structuredClone(pending);
    await this.persist();
  }

  async clearPending() {
    this.data.pending = null;
    await this.persist();
  }

  async saveOutcome(messageId, {status, reply, recordIds = []}) {
    if (!this.hasOutcome(messageId)) {
      this.data.outcomes[messageId] = {status, reply, recordIds: [...recordIds], replied: false};
      const ids = Object.keys(this.data.outcomes);
      while (ids.length > this.maxOutcomes) delete this.data.outcomes[ids.shift()];
      await this.persist();
    }
    return structuredClone(this.data.outcomes[messageId]);
  }

  async markReplied(messageId) {
    const outcome = this.data.outcomes[messageId];
    if (!outcome) throw new Error("outcome_not_found");
    outcome.replied = true;
    await this.persist();
  }

  async persist() {
    await mkdir(dirname(this.file), {recursive: true, mode: 0o700});
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(this.data)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.file);
  }
}
