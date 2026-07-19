import test from "node:test";
import assert from "node:assert/strict";
import {safeLog} from "../src/core/redaction.mjs";

test("safe logs contain only allowlisted scalars and a one-way correlation",() => {
  const secrets=["om_secret","ou_secret","oc_secret","img_secret","123456789012","亚信科技（成都）有限公司","成都餐厅","290.00","token-secret","票面全文"];
  const line=safeLog({stage:"archive",code:"copy_verification_failed",messageId:secrets[0],durationMs:12,sizeBytes:99,stderrBytes:2,retryCount:1,content:secrets.at(-1),invoiceNumber:secrets[4],buyer:secrets[5],seller:secrets[6],amount:secrets[7],token:secrets[8]});
  const parsed=JSON.parse(line);
  assert.equal(parsed.stage,"archive"); assert.equal(parsed.code,"copy_verification_failed");
  assert.match(parsed.correlation,/^[a-f0-9]{12}$/);
  assert.deepEqual(Object.keys(parsed).sort(),["code","correlation","durationMs","sizeBytes","stage","stderrBytes","time","retryCount"].sort());
  for (const secret of secrets) assert.equal(line.includes(secret),false);
});
