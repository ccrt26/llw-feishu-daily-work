import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const workspace="/Volumes/ZHUTONG/LLW的私人助手/LLW";

test("router Skill and business routing contracts expose one strict routing boundary",async () => {
  const [skill,schema,daily,invoice,ui,evalText]=await Promise.all([
    readFile(`${workspace}/.agents/skills/feishu-intent-router/SKILL.md`,"utf8"),
    readFile(`${workspace}/.agents/skills/feishu-intent-router/references/output-schema.json`,"utf8").then(JSON.parse),
    readFile(`${workspace}/.agents/skills/feishu-daily-work/references/routing-contract.json`,"utf8").then(JSON.parse),
    readFile(`${workspace}/.agents/skills/filing-invoices/references/routing-contract.json`,"utf8").then(JSON.parse),
    readFile(`${workspace}/.agents/skills/feishu-intent-router/agents/openai.yaml`,"utf8"),
    readFile(`${workspace}/.agents/skills/feishu-intent-router/evals/cases.jsonl`,"utf8")
  ]);
  assert.match(skill,/^---\nname: feishu-intent-router\ndescription: Use when /);
  for (const phrase of ["只选择一个能力","不直接回复飞书","cancelled","reason_code"]) assert.match(skill,new RegExp(phrase));
  for (const section of [
    "1. 业务目标与不处理范围","2. 路由卡片","3. 输入要求","4. 输出 Schema 或明确格式",
    "5. 处理规则","6. 业务不变量","7. 数据、原文和落库规则","8. 模型支持",
    "9. 异常与安全失败","10. 示例和评测","11. 权限与禁止行为","12. 验收标准"
  ]) assert.match(skill,new RegExp(`## ${section.replace(/[.*+?^${}()|[\\]\\]/g,"\\$&")}`));
  for (const marker of ["[AI]","[程序]","[确认]","router.text","Codex","DeepSeek"]) assert.equal(skill.includes(marker),true);
  assert.equal(schema.additionalProperties,false);
  assert.deepEqual(schema.required,["action","capability","confidence","reason_code","question","reason"]);
  assert.deepEqual(schema.properties.action.enum,["route","clarify","unsupported"]);
  assert.equal(Object.hasOwn(schema,"oneOf"),false);
  assert.deepEqual(daily.capability,"daily-work");
  assert.deepEqual(invoice.capability,"invoice");
  assert.equal(daily.accepts.includes("text"),true);
  assert.equal(invoice.accepts.includes("file"),true);
  assert.equal(invoice.accepts.includes("image"),true);
  for (const contract of [daily,invoice]) {
    assert.equal(contract.purpose.length>0,true);
    assert.equal(contract.positive_examples.length>0,true);
    assert.equal(contract.negative_examples.length>0,true);
    assert.equal(typeof contract.supports_continuation,"boolean");
  }
  assert.match(ui,/default_prompt: "Use \$feishu-intent-router /);
  const cases=evalText.trim().split("\n").map(line=>JSON.parse(line));
  assert.equal(cases.length>=3,true);
  assert.deepEqual(new Set(cases.map(item=>item.kind)),new Set(["positive","negative","boundary"]));
  for (const item of cases) {
    assert.equal(item.task,"router.text");
    assert.equal(typeof item.id,"string");
    assert.equal(typeof item.input?.message?.type,"string");
    assert.equal(typeof item.expected?.action,"string");
  }
});
