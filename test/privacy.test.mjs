import test from "node:test";
import assert from "node:assert/strict";
import {safeLog} from "../src/core/redaction.mjs";
import {createRouterMessage} from "../src/core/router-message.mjs";
import {createFeishuIncomingMessage} from "../src/core/incoming-message.mjs";

test("safe logs contain only allowlisted scalars and a one-way correlation",() => {
  const secrets=["om_secret","ou_secret","oc_secret","img_secret","123456789012","亚信科技（成都）有限公司","成都餐厅","290.00","token-secret","票面全文"];
  const line=safeLog({stage:"archive",code:"copy_verification_failed",messageId:secrets[0],durationMs:12,sizeBytes:99,stderrBytes:2,retryCount:1,content:secrets.at(-1),invoiceNumber:secrets[4],buyer:secrets[5],seller:secrets[6],amount:secrets[7],token:secrets[8]});
  const parsed=JSON.parse(line);
  assert.equal(parsed.stage,"archive"); assert.equal(parsed.code,"copy_verification_failed");
  assert.match(parsed.correlation,/^[a-f0-9]{12}$/);
  assert.deepEqual(Object.keys(parsed).sort(),["code","correlation","durationMs","sizeBytes","stage","stderrBytes","time","retryCount"].sort());
  for (const secret of secrets) assert.equal(line.includes(secret),false);
});

test("router attachment summaries never include resource keys or Feishu identifiers",() => {
  const event={eventId:"event_secret",messageId:"message_secret",senderId:"sender_secret",chatId:"chat_secret",chatType:"p2p",messageType:"file",content:'<file name="发票.pdf" key="file_secret"/>',createTimeMs:1784426400000};
  const summary=JSON.stringify(createRouterMessage(createFeishuIncomingMessage(event)));
  for (const value of ["event_secret","message_secret","sender_secret","chat_secret","file_secret"]) assert.equal(summary.includes(value),false);
});
