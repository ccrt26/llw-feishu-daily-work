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
    let data = emptyState();
    let migrated = false;
    try {
      const parsed = JSON.parse(await readFile(file, "utf8"));
      if (parsed?.version === 3 && parsed.capabilityState && typeof parsed.capabilityState === "object" && parsed.outcomes && typeof parsed.outcomes === "object") {
        data = {
          version: 3,
          capabilityState: structuredClone(parsed.capabilityState),
          outcomes: structuredClone(parsed.outcomes)
        };
        if (!data.capabilityState["daily-work"]) data.capabilityState["daily-work"] = {conversation: null};
        if (!data.capabilityState.invoice) data.capabilityState.invoice = {};
      } else if (parsed?.version === 2 && parsed.outcomes && typeof parsed.outcomes === "object") {
        data = migratedState(parsed.conversation || null, parsed.outcomes);
        migrated = true;
      } else if (parsed?.version === 1 && parsed.outcomes && typeof parsed.outcomes === "object") {
        data = migratedState(migratePending(parsed.pending), parsed.outcomes);
        migrated = true;
      } else throw new Error("unsupported_state_version");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const store = new StateStore(file, data, maxOutcomes);
    if (migrated) await store.persist();
    return store;
  }

  version() { return this.data.version; }
  getCapabilityState(name) { return structuredClone(this.data.capabilityState[name] || {}); }

  listInvoiceTransactions() {
    const transactions = this.data.capabilityState.invoice?.transactions || {};
    return Object.values(transactions).map(value => structuredClone(value));
  }

  async prepareInvoiceTransaction(transactionId, data) {
    if (typeof transactionId !== "string" || !transactionId || !data || !/^[a-f0-9]{64}$/.test(data.sourceHash) || typeof data.targetRelativePath !== "string") {
      throw new Error("invalid_invoice_transaction");
    }
    const invoice = this.data.capabilityState.invoice ||= {};
    const transactions = invoice.transactions ||= {};
    if (transactions[transactionId]) throw new Error("invoice_transaction_exists");
    transactions[transactionId] = {
      transactionId,
      targetRelativePath: data.targetRelativePath,
      sourceHash: data.sourceHash,
      status: "prepared",
      createdAt: new Date().toISOString()
    };
    pruneTransactions(transactions);
    await this.persist();
    return structuredClone(transactions[transactionId]);
  }

  async updateInvoiceTransaction(transactionId, status) {
    if (!["prepared","published","aborted","needs_inspection"].includes(status)) throw new Error("invalid_invoice_transaction_status");
    const transaction = this.data.capabilityState.invoice?.transactions?.[transactionId];
    if (!transaction) throw new Error("invoice_transaction_not_found");
    transaction.status = status;
    await this.persist();
    return structuredClone(transaction);
  }

  async setCapabilityState(name, value) {
    if (typeof name !== "string" || !name || !value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("invalid_capability_state");
    }
    this.data.capabilityState[name] = structuredClone(value);
    await this.persist();
  }

  getConversation() { return structuredClone(this.data.capabilityState["daily-work"].conversation || null); }
  hasOutcome(messageId) { return Object.hasOwn(this.data.outcomes, messageId); }

  unreplied() {
    return Object.entries(this.data.outcomes)
      .filter(([, outcome]) => !outcome.replied)
      .map(([messageId, outcome]) => ({messageId, ...structuredClone(outcome)}));
  }

  async setConversation(conversation) {
    validateConversation(conversation);
    this.data.capabilityState["daily-work"].conversation = structuredClone(conversation);
    await this.persist();
  }

  async clearConversation() {
    this.data.capabilityState["daily-work"].conversation = null;
    await this.persist();
  }

  async saveOutcome(messageId, outcome) {
    if (!this.hasOutcome(messageId)) {
      const stored = {...structuredClone(outcome), replied: false};
      if (Array.isArray(stored.recordIds)) stored.recordIds = [...stored.recordIds];
      if (Array.isArray(stored.artifacts)) stored.artifacts = [...stored.artifacts];
      this.data.outcomes[messageId] = stored;
      while (Object.keys(this.data.outcomes).length > this.maxOutcomes) {
        const removable = Object.keys(this.data.outcomes).find(id => this.data.outcomes[id].replied === true);
        if (!removable) break;
        delete this.data.outcomes[removable];
      }
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

function emptyState() {
  return {
    version: 3,
    capabilityState: {"daily-work": {conversation: null}, invoice: {}},
    outcomes: {}
  };
}

function migratedState(conversation, outcomes) {
  return {
    version: 3,
    capabilityState: {"daily-work": {conversation}, invoice: {}},
    outcomes: structuredClone(outcomes)
  };
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

function pruneTransactions(transactions) {
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  for (const [id,transaction] of Object.entries(transactions)) {
    if (["published","aborted"].includes(transaction.status) && Date.parse(transaction.createdAt) < cutoff) delete transactions[id];
  }
  const eligible = Object.values(transactions)
    .filter(transaction => ["published","aborted"].includes(transaction.status))
    .sort((a,b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  while (Object.keys(transactions).length > 2000 && eligible.length) delete transactions[eligible.shift().transactionId];
}
