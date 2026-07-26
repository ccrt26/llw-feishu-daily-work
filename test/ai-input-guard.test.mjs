import test from "node:test";
import assert from "node:assert/strict";
import {guardAiInput} from "../src/ai/ai-input-guard.mjs";
import {ALLOWED_AI_INPUTS,FORBIDDEN_AI_INPUTS} from "./fixtures/forbidden-ai-inputs.mjs";

const routerInput=(text,capabilities=[{
  capability:"daily-work",purpose:"记录工作",accepts:["text"],
  positive_examples:["今天完成评审"],negative_examples:["解释评审"],supports_continuation:true
}])=>({message:{type:"text",text,beijingTime:"2026-07-23 09:30:00"},conversation:null,capabilities});

const dailyInput=(text,candidate={})=>({
  message:{text,createTime:1784426400000},
  conversation:{turns:[{role:"assistant",text:"请补充说明"}]},
  candidates:[{
    record_id:"90f29b02eb9ec9bb",date:"2026-07-22",occurred_time:"",occurred_end_time:"",
    title:"方案评审",people:[],location:"线上",summary:"完成方案评审。",follow_ups:[],...candidate
  }]
});

const knowledgeInput=text=>({
  request:"保存这份资料",
  source:{
    version:1,sourceKind:"text",detectedFormat:"text",displayName:"message.txt",
    sizeBytes:Buffer.byteLength(text),sha256:"a".repeat(64),
    jobSourceName:"source.txt",safeSourceReference:""
  },
  sourceContent:text,
  allowedLibraries:[{
    libraryKey:"work-knowledge",displayName:"工作资料",
    aliases:["工作文档"],
    existingFolders:[["亚信工作","交流方案"]]
  }],
  taskSummary:null
});

const assistantInput=text=>({
  message:{text,received_at:"2026-07-26T01:00:00.000Z"},
  session:{
    session_id:"123e4567-e89b-42d3-a456-426614174000",
    goal:"讨论合成方案",task_summary:"",confirmed_requirements:[],
    rejected_directions:[],source_paths:["工作资料/合成.md"],
    current_draft_version:0,recent_turns:[],
    grounding_mode:"hybrid",model:"codex"
  },
  currentDraft:null,baseVersion:0,
  sources:[{path:"工作资料/合成.md",excerpt:"普通合成资料",score:1}],
  allowedOutputFormats:[],verifiedArtifact:null,entrySupportsFileReply:false
});

function rejected(task,input) {
  try { guardAiInput(task,input); } catch (error) { return error; }
  assert.fail("expected ai_input_rejected");
}

test("allows bounded router and daily-work shapes plus V3.1 placeholders",()=>{
  assert.deepEqual(guardAiInput("router.text",routerInput("今天完成方案评审")),routerInput("今天完成方案评审"));
  assert.deepEqual(guardAiInput("daily-work.interpret",dailyInput("补充昨天的评审")),dailyInput("补充昨天的评审"));
  assert.equal(FORBIDDEN_AI_INPUTS.length+ALLOWED_AI_INPUTS.length,50);
  for (const value of ALLOWED_AI_INPUTS) {
    assert.deepEqual(guardAiInput("router.text",routerInput(value)),routerInput(value));
    assert.deepEqual(guardAiInput("daily-work.interpret",dailyInput(value)),dailyInput(value));
  }
  assert.deepEqual(guardAiInput("router.text",routerInput("记录工作",[{capability:"daily-work",purpose:"password: actual-password",accepts:["text"],positive_examples:["API Key: actual-api-key"],negative_examples:["验证码: 123456"],supports_continuation:true}])),routerInput("记录工作",[{capability:"daily-work",purpose:"password: actual-password",accepts:["text"],positive_examples:["API Key: actual-api-key"],negative_examples:["验证码: 123456"],supports_continuation:true}]));
  for (const value of ["API Key: <API_KEY>.","Authorization: Bearer <API_KEY>.","password: (MASKED)"]) {
    assert.deepEqual(guardAiInput("router.text",routerInput(value)),routerInput(value));
    assert.deepEqual(guardAiInput("daily-work.interpret",dailyInput(value)),dailyInput(value));
  }
});

test("rejects only explicit V3.1 credential and payment values without echoing them",()=>{
  assert.deepEqual([...new Set(FORBIDDEN_AI_INPUTS.map(item=>item.category))].sort(),["credential","payment"]);
  for (const {category,text} of FORBIDDEN_AI_INPUTS) for (const [task,input] of [["router.text",routerInput(text)],["daily-work.interpret",dailyInput(text)]]) {
    const error=rejected(task,input);
    assert.equal(error.message,"ai_input_rejected");
    assert.equal(error.reasonCode,category);
    assert.equal(String(error).includes(text),false);
  }
});

