import { checkEvent } from "./policy.mjs";

const YES = new Set(["是", "确认", "要", "需要"]);
const NO = new Set(["否", "不是", "不要", "不需要"]);

export class DailyWorkService {
  constructor({binding, state, classify, writer, send}) {
    this.binding = binding;
    this.state = state;
    this.classify = classify;
    this.writer = writer;
    this.send = send;
  }

  async handleEvent(event) {
    const checked = checkEvent(event, this.binding);
    if (!checked.ok) {
      if (checked.notify && event?.message_id && !this.state.hasOutcome(event.message_id)) {
        await this.finish(event.message_id, "ignored", "当前工作记录第一版仅支持纯文字；该附件未下载、未交给 AI、未入库。", []);
      }
      return {handled: false, reason: checked.reason};
    }
    if (this.state.hasOutcome(checked.messageId)) return {handled: false, reason: "duplicate"};

    const pending = this.state.getPending();
    if (pending) return this.handleConfirmation(checked, pending);

    const decision = await this.safeClassify(checked);
    return this.applyDecision(checked, decision);
  }

  async resumeReplies() {
    for (const outcome of this.state.unreplied()) {
      await this.send({chatId: this.binding.chatId, text: outcome.reply, idempotencyKey: `reply:${outcome.messageId}`});
      await this.state.markReplied(outcome.messageId);
      if (this.state.getPending()?.messageId === outcome.messageId) await this.state.clearPending();
    }
  }

  async handleConfirmation(message, pending) {
    const answer = message.text.trim();
    if (YES.has(answer)) {
      const decision = await this.safeClassify({...pending, forceDaily: true});
      if (decision.intent === "unavailable") {
        await this.state.clearPending();
        await this.finish(pending.messageId, "ignored", decision.question, []);
        return {handled: true, status: "unavailable"};
      }
      if (decision.intent !== "daily_work" || decision.confidence !== "high") {
        const question = decision.question || "请补充要记录的具体工作事项和日期。";
        await this.finish(message.messageId, "ignored", question, []);
        return {handled: true, status: "still_uncertain"};
      }
      let result;
      try {
        result = await this.writer.commit({messageId: pending.messageId, createTime: pending.createTime, records: decision.records});
      } catch {
        await this.state.clearPending();
        await this.finish(pending.messageId, "ignored", "U盘知识库当前不可用，本条未入库；请连接U盘后重新发送。", []);
        return {handled: true, status: "vault_unavailable"};
      }
      const reply = committedReply(decision.records, result.files);
      await this.state.saveOutcome(pending.messageId, {status: "committed", reply, recordIds: result.recordIds});
      await this.state.clearPending();
      await this.send({chatId: this.binding.chatId, text: reply, idempotencyKey: `reply:${pending.messageId}`});
      await this.state.markReplied(pending.messageId);
      return {handled: true, status: "committed"};
    }
    if (NO.has(answer)) {
      const reply = "已确认，这段内容不作为工作记录入库。";
      await this.state.saveOutcome(pending.messageId, {status: "ignored", reply, recordIds: []});
      await this.state.clearPending();
      await this.send({chatId: this.binding.chatId, text: reply, idempotencyKey: `reply:${pending.messageId}`});
      await this.state.markReplied(pending.messageId);
      return {handled: true, status: "ignored"};
    }
    await this.finish(message.messageId, "ignored", "请先回答上一条：回复“是”入库，回复“否”不入库。", []);
    return {handled: true, status: "awaiting_confirmation"};
  }

  async safeClassify(message) {
    try {
      return await this.classify({text: message.text, createTime: message.createTime, forceDaily: Boolean(message.forceDaily)});
    } catch {
      return {intent: "unavailable", confidence: "low", question: "AI 暂时不可用，本条未入库；请稍后重新发送。", records: []};
    }
  }

  async applyDecision(message, decision) {
    if (decision.intent === "unavailable") {
      await this.finish(message.messageId, "ignored", decision.question, []);
      return {handled: true, status: "unavailable"};
    }
    if (decision.intent === "daily_work" && decision.confidence === "high") {
      let result;
      try {
        result = await this.writer.commit({messageId: message.messageId, createTime: message.createTime, records: decision.records});
      } catch {
        await this.finish(message.messageId, "ignored", "U盘知识库当前不可用，本条未入库；请连接U盘后重新发送。", []);
        return {handled: true, status: "vault_unavailable"};
      }
      const reply = committedReply(decision.records, result.files);
      await this.finish(message.messageId, "committed", reply, result.recordIds);
      return {handled: true, status: "committed"};
    }
    if (decision.intent === "other") {
      await this.finish(message.messageId, "ignored", "这段内容未作为工作记录入库。", []);
      return {handled: true, status: "ignored"};
    }
    const question = decision.question || "这段内容是否需要作为工作记录入库？";
    await this.state.setPending({...message, question});
    await this.send({chatId: this.binding.chatId, text: question, idempotencyKey: `question:${message.messageId}`});
    return {handled: true, status: "awaiting_confirmation"};
  }

  async finish(messageId, status, reply, recordIds) {
    await this.state.saveOutcome(messageId, {status, reply, recordIds});
    await this.send({chatId: this.binding.chatId, text: reply, idempotencyKey: `reply:${messageId}`});
    await this.state.markReplied(messageId);
  }
}

function committedReply(records, files) {
  const lines = ["已入库，整理内容如下："];
  records.forEach((record, index) => lines.push(`${index + 1}. ${record.summary}`));
  lines.push(`位置：${files.join("、")}`);
  return lines.join("\n");
}
