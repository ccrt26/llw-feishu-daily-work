import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {guardAiInput} from "../src/ai/ai-input-guard.mjs";

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
  const canonicalContracts=new Map([[daily.capability,daily],[invoice.capability,invoice]]);
  assert.deepEqual(new Set(cases.map(item=>item.kind)),new Set(["positive","negative","boundary"]));
  assert.equal(new Set(cases.map(item=>item.id)).size,cases.length);
  for (const item of cases) {
    const allowedRootKeys=["expected","id","input","kind","task"];
    if (Object.hasOwn(item,"manual_review_criteria")) allowedRootKeys.push("manual_review_criteria");
    assert.deepEqual(Object.keys(item).sort(),allowedRootKeys.sort());
    assert.equal(item.task,"router.text");
    assert.equal(typeof item.id,"string");
    assert.deepEqual(Object.keys(item.input).sort(),["capabilities","conversation","message"]);
    assert.equal(typeof item.input?.message?.type,"string");
    assert.equal(Array.isArray(item.input?.capabilities),true);
    assert.equal(item.input.capabilities.length>0&&item.input.capabilities.length<=20,true);
    assert.doesNotThrow(()=>guardAiInput(item.task,item.input),`guard rejected ${item.id}`);
    for (const capability of item.input.capabilities) assert.deepEqual(Object.keys(capability).sort(),[
      "accepts","capability","negative_examples","positive_examples","purpose","supports_continuation"
    ]);
    for (const capability of item.input.capabilities) assert.deepEqual(
      capability,canonicalContracts.get(capability.capability),`${item.id} must use the canonical ${capability.capability} routing contract`
    );
    assert.equal(typeof item.expected?.action,"string");
  }
  const byId=new Map(cases.map(item=>[item.id,item]));
  const required={
    "router-positive-invoice-attachment":{
      kind:"positive",
      expected:{action:"route",capability:"invoice",confidence:"high",reason_code:"attachment_match"}
    },
    "router-negative-invoice-knowledge-question":{
      kind:"negative",
      expected:{action:"unsupported"}
    },
    "router-positive-daily-work-continuation":{
      kind:"positive",
      expected:{action:"route",capability:"daily-work",confidence:"high",reason_code:"continuation"}
    },
    "router-boundary-active-cancel":{
      kind:"boundary",
      expected:{action:"unsupported",reason:"cancelled"}
    },
    "router-negative-cancel-without-conversation":{
      kind:"negative",
      expected:{action:"unsupported"},
      manual_review_criteria:["模型输出的 reason 不得为 cancelled；没有活动会话时不能产生静默取消哨兵。"]
    },
    "router-boundary-invoice-new-task":{
      kind:"boundary",
      expected:{action:"route",capability:"invoice",confidence:"high",reason_code:"new_task"}
    },
    "router-negative-disabled-daily-work":{
      kind:"negative",
      expected:{action:"unsupported"}
    }
  };
  for (const [id,contract] of Object.entries(required)) {
    const item=byId.get(id);
    assert.ok(item,`missing eval case ${id}`);
    assert.equal(item.task,"router.text");
    assert.equal(item.kind,contract.kind);
    assert.deepEqual(item.expected,contract.expected);
    if (contract.manual_review_criteria) assert.deepEqual(item.manual_review_criteria,contract.manual_review_criteria);
    else assert.equal(Object.hasOwn(item,"manual_review_criteria"),false);
  }
  assert.equal(cases.length,10);
  assert.deepEqual(cases.filter(item=>Object.hasOwn(item,"manual_review_criteria")).map(item=>item.id),[
    "router-negative-cancel-without-conversation"
  ]);
  assert.deepEqual(byId.get("router-positive-invoice-attachment").input.message,{
    type:"file",attachment:{displayName:"电子发票.pdf",extension:"pdf",resourceType:"file"},beijingTime:"2026-07-23 10:00:00"
  });
  const knowledge=byId.get("router-negative-invoice-knowledge-question");
  assert.equal(knowledge.input.message.type,"text");
  assert.match(knowledge.input.message.text,/发票.*区别/);
  assert.equal(Object.hasOwn(knowledge.input.message,"attachment"),false);
  const continuation=byId.get("router-positive-daily-work-continuation");
  assert.equal(continuation.input.message.text,"16:30开始，17:30结束");
  assert.match(continuation.input.conversation.question,/具体时间/);
  assert.equal(continuation.input.conversation.capability,"daily-work");
  assert.equal(continuation.input.capabilities.find(item=>item.capability==="daily-work").supports_continuation,true);
  const activeCancel=byId.get("router-boundary-active-cancel");
  assert.match(activeCancel.input.message.text,/取消/);
  assert.equal(activeCancel.input.conversation.capability,"daily-work");
  const inactiveCancel=byId.get("router-negative-cancel-without-conversation");
  assert.match(inactiveCancel.input.message.text,/取消/);
  assert.equal(inactiveCancel.input.conversation,null);
  const newTask=byId.get("router-boundary-invoice-new-task");
  assert.equal(newTask.input.conversation.capability,"daily-work");
  assert.equal(newTask.input.message.type,"file");
  assert.deepEqual(newTask.input.message.attachment,{displayName:"差旅电子发票.pdf",extension:"pdf",resourceType:"file"});
  const disabledDaily=byId.get("router-negative-disabled-daily-work");
  assert.match(disabledDaily.input.message.text,/测试环境巡检/);
  assert.deepEqual(disabledDaily.input.capabilities.map(item=>item.capability),["invoice"]);
});