test("allows concepts, historical V3 classes, paths and ordinary payment information",()=>{
  for (const value of [
    "身份证正反面原图", "【绝密】项目资料", "请上传整个 Obsidian Vault", "请读取 /root/private-export.json",
    "USER=ordinary-environment-value", "ou_not_a_real_feishu_id", "支付二维码", "订单号：20260723", "银行卡余额 100 元", "有效期：2030-01"
  ]) {
    assert.deepEqual(guardAiInput("router.text",routerInput(value)),routerInput(value));
    assert.deepEqual(guardAiInput("daily-work.interpret",dailyInput(value)),dailyInput(value));
  }
});

test("scans only user-controlled daily text fields and not structural identifiers",()=>{
  assert.deepEqual(guardAiInput("daily-work.interpret",dailyInput("记录工作",{record_id:"4111111111111111"})),dailyInput("记录工作",{record_id:"4111111111111111"}));
  const conversation=dailyInput("记录工作"); conversation.conversation.turns[0].text="支付密码: actual-password";
  assert.equal(rejected("daily-work.interpret",conversation).reasonCode,"payment");
  for (const [field,value,reasonCode] of [
    ["title","API Key: actual-api-key","credential"],
    ["people",["password: actual-password"],"credential"],
    ["location","Authorization: Bearer actual-token","credential"],
    ["summary","CVV: 123","payment"],
    ["follow_ups",["支付密码: actual-password"],"payment"]
  ]) assert.equal(rejected("daily-work.interpret",dailyInput("记录工作",{[field]:value})).reasonCode,reasonCode);
});

test("keeps structural rejections free of a content reason code",()=>{
  const error=rejected("router.text",{...routerInput("x"),sender_id:"forbidden"});
  assert.equal(error.message,"ai_input_rejected");
  assert.equal(error.reasonCode,undefined);
  assert.throws(()=>guardAiInput("invoice.visual",routerInput("x")),/ai_input_rejected/);
  assert.throws(()=>guardAiInput("daily-work.interpret",{...dailyInput("x"),candidates:Array.from({length:21},()=>dailyInput("x").candidates[0])}),/ai_input_rejected/);
});

test("keeps the 32 KiB serialized boundary",()=>{
  assert.throws(()=>guardAiInput("router.text",routerInput("工".repeat(40_000))),/ai_input_rejected/);
});

test("allows only bounded AI-safe knowledge ingest context",()=>{
  const input=knowledgeInput("一份普通的交流方案说明。");
  assert.deepEqual(guardAiInput("knowledge.ingest",input),input);
  assert.throws(
    ()=>guardAiInput("knowledge.ingest",{...input,vaultRoot:"/private/vault"}),
    /ai_input_rejected/
  );
  assert.throws(
    ()=>guardAiInput("knowledge.ingest",{
      ...input,
      allowedLibraries:[{...input.allowedLibraries[0],existingFolders:[["../outside"]]}]
    }),
    /ai_input_rejected/
  );
});

test("scans knowledge content and safe catalog labels for prohibited values",()=>{
  const credential=knowledgeInput("API Key: actual-api-key");
  assert.equal(rejected("knowledge.ingest",credential).reasonCode,"credential");
  const payment=knowledgeInput("支付密码: actual-password");
  assert.equal(rejected("knowledge.ingest",payment).reasonCode,"payment");
  const catalog=knowledgeInput("普通内容");
  catalog.allowedLibraries[0].displayName="Authorization: Bearer actual-token";
  assert.equal(rejected("knowledge.ingest",catalog).reasonCode,"credential");
});

test("allows only bounded verified assistant-work context",()=>{
  const input=assistantInput("讨论合成方案");
  assert.deepEqual(guardAiInput("assistant.work",input),input);
  assert.throws(
    ()=>guardAiInput("assistant.work",{
      ...input,sources:[{path:"../outside.md",excerpt:"普通内容",score:1}]
    }),
    /ai_input_rejected/
  );
  assert.throws(
    ()=>guardAiInput("assistant.work",{
      ...input,vaultRoot:"/private/vault"
    }),
    /ai_input_rejected/
  );
});

test("scans assistant messages, drafts and source excerpts for prohibited values",()=>{
  assert.equal(
    rejected("assistant.work",assistantInput("API Key: actual-api-key")).reasonCode,
    "credential"
  );
  const draft=assistantInput("修改当前稿");
  draft.session.current_draft_version=1;
  draft.currentDraft={version:1,text:"支付密码: actual-password"};
  assert.equal(rejected("assistant.work",draft).reasonCode,"payment");
  const source=assistantInput("总结资料");
  source.sources[0].excerpt="Authorization: Bearer actual-token";
  assert.equal(rejected("assistant.work",source).reasonCode,"credential");
});
