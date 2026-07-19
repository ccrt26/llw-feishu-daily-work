import { normalizeEvent } from "./event-normalizer.mjs";
import { checkSecurity } from "./security-gate.mjs";
import { routeCapability } from "./capability-router.mjs";

export class Dispatcher {
  constructor({binding, state, capabilities, messenger}) {
    this.binding = binding;
    this.state = state;
    this.capabilities = capabilities;
    this.messenger = messenger;
    this.queue = Promise.resolve();
  }

  handleRawEvent(raw) {
    const next = this.queue.then(() => this.processRawEvent(raw));
    this.queue = next.catch(() => {});
    return next;
  }

  async processRawEvent(raw) {
    let event;
    try {
      event = normalizeEvent(raw);
    } catch {
      return this.handleMalformed(raw);
    }
    const security = checkSecurity(event, this.binding);
    if (!security.ok) return {handled: false, reason: security.reason};
    if (event.messageType === "text" && !event.content.trim()) return {handled: false, reason: "empty_text"};
    if (this.state.hasOutcome(event.messageId)) return {handled: false, reason: "duplicate"};

    let capability = null;
    let draft;
    try {
      capability = routeCapability(event, {state: this.state}, this.capabilities);
      draft = capability
        ? await capability.handle(event, {state: this.state})
        : {status: "ignored", reply: "当前不支持此类消息，未下载、未交给 AI、未入库。", artifacts: []};
    } catch (error) {
      draft = error?.message?.startsWith("route_conflict:")
        ? {status: "failed", reply: "消息路由配置冲突，本条未处理；请稍后重试。", artifacts: []}
        : {status: "failed", reply: "处理能力暂时不可用，本条未处理；请稍后重新发送。", artifacts: []};
      capability = null;
    }
    return this.persistAndSend(event, capability?.name || "core", draft);
  }

  async resumeReplies() {
    for (const outcome of this.state.unreplied()) {
      const event = {
        messageId: outcome.messageId,
        chatId: this.binding.chatId
      };
      const capability = outcome.capability || "daily-work";
      await this.send(event, capability, outcome.reply);
      await this.state.markReplied(outcome.messageId);
    }
  }

  async handleMalformed(raw) {
    if (!isBoundMalformed(raw, this.binding)) return {handled: false, reason: "invalid_event"};
    if (this.state.hasOutcome(raw.message_id)) return {handled: false, reason: "duplicate"};
    const event = {messageId: raw.message_id, chatId: raw.chat_id};
    const draft = {status: "failed", reply: "消息结构无效，本条未处理；请重新发送。", artifacts: []};
    return this.persistAndSend(event, "core", draft);
  }

  async persistAndSend(event, capability, draft) {
    validateDraft(draft);
    await this.state.saveOutcome(event.messageId, {
      capability,
      status: draft.status,
      reply: draft.reply,
      artifacts: [...draft.artifacts],
      createdAt: new Date().toISOString()
    });
    await this.send(event, capability, draft.reply);
    await this.state.markReplied(event.messageId);
    return {handled: true, status: draft.status};
  }

  async send(event, capability, text) {
    const idempotencyKey = capability === "invoice" ? `invoice-reply:${event.messageId}` : `reply:${event.messageId}`;
    try {
      await this.messenger.send({capability, event, text, idempotencyKey});
    } catch {
      throw new Error("message_send_failed");
    }
  }
}

function isBoundMalformed(raw, binding) {
  return raw && typeof raw === "object"
    && raw.sender_id === binding.senderId
    && raw.chat_id === binding.chatId
    && raw.chat_type === "p2p"
    && typeof raw.message_id === "string"
    && raw.message_id.length > 0;
}

function validateDraft(draft) {
  const statuses = new Set(["committed", "existing", "awaiting_clarification", "rejected", "failed", "ignored"]);
  if (!draft || !statuses.has(draft.status) || typeof draft.reply !== "string" || !draft.reply || !Array.isArray(draft.artifacts)) {
    throw new Error("invalid_outcome_draft");
  }
}
