import test from "node:test";
import assert from "node:assert/strict";
import {createRouterTextTask,createDailyWorkInterpretTask,createInvoiceVisualTask} from "../src/core/semantic-tasks.mjs";

test("exposes exactly the three named semantic task boundaries over existing clients",async () => {
  const calls=[];
  const invoke=async input=>{calls.push(structuredClone(input));return {ok:true};};
  const common={codexPath:"/runtime/codex",workspaceRoot:"/vault",skillRoot:"/skill",timeoutMs:321,invoke};
  const router=createRouterTextTask(common);
  const daily=createDailyWorkInterpretTask(common);
  const invoice=createInvoiceVisualTask(common);
  const routerInput={message:{type:"text",text:"记录工作",beijingTime:"2026-07-23 09:30:00"},conversation:null,capabilities:[]};
  const dailyInput={message:{text:"今天完成评审",createTime:1784426400000},conversation:null,candidates:[]};
  const invoiceInput={analysisInput:{detectedFormat:"png"}};
  await router(routerInput); await daily(dailyInput); await invoice(invoiceInput);
  assert.deepEqual(calls,[
    {codexPath:"/runtime/codex",workspaceRoot:"/vault",skillRoot:"/skill",timeoutMs:321,input:routerInput},
    {codexPath:"/runtime/codex",workspaceRoot:"/vault",skillRoot:"/skill",timeoutMs:321,...dailyInput},
    {codexPath:"/runtime/codex",workspaceRoot:"/vault",skillRoot:"/skill",timeoutMs:321,...invoiceInput}
  ]);
});

test("rejects missing task inputs before calling a semantic client",async () => {
  let calls=0; const invoke=async()=>{calls++;};
  const common={codexPath:"/runtime/codex",workspaceRoot:"/vault",skillRoot:"/skill",invoke};
  await assert.rejects(()=>createRouterTextTask(common)(),/invalid_router_text_input/);
  await assert.rejects(()=>createDailyWorkInterpretTask(common)(),/invalid_daily_work_interpret_input/);
  await assert.rejects(()=>createInvoiceVisualTask(common)(),/invalid_invoice_visual_input/);
  assert.equal(calls,0);
});

test("routes only the two text tasks to DeepSeek while leaving Codex and invoice behavior unchanged",async()=>{
  const codexCalls=[],deepseekCalls=[],invoiceCalls=[];
  const common={
    codexPath:"/runtime/codex",workspaceRoot:"/vault",skillRoot:"/skill",deepseekEnabled:true,
    deepseekModel:"deepseek-v4-pro",deepseekKeychainService:"com.llw.deepseek-api",deepseekKeychainAccount:"llw-assistant",
    invoke:async input=>{codexCalls.push(structuredClone(input));return {provider:"codex"};},
    invokeDeepSeekClient:async input=>{deepseekCalls.push(structuredClone(input));return {provider:"deepseek"};}
  };
  const router=createRouterTextTask(common);
  const daily=createDailyWorkInterpretTask(common);
  const invoice=createInvoiceVisualTask({codexPath:"/runtime/codex",workspaceRoot:"/vault",skillRoot:"/skill",invoke:async input=>{invoiceCalls.push(structuredClone(input));return {provider:"codex-invoice"};}});
  const routerInput={model:"deepseek",message:{type:"text",text:"记录工作",beijingTime:"2026-07-23 09:30:00"},conversation:null,capabilities:[]};
  const dailyInput={model:"deepseek",message:{text:"今天完成评审",createTime:1784426400000},conversation:null,candidates:[]};
  assert.equal((await router(routerInput)).provider,"deepseek");
  assert.equal((await daily(dailyInput)).provider,"deepseek");
  assert.equal(deepseekCalls[0].task,"router.text"); assert.equal(deepseekCalls[1].task,"daily-work.interpret");
  assert.equal(Object.hasOwn(deepseekCalls[0].input,"model"),false); assert.equal(Object.hasOwn(deepseekCalls[1].input,"model"),false);
  assert.equal((await router({...routerInput,model:"codex"})).provider,"codex");
  assert.equal((await daily({...dailyInput,model:"codex"})).provider,"codex");
  assert.equal((await invoice({analysisInput:{detectedFormat:"png"}})).provider,"codex-invoice");
  assert.equal(codexCalls.length,2); assert.equal(invoiceCalls.length,1);
});

test("disabled DeepSeek fails closed without calling either client",async()=>{
  let codexCalls=0,deepseekCalls=0;
  const router=createRouterTextTask({invoke:async()=>{codexCalls++;},invokeDeepSeekClient:async()=>{deepseekCalls++;},deepseekEnabled:false});
  await assert.rejects(()=>router({model:"deepseek",message:{type:"text",text:"记录工作",beijingTime:"2026-07-23 09:30:00"},conversation:null,capabilities:[]}),/deepseek_disabled/);
  assert.equal(codexCalls,0); assert.equal(deepseekCalls,0);
});

test("a common guard rejects prohibited router and daily text before either AI client",async()=>{
  let codexCalls=0,deepseekCalls=0;
  const configuration={
    invoke:async()=>{codexCalls++;},invokeDeepSeekClient:async()=>{deepseekCalls++;},deepseekEnabled:true,
    deepseekModel:"deepseek-v4-pro",deepseekKeychainService:"com.llw.deepseek-api",deepseekKeychainAccount:"llw-assistant"
  };
  const router=createRouterTextTask(configuration),daily=createDailyWorkInterpretTask(configuration);
  const forbidden=["我的密码是 hunter2","短信验证码是 123456","银行卡是 4111 1111 1111 1111","绝密项目资料"];
  for (const model of ["codex","deepseek"]) for (const text of forbidden) {
    await assert.rejects(()=>router({model,message:{type:"text",text,beijingTime:"2026-07-23 09:30:00"},conversation:null,capabilities:[]}),error=>error.message==="ai_input_rejected");
    await assert.rejects(()=>daily({model,message:{text,createTime:1784426400000},conversation:null,candidates:[]}),error=>error.message==="ai_input_rejected");
  }
  assert.equal(codexCalls,0); assert.equal(deepseekCalls,0);
});

test("Codex text tasks preserve existing behavior for allowed text",async()=>{
  const calls=[];
  const configuration={invoke:async input=>{calls.push(structuredClone(input));return {provider:"codex"};}};
  const router=createRouterTextTask(configuration),daily=createDailyWorkInterpretTask(configuration);
  assert.equal((await router({model:"codex",message:{type:"text",text:"查看 https://example.com/a",beijingTime:"2026-07-23 09:30:00"},conversation:null,capabilities:[]})).provider,"codex");
  assert.equal((await daily({model:"codex",message:{text:"今天完成评审",createTime:1784426400000},conversation:null,candidates:[]})).provider,"codex");
  assert.equal(calls.length,2);
});

test("a DeepSeek client failure never invokes the Codex client",async()=>{
  let codexCalls=0,deepseekCalls=0;
  const router=createRouterTextTask({
    invoke:async()=>{codexCalls++;},invokeDeepSeekClient:async()=>{deepseekCalls++;throw new Error("deepseek_timeout");},
    deepseekEnabled:true,deepseekModel:"deepseek-v4-flash",deepseekKeychainService:"com.llw.deepseek-api",deepseekKeychainAccount:"llw-assistant"
  });
  await assert.rejects(()=>router({model:"deepseek",message:{type:"text",text:"记录工作",beijingTime:"2026-07-23 09:30:00"},conversation:null,capabilities:[]}),/deepseek_timeout/);
  assert.equal(deepseekCalls,1); assert.equal(codexCalls,0);
});
