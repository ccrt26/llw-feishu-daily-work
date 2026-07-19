import { createHash } from "node:crypto";
import { checkEvent } from "./policy.mjs";

export class DailyWorkService {
  constructor({binding, state, decide, catalog, writer, send}) {
    this.binding = binding;
    this.state = state;
    this.decide = decide;
    this.catalog = catalog;
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

    let candidates;
    try {
      candidates = await this.catalog.list({limit: 20});
    } catch {
      await this.finish(checked.messageId, "failed", "U盘知识库当前不可用，本条未入库；请连接U盘后重新发送。", []);
      return {handled: true, status: "vault_unavailable"};
    }
    const message = {...checked};
    const decision = await this.safeDecide({message, conversation: this.state.getConversation(), candidates});
    if (decision.action === "unavailable") {
      await this.finish(message.messageId, "failed", decision.question, []);
      return {handled: true, status: "unavailable"};
    }
    switch (decision.action) {
      case "create_record": return this.createRecord(message, decision);
      case "supplement_record": return this.supplementRecord(message, decision, candidates);
      case "ask_user": return this.askUser(message, decision, candidates);
      case "ignore": return this.ignore(message, decision);
      default:
        await this.finish(message.messageId, "failed", "AI 返回了不支持的操作，本条未入库；请稍后重新发送。", []);
        return {handled: true, status: "invalid_action"};
    }
  }

  async resumeReplies() {
    for (const outcome of this.state.unreplied()) {
      await this.send({chatId: this.binding.chatId, text: outcome.reply, idempotencyKey: `reply:${outcome.messageId}`});
      await this.state.markReplied(outcome.messageId);
    }
  }

  async safeDecide(input) {
    try { return await this.decide(input); }
    catch { return {action: "unavailable", question: "AI 暂时不可用，本条未入库；请稍后重新发送。"}; }
  }

  async createRecord(message, decision) {
    let result;
    try {
      result = await this.writer.create({messageId: message.messageId, createTime: message.createTime, records: decision.records});
    } catch {
      await this.finish(message.messageId, "failed", "U盘知识库当前不可用，本条未入库；请连接U盘后重新发送。", []);
      return {handled: true, status: "vault_unavailable"};
    }
    await this.state.clearConversation();
    const reply = committedReply("已入库", decision.records, result.files);
    await this.finish(message.messageId, "committed", reply, result.recordIds);
    return {handled: true, status: "committed"};
  }

  async supplementRecord(message, decision, candidates) {
    const candidate = candidates.find(item => item.record_id === decision.target_record_id);
    if (!candidate || decision.records.length !== 1 || decision.records[0].occurred_date !== candidate.date) {
      const reply = "补充目标已经变化或日期不一致，本条未写入；请重新说明要补充的记录。";
      await this.finish(message.messageId, "failed", reply, []);
      return {handled: true, status: "stale_target"};
    }
    let result;
    try {
      result = await this.writer.supplement({
        messageId: message.messageId,
        createTime: message.createTime,
        targetRecordId: decision.target_record_id,
        record: decision.records[0]
      });
    } catch {
      await this.finish(message.messageId, "failed", "U盘知识库当前不可用或目标记录已变化，本条未写入；请稍后重新发送。", []);
      return {handled: true, status: "vault_unavailable"};
    }
    await this.state.clearConversation();
    const reply = committedReply("已补充到原记录", decision.records, result.files);
    await this.finish(message.messageId, "committed", reply, result.recordIds);
    return {handled: true, status: "committed"};
  }

  async askUser(message, decision, candidates) {
    const current = this.state.getConversation();
    const conversation = {
      id: current?.id || conversationId(message.messageId),
      status: "open",
      turns: [
        ...(current?.turns || []),
        {role: "user", text: message.text, createTime: message.createTime},
        {role: "assistant", text: decision.question}
      ],
      candidateIds: candidates.map(candidate => candidate.record_id)
    };
    await this.state.setConversation(conversation);
    await this.finish(message.messageId, "awaiting_clarification", decision.question, []);
    return {handled: true, status: "awaiting_clarification"};
  }

  async ignore(message, decision) {
    await this.state.clearConversation();
    const reason = String(decision.reason || "不是工作记录").trim();
    const reply = `这段内容未作为工作记录入库。原因：${reason}`;
    await this.finish(message.messageId, "ignored", reply, []);
    return {handled: true, status: "ignored"};
  }

  async finish(messageId, status, reply, recordIds) {
    await this.state.saveOutcome(messageId, {status, reply, recordIds});
    await this.send({chatId: this.binding.chatId, text: reply, idempotencyKey: `reply:${messageId}`});
    await this.state.markReplied(messageId);
  }
}

function conversationId(messageId) {
  return createHash("sha256").update(`conversation:${messageId}`).digest("hex").slice(0, 16);
}

function committedReply(prefix, records, files) {
  const lines = [`${prefix}，整理内容如下：`];
  records.forEach((record, index) => lines.push(`${index + 1}. ${record.summary}`));
  lines.push(`位置：${files.join("、")}`);
  return lines.join("\n");
}
