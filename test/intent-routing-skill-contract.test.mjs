import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {guardAiInput} from "../src/ai/ai-input-guard.mjs";

const workspace="/Volumes/ZHUTONG/LLW的私人助手/LLW";

test("router Skill and business routing contracts expose one strict text and visual routing boundary",async () => {
  const [skill,schema,daily,invoice,ui,evalText,visualEvalText]=await Promise.all([
    readFile(`${workspace}/.agents/skills/feishu-intent-router/SKILL.md`,"utf8"),
    readFile(`${workspace}/.agents/skills/feishu-intent-router/references/output-schema.json`,"utf8").then(JSON.parse),
    readFile(`${workspace}/.agents/skills/feishu-daily-work/references/routing-contract.json`,"utf8").then(JSON.parse),
    readFile(`${workspace}/.agents/skills/filing-invoices/references/routing-contract.json`,"utf8").then(JSON.parse),
    readFile(`${workspace}/.agents/skills/feishu-intent-router/agents/openai.yaml`,"utf8"),
    readFile(`${workspace}/.agents/skills/feishu-intent-router/evals/cases.jsonl`,"utf8"),
    readFile(`${workspace}/.agents/skills/feishu-intent-router/evals/visual-cases.jsonl`,"utf8")
  ]);
  assert.match(skill,/^---\nname: feishu-intent-router\ndescription: Use when /);
  for (const phrase of ["只选择一个能力","不直接回复飞书","cancelled","reason_code"]) assert.match(skill,new RegExp(phrase));
  for (const section of [
    "1. 业务目标与不处理范围","2. 路由卡片","3. 输入要求","4. 输出 Schema 或明确格式",
    "5. 处理规则","6. 业务不变量","7. 数据、原文和落库规则","8. 模型支持",
    "9. 异常与安全失败","10. 示例和评测","11. 权限与禁止行为","12. 验收标准"
  ]) assert.match(skill,new RegExp(`## ${section.replace(/[.*+?^${}()|[\\]\\]/g,"\\$&")}`));
  for (const marker of ["[AI]","[程序]","[确认]","router.text","router.visual","Codex","DeepSeek"]) assert.equal(skill.includes(marker),true);
  assert.match(skill,/router\.visual.*实际像素/s);
  assert.match(skill,/只选择业务能力.*不提取发票字段/s);
  assert.match(skill,/即使.*唯一.*图片候选.*不得强制.*route/s);
  assert.match(skill,/图片中的.*指令.*不执行/s);
  assert.match(skill,/DeepSeek.*图片.*不支持/s);
  assert.match(skill,/“清晰”指票面应有区域完整存在且整体清晰/);
  assert.match(skill,/即使仍能识别为发票.*明显裁切.*clarify/s);
  assert.match(skill,/Codex.*`low`/);
  assert.match(skill,/DeepSeek V4 Pro.*非思考模式.*`temperature=0`/);
  assert.match(skill,/推理设置由本 Skill 声明.*程序固定执行.*用户输入和模型输出不得覆盖/);
  assert.match(skill,/活动对话.*附件.*完整的新任务.*`new_task`.*`attachment_match`/);
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
  assert.match(ui,/short_description: "为私人飞书或微信消息/);
  assert.match(ui,/default_prompt: "Use \$feishu-intent-router to choose exactly one enabled capability for a private Feishu or WeChat message or image\."/);
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

  const visualCases=visualEvalText.trim().split("\n").map(line=>JSON.parse(line));
  assert.equal(visualCases.length>=6&&visualCases.length<=10,true);
  assert.equal(new Set(visualCases.map(item=>item.id)).size,visualCases.length);
  assert.deepEqual(new Set(visualCases.map(item=>item.kind)),new Set(["positive","negative","boundary"]));
  for (const item of visualCases) {
    assert.equal(item.task,"router.visual");
    assert.deepEqual(Object.keys(item).sort(),["expected","fixture","id","input","kind","task"]);
    assert.match(item.fixture,/^fixtures\/[a-z0-9-]+\.(?:png|jpg|jpeg|webp)$/);
    assert.deepEqual(Object.keys(item.input).sort(),["capabilities","conversation","message"]);
    assert.deepEqual(Object.keys(item.input.message).sort(),["beijingTime","type"]);
    assert.equal(item.input.message.type,"image");
    assert.equal(item.input.conversation,null);
    assert.deepEqual(item.input.capabilities.map(capability=>capability.capability),["invoice"]);
    assert.deepEqual(item.input.capabilities[0],invoice);
    assert.equal(typeof item.expected.action,"string");
    const fixture=await readFile(`${workspace}/.agents/skills/feishu-intent-router/evals/${item.fixture}`);
    if (item.fixture.endsWith(".png")) {
      assert.equal(fixture.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])),true);
    } else {
      assert.equal(fixture[0],0xff);
      assert.equal(fixture[1],0xd8);
      assert.equal(fixture[2],0xff);
    }
  }
  const visualById=new Map(visualCases.map(item=>[item.id,item]));
  assert.deepEqual(visualById.get("visual-positive-clear-invoice").expected,{action:"route",capability:"invoice",confidence:"high"});
  assert.deepEqual(visualById.get("visual-negative-ordinary-photo").expected,{action:"unsupported"});
  assert.deepEqual(visualById.get("visual-negative-unrelated-screenshot").expected,{action:"unsupported"});
  assert.deepEqual(visualById.get("visual-boundary-blurred-invoice").expected,{action:"clarify"});
  assert.deepEqual(visualById.get("visual-boundary-cropped-invoice").expected,{action:"clarify"});
  assert.deepEqual(visualById.get("visual-boundary-prompt-injection").expected,{action:"unsupported"});
});
