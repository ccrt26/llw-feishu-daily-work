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
  assert.deepEqual(new Set(cases.map(item=>item.kind)),new Set(["positive","negative","boundary"]));
  assert.equal(new Set(cases.map(item=>item.id)).size,cases.length);
  for (const item of cases) {
    assert.equal(item.task,"daily-work.interpret");
    assert.equal(typeof item.id,"string");
    assert.deepEqual(Object.keys(item.input).sort(),["candidates","conversation","message"]);
    assert.equal(typeof item.input?.message?.text,"string");
    assert.equal(Number.isFinite(item.input?.message?.createTime),true);
    assert.equal(Array.isArray(item.input?.candidates),true);
    assert.equal(item.input.candidates.length<=20,true);
    assert.equal(typeof item.expected?.action,"string");
  }
  const byId=new Map(cases.map(item=>[item.id,item]));
  const required={
    "daily-positive-unique-timed-supplement":{
      kind:"positive",
      expected:{action:"supplement_record",confidence:"high",target_record_id:"3333333333333333",occurred_date:"2026-07-22",occurred_time:"16:30",occurred_end_time:"17:30"}
    },
    "daily-boundary-target-outside-candidates":{
      kind:"boundary",
      expected:{action:"ask_user",target_record_id:""}
    },
    "daily-positive-multiturn-clarified-supplement":{
      kind:"positive",
      expected:{action:"supplement_record",confidence:"high",target_record_id:"5555555555555555",source_text:"是周二的订单评审会",original_text:"我补充一下，参会人员还有华东区销售"}
    },
    "daily-negative-active-cancel":{
      kind:"negative",
      expected:{action:"ignore"}
    },
    "daily-positive-beijing-yesterday":{
      kind:"positive",
      expected:{action:"create_record",confidence:"high",occurred_date:"2026-07-23"}
    },
    "daily-positive-explicit-date-precedence":{
      kind:"positive",
      expected:{action:"create_record",confidence:"high",occurred_date:"2026-07-21"}
    },
    "daily-positive-two-independent-records":{
      kind:"positive",
      expected:{action:"create_record",confidence:"high",records_count:2}
    },
    "daily-negative-knowledge-question":{
      kind:"negative",
      expected:{action:"ignore"}
    },
    "daily-boundary-vague-fact":{
      kind:"boundary",
      expected:{action:"ask_user"}
    }
  };
  for (const [id,contract] of Object.entries(required)) {
    const item=byId.get(id);
    assert.ok(item,`missing eval case ${id}`);
    assert.equal(item.task,"daily-work.interpret");
    assert.equal(item.kind,contract.kind);
    assert.deepEqual(item.expected,contract.expected);
  }
  assert.equal(cases.length>=12,true);
  assert.equal(byId.get("daily-positive-unique-timed-supplement").input.candidates.length,1);
  assert.equal(byId.get("daily-boundary-target-outside-candidates").input.candidates.some(item=>item.title==="供应商沟通会"),false);
  const multiturn=byId.get("daily-positive-multiturn-clarified-supplement");
  assert.equal(multiturn.input.conversation.turns.at(-2).text,multiturn.expected.original_text);
  assert.equal(multiturn.input.message.text,multiturn.expected.source_text);
  assert.equal(byId.get("daily-negative-active-cancel").input.conversation.turns.at(-1).role,"assistant");
});
