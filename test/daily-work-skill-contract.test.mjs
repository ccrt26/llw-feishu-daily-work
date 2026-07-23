import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const skillRoot="/Volumes/ZHUTONG/LLW的私人助手/LLW/.agents/skills/feishu-daily-work";

test("daily-work Skill exposes the complete V3 business contract and versioned evals",async () => {
  const [skill,schema,routing,evalText]=await Promise.all([
    readFile(`${skillRoot}/SKILL.md`,"utf8"),
    readFile(`${skillRoot}/references/output-schema.json`,"utf8").then(JSON.parse),
    readFile(`${skillRoot}/references/routing-contract.json`,"utf8").then(JSON.parse),
    readFile(`${skillRoot}/evals/cases.jsonl`,"utf8")
  ]);
  assert.match(skill,/^---\nname: feishu-daily-work\ndescription: Use when /);
  for (const section of [
    "1. 业务目标与不处理范围","2. 路由卡片","3. 输入要求","4. 输出 Schema 或明确格式",
    "5. 处理规则","6. 业务不变量","7. 数据、原文和落库规则","8. 模型支持",
    "9. 异常与安全失败","10. 示例和评测","11. 权限与禁止行为","12. 验收标准"
  ]) assert.equal(skill.includes(`## ${section}`),true);
  for (const marker of ["[AI]","[程序]","[确认]","daily-work.interpret","Codex","DeepSeek"]) assert.equal(skill.includes(marker),true);
  assert.deepEqual(routing.capability,"daily-work");
  assert.deepEqual(routing.accepts,["text"]);
  assert.deepEqual(schema.properties.action.enum,["create_record","supplement_record","ask_user","ignore"]);
  assert.equal(schema.additionalProperties,false);
  const cases=evalText.trim().split("\n").map(line=>JSON.parse(line));
  assert.equal(cases.length>=3,true);
  assert.deepEqual(new Set(cases.map(item=>item.kind)),new Set(["positive","negative","boundary"]));
  for (const item of cases) {
    assert.equal(item.task,"daily-work.interpret");
    assert.equal(typeof item.id,"string");
    assert.equal(typeof item.input?.message?.text,"string");
    assert.equal(Number.isFinite(item.input?.message?.createTime),true);
    assert.equal(typeof item.expected?.action,"string");
  }
});
