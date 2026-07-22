import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const skillRoot="/Volumes/ZHUTONG/LLW的私人助手/LLW/.agents/skills/filing-invoices";

test("invoice Skill is the explicit source for PDF document verification semantics",async () => {
  const [skill,schema,evalText]=await Promise.all([
    readFile(`${skillRoot}/SKILL.md`,"utf8"),
    readFile(`${skillRoot}/references/output-schema.json`,"utf8").then(JSON.parse),
    readFile(`${skillRoot}/evals/cases.jsonl`,"utf8")
  ]);
  for (const section of [
    "1. 业务目标与不处理范围","2. 路由卡片","3. 输入要求","4. 输出 Schema 或明确格式",
    "5. 处理规则","6. 业务不变量","7. 数据、原文和落库规则","8. 模型支持",
    "9. 异常与安全失败","10. 示例和评测","11. 权限与禁止行为","12. 验收标准"
  ]) assert.equal(skill.includes(`## ${section}`),true);
  for (const marker of ["[AI]","[程序]","[确认]","invoice.visual","Codex","DeepSeek"]) assert.equal(skill.includes(marker),true);
  for (const value of ["single_invoice","multiple_invoices","conflicting_fields","unclear"]) assert.match(skill,new RegExp(`\\b${value}\\b`));
  assert.match(skill,/只有.*single_invoice.*归档/s);
  assert.match(skill,/(?:多张发票|两张或更多独立发票).*拆分/s);
  assert.match(skill,/跨页.*冲突.*不得归档/s);
  assert.match(skill,/原始 PDF.*归档/s);
  assert.deepEqual(schema.properties.document_verification.enum,["single_invoice","multiple_invoices","conflicting_fields","unclear"]);
  assert.equal(schema.properties.invoice.properties.file_format.enum.includes("pdf"),true);
  const cases=evalText.trim().split("\n").map(line=>JSON.parse(line));
  assert.equal(cases.length>=3,true);
  assert.deepEqual(new Set(cases.map(item=>item.kind)),new Set(["positive","negative","boundary"]));
  for (const item of cases) {
    assert.equal(item.task,"invoice.visual");
    assert.equal(typeof item.id,"string");
    assert.equal(typeof item.input?.document?.format,"string");
    assert.equal(typeof item.expected?.action,"string");
  }
});
