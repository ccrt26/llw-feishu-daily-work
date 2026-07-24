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
      if (parsed?.version === 4 && parsed.capabilityState && typeof parsed.capabilityState === "object" && parsed.outcomes && typeof parsed.outcomes === "object") {
        data = {
          version: 4,
          capabilityState: structuredClone(parsed.capabilityState),
          outcomes: structuredClone(parsed.outcomes)
        };
        if (!data.capabilityState["daily-work"]) data.capabilityState["daily-work"] = {conversation: null};
        if (!data.capabilityState.invoice) data.capabilityState.invoice = {};
        if (!data.capabilityState.router) data.capabilityState.router = {conversation: null};
      } else if (parsed?.version === 3 && parsed.capabilityState && typeof parsed.capabilityState === "object" && parsed.outcomes && typeof parsed.outcomes === "object") {
        data={version:4,capabilityState:structuredClone(parsed.capabilityState),outcomes:structuredClone(parsed.outcomes)};
        if (!data.capabilityState["daily-work"]) data.capabilityState["daily-work"]={conversation:null};
        if (!data.capabilityState.invoice) data.capabilityState.invoice={};
        data.capabilityState.router={conversation:null};
        migrated=true;
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

  async getRouterConversation(nowMs=Date.now()) {
    const conversation=normalizeRouterConversation(this.data.capabilityState.router?.conversation);
    if (!conversation || conversation.status!=="open") return null;
    if (nowMs-Date.parse(conversation.startedAt) < 24*60*60*1000) return structuredClone(conversation);
    this.data.capabilityState.router.conversation=null;
    await this.persist();
    return null;
  }

  async setRouterConversation(conversation) {
    const normalized=normalizeRouterConversation(conversation);
    validateRouterConversation(normalized);
    this.data.capabilityState.router={conversation:normalized};
    await this.persist();
  }

  async closeRouterConversation(status) {
    if (!["superseded","cancelled"].includes(status)) throw new Error("invalid_router_conversation_status");
    const conversation=this.data.capabilityState.router?.conversation;
    if (!conversation) return;
    conversation.status=status;
    await this.persist();
  }

  async clearRouterConversation() {
    this.data.capabilityState.router={conversation:null};
    await this.persist();
  }

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

  getConversation() { return normalizeActivityConversation(this.data.capabilityState["daily-work"].conversation); }
  hasOutcome(messageId) { return Object.hasOwn(this.data.outcomes, messageId); }

  unreplied() {
    return Object.entries(this.data.outcomes)
      .filter(([, outcome]) => !outcome.replied && outcome.noReplyRequired !== true)
      .map(([messageId, outcome]) => ({messageId, ...structuredClone(outcome)}));
  }

  async setConversation(conversation) {
    const normalized=normalizeActivityConversation(conversation);
    validateConversation(normalized);
    this.data.capabilityState["daily-work"].conversation = normalized;
    await this.persist();
  }

  async clearConversation() {
    this.data.capabilityState["daily-work"].conversation = null;
    await this.persist();
  }

  async saveOutcome(messageId, outcome) {
    if (!this.hasOutcome(messageId)) {
      const stored = {...structuredClone(outcome), replied: false};
      if (stored.replyTarget!==undefined) validateReplyTarget(stored.replyTarget);
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
    version: 4,
    capabilityState: {"daily-work": {conversation: null}, invoice: {}, router:{conversation:null}},
    outcomes: {}
  };
}

function migratedState(conversation, outcomes) {
  return {
    version: 4,
    capabilityState: {"daily-work": {conversation}, invoice: {}, router:{conversation:null}},
    outcomes: structuredClone(outcomes)
  };
}

function validateRouterConversation(conversation) {
  const fields=new Set(["capability","question","startedAt","attempts","status","model"]);
  if (!conversation || typeof conversation!=="object" || Array.isArray(conversation) || Object.keys(conversation).length!==fields.size || Object.keys(conversation).some(key=>!fields.has(key))) throw new Error("invalid_router_conversation");
  if (conversation.capability!==null && (typeof conversation.capability!=="string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(conversation.capability))) throw new Error("invalid_router_conversation");
  if (typeof conversation.question!=="string" || !conversation.question.trim() || [...conversation.question].length>200) throw new Error("invalid_router_conversation");
  if (!["codex","deepseek"].includes(conversation.model)) throw new Error("invalid_router_conversation");
  if (!Number.isFinite(Date.parse(conversation.startedAt)) || conversation.attempts!==1 || !["open","superseded","cancelled"].includes(conversation.status)) throw new Error("invalid_router_conversation");
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
  if (!["codex","deepseek"].includes(conversation.model)) throw new Error("invalid_conversation_model");
  for (const turn of conversation.turns) {
    if (!turn || !["user", "assistant"].includes(turn.role) || typeof turn.text !== "string" || !turn.text) {
      throw new Error("invalid_conversation_turn");
    }
  }
  if (!conversation.candidateIds.every(id => /^[a-f0-9]{16}$/.test(id))) throw new Error("invalid_conversation_candidate");
}

function normalizeRouterConversation(conversation) {
  if (!conversation || typeof conversation!=="object" || conversation.status!=="open") return null;
  return structuredClone({...conversation,model:conversation.model==="deepseek"?"deepseek":"codex"});
}

function normalizeActivityConversation(conversation) {
  if (!conversation || typeof conversation!=="object") return null;
  return structuredClone({...conversation,model:conversation.model==="deepseek"?"deepseek":"codex"});
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

function validateReplyTarget(value) {
  if (!value||typeof value!=="object"||Array.isArray(value)) throw new Error("invalid_reply_target");
  const fields=value.source==="wechat"
    ?new Set(["source","sourceMessageId","conversationId","contextToken"])
    :new Set(["source","sourceMessageId","conversationId"]);
  if (!["feishu","wechat"].includes(value.source)||Object.keys(value).length!==fields.size||Object.keys(value).some(key=>!fields.has(key))) throw new Error("invalid_reply_target");
  for (const field of fields) if (typeof value[field]!=="string"||!value[field]) throw new Error("invalid_reply_target");
}
