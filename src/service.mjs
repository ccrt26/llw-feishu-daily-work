import { createHash } from "node:crypto";
import { checkDailyWorkMessage } from "./policy.mjs";

export class DailyWorkService {
  constructor({state, decide, catalog, writer}) {
    this.state = state;
    this.decide = decide;
    this.catalog = catalog;
    this.writer = writer;
  }

  async handleMessage(message,{model="codex"}={}) {
    const checked = checkDailyWorkMessage(message);
    if (!checked.ok) {
      if (checked.notify && message?.sourceMessageId) return outcome("ignored", "当前工作记录第一版仅支持纯文字；该附件未下载、未交给 AI、未入库。");
      return {handled: false, reason: checked.reason};
    }

    let candidates;
    try {
      candidates = await this.catalog.list({limit: 20});
    } catch {
      return outcome("failed", "U盘知识库当前不可用，本条未入库；请连接U盘后重新发送。");
    }
    const checkedMessage = {...checked};
    const conversation=this.state.getConversation();
    const taskModel=conversation?.model||model;
    const decision = await this.safeDecide({message:checkedMessage, conversation, candidates,model:taskModel});
    if (decision.action === "unavailable") {
      return outcome("failed", decision.question);
    }
    switch (decision.action) {
      case "create_record": return this.createRecord(checkedMessage, decision);
      case "supplement_record": return this.supplementRecord(checkedMessage, decision, candidates);
      case "ask_user": return this.askUser(checkedMessage, decision, candidates,taskModel);
      case "ignore": return this.ignore(checkedMessage, decision);
      default: return outcome("failed", "AI 返回了不支持的操作，本条未入库；请稍后重新发送。");
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
      return outcome("failed", "U盘知识库当前不可用，本条未入库；请连接U盘后重新发送。");
    }
    await this.state.clearConversation();
    const reply = committedReply("已入库", decision.records, result.files);
    return outcome("committed", reply, result.files);
  }

  async supplementRecord(message, decision, candidates) {
    const candidate = candidates.find(item => item.record_id === decision.target_record_id);
    if (!candidate || decision.records.length !== 1 || decision.records[0].occurred_date !== candidate.date) {
      const reply = "补充目标已经变化或日期不一致，本条未写入；请重新说明要补充的记录。";
      return outcome("failed", reply);
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
      return outcome("failed", "U盘知识库当前不可用或目标记录已变化，本条未写入；请稍后重新发送。");
    }
    await this.state.clearConversation();
    const reply = committedReply("已补充到原记录", decision.records, result.files);
    return outcome("committed", reply, result.files);
  }

  async askUser(message, decision, candidates,model) {
    const current = this.state.getConversation();
    const conversation = {
      id: current?.id || conversationId(message.messageId),
      status: "open",
      turns: [
        ...(current?.turns || []),
        {role: "user", text: message.text, createTime: message.createTime},
        {role: "assistant", text: decision.question}
      ],
      candidateIds: candidates.map(candidate => candidate.record_id),
      model
    };
    await this.state.setConversation(conversation);
    return outcome("awaiting_clarification", decision.question);
  }

  async ignore(message, decision) {
    await this.state.clearConversation();
    return outcome("ignored", null);
  }
}

function outcome(status, reply, artifacts = []) {
  return {status, reply, artifacts};
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
