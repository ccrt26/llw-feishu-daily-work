import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const workspace="/Volumes/ZHUTONG/LLW的私人助手/LLW";

test("router Skill and business routing contracts expose one strict routing boundary",async () => {
  const [skill,schema,daily,invoice,ui]=await Promise.all([
    readFile(`${workspace}/.agents/skills/feishu-intent-router/SKILL.md`,"utf8"),
    readFile(`${workspace}/.agents/skills/feishu-intent-router/references/output-schema.json`,"utf8").then(JSON.parse),
    readFile(`${workspace}/.agents/skills/feishu-daily-work/references/routing-contract.json`,"utf8").then(JSON.parse),
    readFile(`${workspace}/.agents/skills/filing-invoices/references/routing-contract.json`,"utf8").then(JSON.parse),
    readFile(`${workspace}/.agents/skills/feishu-intent-router/agents/openai.yaml`,"utf8")
  ]);
  assert.match(skill,/^---\nname: feishu-intent-router\ndescription: Use when /);
  for (const phrase of ["只选择一个能力","不直接回复飞书","cancelled","reason_code"]) assert.match(skill,new RegExp(phrase));
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
});
