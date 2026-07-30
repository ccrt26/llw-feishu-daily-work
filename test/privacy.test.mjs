import test from "node:test";
import assert from "node:assert/strict";
import {safeLog} from "../src/core/redaction.mjs";
import {createRouterMessage} from "../src/core/router-message.mjs";
import {createFeishuIncomingMessage} from "../src/core/incoming-message.mjs";
import {guardAiInput} from "../src/ai/ai-input-guard.mjs";
import {classifyAiFailure} from "../src/core/ai-failure.mjs";
import {formatKnowledgeCommit} from "../src/capabilities/knowledge-ingest/receipt.mjs";

test("safe logs contain only allowlisted scalars and a one-way correlation",() => {
  const secrets=["om_secret","ou_secret","oc_secret","img_secret","123456789012","亚信科技（成都）有限公司","成都餐厅","290.00","token-secret","票面全文"];
  const line=safeLog({stage:"archive",code:"copy_verification_failed",messageId:secrets[0],durationMs:12,sizeBytes:99,stderrBytes:2,retryCount:1,content:secrets.at(-1),invoiceNumber:secrets[4],buyer:secrets[5],seller:secrets[6],amount:secrets[7],token:secrets[8]});
  const parsed=JSON.parse(line);
  assert.equal(parsed.stage,"archive"); assert.equal(parsed.code,"copy_verification_failed");
  assert.match(parsed.correlation,/^[a-f0-9]{12}$/);
  assert.deepEqual(Object.keys(parsed).sort(),["code","correlation","durationMs","sizeBytes","stage","stderrBytes","time","retryCount"].sort());
  for (const secret of secrets) assert.equal(line.includes(secret),false);
});

test("safe startup logs retain only bounded Skill bundle metadata",()=>{
  const line=safeLog({
    stage:"startup",
    code:"personal_assistant_skill_loaded",
    fileCount:7,
    totalBytes:20_111,
    bundleSha256:"a".repeat(64),
    content:"must-not-log",
    path:"/private/skill"
  });
  const parsed=JSON.parse(line);
  assert.equal(parsed.fileCount,7);
  assert.equal(parsed.totalBytes,20_111);
  assert.equal(parsed.bundleSha256,"a".repeat(64));
  assert.equal(line.includes("must-not-log"),false);
  assert.equal(line.includes("/private/skill"),false);
});

test("AI guard errors never echo rejected user content",()=>{
  const secret="Authorization: Bearer not-a-real-secret";
  let error;
  try { guardAiInput("router.text",{message:{type:"text",text:secret,beijingTime:"2026-07-23 09:30:00"},conversation:null,capabilities:[]}); }
  catch (caught) { error=caught; }
  assert.equal(error?.message,"ai_input_rejected");
  assert.equal(error?.reasonCode,"credential");
  assert.equal(String(error).includes(secret),false);
  assert.deepEqual(classifyAiFailure(error,"codex"),{status:"rejected",reasonCode:"credential",reply:"检测到可能包含实际密钥、登录凭证或支付控制信息。\n系统没有把本次内容发送给 Codex 或 DeepSeek，也没有写入业务记录。\n请删除或遮盖相关值后重新提交。"});
  assert.deepEqual(classifyAiFailure({message:"ai_input_rejected",reasonCode:"unexpected"},"codex"),{status:"rejected",reply:"检测到可能包含实际密钥、登录凭证或支付控制信息。\n系统没有把本次内容发送给 Codex 或 DeepSeek，也没有写入业务记录。\n请删除或遮盖相关值后重新提交。"});
});

test("router attachment summaries never include resource keys or Feishu identifiers",() => {
  const event={eventId:"event_secret",messageId:"message_secret",senderId:"sender_secret",chatId:"chat_secret",chatType:"p2p",messageType:"file",content:'<file name="发票.pdf" key="file_secret"/>',createTimeMs:1784426400000};
  const summary=JSON.stringify(createRouterMessage(createFeishuIncomingMessage(event)));
  for (const value of ["event_secret","message_secret","sender_secret","chat_secret","file_secret"]) assert.equal(summary.includes(value),false);
});

test("knowledge receipts fail closed instead of returning absolute managed roots",()=>{
  assert.throws(
    ()=>formatKnowledgeCommit(
      {title:"交流方案"},
      {
        status:"created",
        relativePath:"/Volumes/private-vault/work/交流方案",
        files:["/Volumes/private-vault/work/交流方案/knowledge.md"]
      },
      {libraryKey:"work-knowledge",displayName:"工作资料"}
    ),
    /invalid_knowledge_receipt/
  );
});
