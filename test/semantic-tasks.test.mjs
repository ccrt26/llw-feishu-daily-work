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
