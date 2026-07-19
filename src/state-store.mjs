import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

export class StateStore {
  constructor(file, data, maxOutcomes) {
    this.file = file;
    this.data = data;
    this.maxOutcomes = maxOutcomes;
  }

  static async open(file, {maxOutcomes = 1000} = {}) {
    let data = {version: 2, conversation: null, outcomes: {}};
    let migrated = false;
    try {
      const parsed = JSON.parse(await readFile(file, "utf8"));
      if (parsed?.version === 2 && parsed.outcomes && typeof parsed.outcomes === "object") {
        data = {version: 2, conversation: parsed.conversation || null, outcomes: parsed.outcomes};
      } else if (parsed?.version === 1 && parsed.outcomes && typeof parsed.outcomes === "object") {
        data = {version: 2, conversation: migratePending(parsed.pending), outcomes: parsed.outcomes};
        migrated = true;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const store = new StateStore(file, data, maxOutcomes);
    if (migrated) await store.persist();
    return store;
  }

  getConversation() { return structuredClone(this.data.conversation); }
  hasOutcome(messageId) { return Object.hasOwn(this.data.outcomes, messageId); }

  unreplied() {
    return Object.entries(this.data.outcomes)
      .filter(([, outcome]) => !outcome.replied)
      .map(([messageId, outcome]) => ({messageId, ...structuredClone(outcome)}));
  }

  async setConversation(conversation) {
    validateConversation(conversation);
    this.data.conversation = structuredClone(conversation);
    await this.persist();
  }

  async clearConversation() {
    this.data.conversation = null;
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

function migratePending(pending) {
  if (!pending || typeof pending !== "object" || typeof pending.text !== "string" || !pending.text) return null;
  const turns = [{role: "user", text: pending.text, createTime: Number(pending.createTime)}];
  if (typeof pending.question === "string" && pending.question) turns.push({role: "assistant", text: pending.question});
  return {
    id: `legacy-${String(pending.messageId || "conversation")}`,
    status: "open",
    turns,
    candidateIds: []
  };
}

function validateConversation(conversation) {
  if (!conversation || typeof conversation !== "object" || typeof conversation.id !== "string" || !conversation.id) {
    throw new Error("invalid_conversation");
  }
  if (conversation.status !== "open" || !Array.isArray(conversation.turns) || !Array.isArray(conversation.candidateIds)) {
    throw new Error("invalid_conversation");
  }
  for (const turn of conversation.turns) {
    if (!turn || !["user", "assistant"].includes(turn.role) || typeof turn.text !== "string" || !turn.text) {
      throw new Error("invalid_conversation_turn");
    }
  }
  if (!conversation.candidateIds.every(id => /^[a-f0-9]{16}$/.test(id))) throw new Error("invalid_conversation_candidate");
}
