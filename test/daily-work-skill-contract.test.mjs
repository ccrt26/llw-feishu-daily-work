import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {guardAiInput} from "../src/ai/ai-input-guard.mjs";

const skillRoot="/Volumes/ZHUTONG/LLW的私人助手/LLW/.agents/skills/feishu-daily-work";

function assertExpectedFieldsUseSchema(schema,value,path) {
  for (const [field,expected] of Object.entries(value)) {
    const property=schema.properties?.[field];
    assert.ok(property,`${path}.${field} is not a daily-work output schema field`);
    if (Array.isArray(expected)) for (const [index,item] of expected.entries()) assertExpectedFieldsUseSchema(property.items,item,`${path}.${field}[${index}]`);
    else if (expected&&typeof expected==="object") assertExpectedFieldsUseSchema(property,expected,`${path}.${field}`);
  }
}

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
    const allowedRootKeys=["expected","id","input","kind","task"];
    if (Object.hasOwn(item,"manual_review_criteria")) allowedRootKeys.push("manual_review_criteria");
    assert.deepEqual(Object.keys(item).sort(),allowedRootKeys.sort());
    assert.equal(item.task,"daily-work.interpret");
    assert.equal(typeof item.id,"string");
    assert.deepEqual(Object.keys(item.input).sort(),["candidates","conversation","message"]);
    assert.equal(typeof item.input?.message?.text,"string");
    assert.equal(Number.isFinite(item.input?.message?.createTime),true);
    assert.equal(Array.isArray(item.input?.candidates),true);
    assert.equal(item.input.candidates.length<=20,true);
    assert.doesNotThrow(()=>guardAiInput(item.task,item.input),`guard rejected ${item.id}`);
    for (const candidate of item.input.candidates) assert.deepEqual(Object.keys(candidate).sort(),[
      "date","follow_ups","location","occurred_end_time","occurred_time","people","record_id","summary","title"
    ]);
    assert.equal(typeof item.expected?.action,"string");
    assertExpectedFieldsUseSchema(schema,item.expected,`${item.id}.expected`);
  }
  const byId=new Map(cases.map(item=>[item.id,item]));
  const required={
    "daily-positive-unique-timed-supplement":{
      kind:"positive",
      expected:{action:"supplement_record",confidence:"high",target_record_id:"3333333333333333",records:[{occurred_date:"2026-07-22",occurred_time:"16:30",occurred_end_time:"17:30"}]}
    },
    "daily-boundary-target-outside-candidates":{
      kind:"boundary",
      expected:{action:"ask_user",target_record_id:""}
    },
    "daily-positive-multiturn-clarified-supplement":{
      kind:"positive",
      expected:{action:"supplement_record",confidence:"high",target_record_id:"5555555555555555",source_text:"是周二的订单评审会"},
      manual_review_criteria:[
        "每条 records[].original_text 必须来自上一轮真正包含补充事实的 user turn 的逐字连续片段。",
        "records[].original_text 不能使用当前仅用于定位目标的 source_text，也不能复制 candidates 中的旧记录内容。"
      ]
    },
    "daily-negative-active-cancel":{
      kind:"negative",
      expected:{action:"ignore"}
    },
    "daily-positive-beijing-yesterday":{
      kind:"positive",
      expected:{action:"create_record",confidence:"high",records:[{occurred_date:"2026-07-23"}]}
    },
    "daily-positive-explicit-date-precedence":{
      kind:"positive",
      expected:{action:"create_record",confidence:"high",records:[{occurred_date:"2026-07-21"}]}
    },
    "daily-positive-two-independent-records":{
      kind:"positive",
      expected:{action:"create_record",confidence:"high",records:[{occurred_date:"2026-07-24"},{occurred_date:"2026-07-24"}]}
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
    if (contract.manual_review_criteria) assert.deepEqual(item.manual_review_criteria,contract.manual_review_criteria);
    else assert.equal(Object.hasOwn(item,"manual_review_criteria"),false);
  }
  assert.equal(cases.length,12);
  assert.deepEqual(cases.filter(item=>Object.hasOwn(item,"manual_review_criteria")).map(item=>item.id),[
    "daily-positive-multiturn-clarified-supplement"
  ]);
  const timed=byId.get("daily-positive-unique-timed-supplement");
  assert.match(timed.input.message.text,/下午4点30.*下午5点30/);
  assert.equal(timed.input.candidates.length,1);
  assert.equal(timed.input.candidates[0].record_id,timed.expected.target_record_id);
  assert.equal(timed.input.candidates[0].date,timed.expected.records[0].occurred_date);
  const outside=byId.get("daily-boundary-target-outside-candidates");
  assert.match(outside.input.message.text,/供应商沟通会/);
  assert.equal(outside.input.candidates.some(item=>item.title==="供应商沟通会"),false);
  assert.equal(outside.expected.target_record_id,"");
  const multiturn=byId.get("daily-positive-multiturn-clarified-supplement");
  const priorFact=multiturn.input.conversation.turns.find(turn=>turn.role==="user");
  assert.ok(priorFact);
  assert.match(priorFact.text,/参会人员/);
  assert.equal(multiturn.input.message.text,multiturn.expected.source_text);
  assert.equal(multiturn.input.candidates.some(item=>item.record_id===multiturn.expected.target_record_id),true);
  const activeCancel=byId.get("daily-negative-active-cancel");
  assert.match(activeCancel.input.message.text,/取消/);
  assert.equal(activeCancel.input.conversation.turns.at(-1).role,"assistant");
  const yesterday=byId.get("daily-positive-beijing-yesterday");
  assert.match(yesterday.input.message.text,/昨天/);
  const beijingDate=new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"});
  assert.equal(beijingDate.format(new Date(yesterday.input.message.createTime)),"2026-07-24");
  assert.equal(yesterday.expected.records[0].occurred_date,"2026-07-23");
  const explicitDate=byId.get("daily-positive-explicit-date-precedence");
  assert.match(explicitDate.input.message.text,/7月21日/);
  assert.equal(beijingDate.format(new Date(explicitDate.input.message.createTime)),"2026-07-24");
  assert.equal(explicitDate.expected.records[0].occurred_date,"2026-07-21");
  assert.notEqual(explicitDate.expected.records[0].occurred_date,"2026-07-24");
  const twoRecords=byId.get("daily-positive-two-independent-records");
  assert.equal(twoRecords.input.message.text.split("；").length,2);
  assert.equal(twoRecords.expected.records.length,2);
  const knowledge=byId.get("daily-negative-knowledge-question");
  assert.match(knowledge.input.message.text,/什么是.*？/);
  assert.equal(knowledge.input.conversation,null);
  assert.deepEqual(knowledge.input.candidates,[]);
  const vague=byId.get("daily-boundary-vague-fact");
  assert.match(vague.input.message.text,/有些进展/);
  assert.equal(vague.expected.action,"ask_user");
});
