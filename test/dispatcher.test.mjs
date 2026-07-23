import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Dispatcher} from "../src/core/dispatcher.mjs";
import {StateStore} from "../src/state-store.mjs";
import {DailyWorkService} from "../src/service.mjs";
import {createRouterTextTask} from "../src/core/semantic-tasks.mjs";

const raw={event_id:"e1",message_id:"m1",sender_id:"u1",chat_id:"c1",chat_type:"p2p",message_type:"image",content:"![Image](img_abc)",create_time:"1784426400000"};
const contract=name=>({capability:name,purpose:name==="invoice"?"归档发票":"记录工作",accepts:name==="invoice"?["image","file"]:["text"],positive_examples:["正例"],negative_examples:["反例"],supports_continuation:name==="daily-work"});
const SENSITIVE_REPLY="检测到本任务包含不允许发送给 AI 的身份凭证或密钥信息。\n系统未调用 Codex 或 DeepSeek，也未保存该敏感内容。\n请删除或遮盖敏感字段后重新提交。";
const CODEX_FAILURE_REPLY="当前模型 Codex 本次调用失败。\n系统没有切换模型，也没有执行写入。\n如需使用 DeepSeek，请手工发送：/llw-model deepseek";
const DEEPSEEK_FAILURE_REPLY="当前模型 DeepSeek 本次调用失败。\n系统没有切换模型，也没有执行写入。\n如需使用 Codex，请手工发送：/llw-model codex";

async function harness({decision,handle:capabilityHandler,status="committed",send,model="codex",deepseekEnabled=true,modelMode:providedModelMode}={}) {
  const dir=await mkdtemp(join(tmpdir(),"llw-dispatcher-")); const file=join(dir,"state.json"); const state=await StateStore.open(file);
  const routerCalls=[],runs=[],messages=[],contexts=[],sends=[];
  const capabilities=["daily-work","invoice"].map(name=>({name,routingContract:contract(name),handle:async (message,context)=>{runs.push(name);messages.push(structuredClone(message));contexts.push({model:context.model});return capabilityHandler?capabilityHandler(name,message,context):{status,reply:status==="ignored"?null:`${name}完成`,artifacts:status==="committed"?["p"]:[]};}}));
  const intentRouter={decide:async input=>{routerCalls.push(structuredClone(input));return typeof decision==="function"?decision(input):decision||{action:"route",capability:"invoice",confidence:"high",reasonCode:"attachment_match"};}};
  const modes=[],writes=[]; let selected=model;
  const modelMode=providedModelMode||{read:async()=>{modes.push(selected);return selected;},write:async value=>{writes.push(value);selected=value;}};
  const dispatcher=new Dispatcher({binding:{senderId:"u1",chatId:"c1"},state,capabilities,intentRouter,messenger:{send:send|| (async message=>sends.push(message))},modelMode,deepseekEnabled});
  return {file,state,routerCalls,runs,messages,contexts,sends,modes,writes,dispatcher};
}

test("routes once, invokes only the selected capability, persists before send and suppresses duplicates",async () => {
  const order=[]; const h=await harness({decision:{action:"route",capability:"invoice",confidence:"high",reasonCode:"attachment_match"},handle:async name=>{order.push(name);return {status:"committed",reply:"已归档",artifacts:["p"]};},send:async()=>order.push("send")});
  const original=h.state.saveOutcome.bind(h.state); h.state.saveOutcome=async(...args)=>{order.push("save");return original(...args);};
  await h.dispatcher.handleRawEvent(raw); await h.dispatcher.handleRawEvent(raw);
  assert.equal(h.routerCalls.length,1); assert.deepEqual(h.runs,["invoice"]); assert.deepEqual(order,["invoice","save","send"]);
  assert.deepEqual(h.messages[0],{
    source:"feishu",sourceMessageId:"m1",userId:"u1",conversationId:"c1",receivedAt:"2026-07-19T02:00:00.000Z",
    attachments:[{type:"image",sourceAttachmentId:"img_abc",displayName:"飞书图片",extension:""}],
    replyTarget:{source:"feishu",sourceMessageId:"m1",conversationId:"c1"}
  });
  for (const field of ["message_id","sender_id","chat_id","message_type","content","messageId","senderId","chatId","messageType","createTimeMs"]) assert.equal(Object.hasOwn(h.messages[0],field),false);
});

test("security failures, empty text and duplicates never call the router",async () => {
  const h=await harness();
  await h.dispatcher.handleRawEvent({...raw,sender_id:"other"});
  await h.dispatcher.handleRawEvent({...raw,message_id:"m2",message_type:"text",content:"   "});
  assert.equal(h.routerCalls.length,0); assert.equal(h.sends.length,0);
});

test("model commands run after security and idempotency but before the router",async () => {
  const h=await harness();
  await h.dispatcher.handleRawEvent({...raw,message_type:"text",content:"/llw-model status"});
  await h.dispatcher.handleRawEvent({...raw,message_id:"m2",sender_id:"other",message_type:"text",content:"/llw-model deepseek"});
  assert.equal(h.routerCalls.length,0); assert.deepEqual(h.runs,[]); assert.equal(h.sends[0].text,"当前模型：Codex\n切换方式：手工");
  assert.deepEqual(h.modes,["codex"]);
  assert.deepEqual(h.writes,[]);
});

test("each new task snapshots its model once before routing",async () => {
  const h=await harness({model:"deepseek"});
  await h.dispatcher.handleRawEvent({...raw,message_type:"text",content:"记录今天工作"});
  assert.deepEqual(h.modes,["deepseek"]);
  assert.equal(h.routerCalls[0].model,"deepseek");
});

test("disabled DeepSeek makes persisted DeepSeek state effectively Codex",async () => {
  const h=await harness({model:"deepseek",deepseekEnabled:false});
  await h.dispatcher.handleRawEvent({...raw,message_type:"text",content:"/llw-model status"});
  await h.dispatcher.handleRawEvent({...raw,message_id:"m2",message_type:"text",content:"记录今天工作"});
  assert.equal(h.sends[0].text,"当前模型：Codex\n切换方式：手工");
  assert.deepEqual(h.contexts.map(context=>context.model),["codex"]);
  assert.equal(h.routerCalls[0].model,"codex");
  assert.deepEqual(h.modes,["deepseek","deepseek"]);
});

test("DeepSeek invoice is rejected before capability work without switching models",async()=>{
  const h=await harness({model:"deepseek",decision:{action:"route",capability:"invoice",confidence:"high",reasonCode:"attachment_match"}});
  const result=await h.dispatcher.handleRawEvent(raw);
  assert.equal(result.status,"rejected"); assert.deepEqual(h.routerCalls,[]); assert.deepEqual(h.runs,[]); assert.deepEqual(h.writes,[]); assert.deepEqual(h.modes,["deepseek"]);
  assert.equal(h.sends.length,1);
  assert.equal(h.sends[0].text,"当前模型为 DeepSeek，但发票图片/PDF需要 Codex 视觉判断。\n本次未调用模型、未归档文件、未写入 Obsidian。\n请先发送：/llw-model codex\n然后重新提交发票。");
});

test("attachment new tasks use the current global model instead of an active conversation snapshot",async()=>{
  const reject=await harness({model:"deepseek",decision:{action:"route",capability:"invoice",confidence:"high",reasonCode:"new_task"}});
  await reject.state.setRouterConversation({capability:"daily-work",question:"请补充",startedAt:new Date(Number(raw.create_time)).toISOString(),attempts:1,status:"open",model:"codex"});
  assert.equal((await reject.dispatcher.handleRawEvent(raw)).status,"rejected");
  assert.deepEqual(reject.routerCalls,[]); assert.deepEqual(reject.runs,[]); assert.deepEqual(reject.modes,["deepseek"]);

  const allow=await harness({model:"codex",decision:{action:"route",capability:"invoice",confidence:"high",reasonCode:"new_task"}});
  await allow.state.setRouterConversation({capability:"daily-work",question:"请补充",startedAt:new Date(Number(raw.create_time)).toISOString(),attempts:1,status:"open",model:"deepseek"});
  assert.equal((await allow.dispatcher.handleRawEvent(raw)).status,"committed");
  assert.equal(allow.routerCalls[0].model,"codex"); assert.deepEqual(allow.runs,["invoice"]); assert.deepEqual(allow.contexts,[{model:"codex"}]); assert.deepEqual(allow.modes,["codex"]);
});

test("malformed attachments keep existing validation behavior in DeepSeek mode",async()=>{
  const h=await harness({model:"deepseek"});
  const result=await h.dispatcher.handleRawEvent({...raw,content:"not-a-resource-marker"});
  assert.equal(result.status,"failed"); assert.equal(h.routerCalls.length,0); assert.equal(h.runs.length,0); assert.match(h.sends[0].text,/暂时无法判断/); assert.doesNotMatch(h.sends[0].text,/发票图片/);
});

test("model commands are ignored for non-text events",async () => {
  const h=await harness();
  const result=await h.dispatcher.handleRawEvent({...raw,content:"/llw-model deepseek"});
  assert.equal(result.status,"failed"); assert.equal(h.routerCalls.length,0); assert.deepEqual(h.writes,[]); assert.deepEqual(h.modes,[]);
});

test("a switch changes the model snapshot of the next new task only",async () => {
  const h=await harness();
  await h.dispatcher.handleRawEvent({...raw,message_type:"text",content:"记录第一项工作"});
  await h.dispatcher.handleRawEvent({...raw,message_id:"m2",message_type:"text",content:"/llw-model deepseek"});
  await h.dispatcher.handleRawEvent({...raw,message_id:"m3",message_type:"text",content:"记录第二项工作"});
  assert.deepEqual(h.writes,["deepseek"]);
  assert.deepEqual(h.modes,["codex","deepseek"]);
  assert.deepEqual(h.contexts.map(context=>context.model),["codex","deepseek"]);
});

test("an open router task retains its captured model until a genuinely new task",async () => {
  const h=await harness({
    decision:input=>input.message.text==="新任务"?{action:"route",capability:"daily-work",confidence:"high",reasonCode:"new_task"}:{action:"route",capability:"daily-work",confidence:"high",reasonCode:"continuation"},
    handle:async (_name,message)=>message.sourceMessageId==="m4"?{status:"committed",reply:"完成",artifacts:["p"]}:{status:"awaiting_clarification",reply:"请补充细节",artifacts:[]}
  });
  await h.dispatcher.handleRawEvent({...raw,message_type:"text",content:"开始任务"});
  assert.equal((await h.state.getRouterConversation(Number(raw.create_time))).model,"codex");
  await h.dispatcher.handleRawEvent({...raw,message_id:"m2",message_type:"text",content:"/llw-model deepseek"});
  await h.dispatcher.handleRawEvent({...raw,message_id:"m3",message_type:"text",content:"继续任务"});
  await h.dispatcher.handleRawEvent({...raw,message_id:"m4",message_type:"text",content:"新任务"});
  assert.deepEqual(h.contexts.map(context=>context.model),["codex","codex","deepseek"]);
});

test("an active continuation never rereads global model state",async () => {
  let reads=0;
  const h=await harness({
    modelMode:{read:async()=>{reads++;throw new Error("must_not_read");},write:async()=>{}},
    decision:{action:"route",capability:"daily-work",confidence:"high",reasonCode:"continuation"}
  });
  await h.state.setRouterConversation({capability:"daily-work",question:"请补充",startedAt:new Date(Number(raw.create_time)).toISOString(),attempts:1,status:"open",model:"codex"});
  await h.dispatcher.handleRawEvent({...raw,message_type:"text",content:"继续任务"});
  assert.equal(reads,0); assert.deepEqual(h.contexts.map(context=>context.model),["codex"]);
});

test("disabled DeepSeek gates persisted router and daily snapshots without rereading global state",async () => {
  let reads=0;
  const modelMode={read:async()=>{reads++;throw new Error("must_not_read");},write:async()=>{}};
  const decision={action:"route",capability:"daily-work",confidence:"high",reasonCode:"continuation"};
  const router=await harness({modelMode,deepseekEnabled:false,decision});
  await router.state.setRouterConversation({capability:"daily-work",question:"请补充",startedAt:new Date(Number(raw.create_time)).toISOString(),attempts:1,status:"open",model:"deepseek"});
  router.dispatcher.state=await StateStore.open(router.file);
  await router.dispatcher.handleRawEvent({...raw,message_type:"text",content:"继续任务"});
  const daily=await harness({modelMode,deepseekEnabled:false,decision});
  await daily.state.setConversation({id:"c1",status:"open",turns:[{role:"user",text:"开始",createTime:1}],candidateIds:[],model:"deepseek"});
  daily.dispatcher.state=await StateStore.open(daily.file);
  await daily.dispatcher.handleRawEvent({...raw,message_type:"text",content:"继续任务"});
  assert.equal(reads,0); assert.deepEqual(router.contexts.map(context=>context.model),["codex"]); assert.deepEqual(daily.contexts.map(context=>context.model),["codex"]);
});

test("one unclear turn asks once and a second unclear answer lists capabilities then closes",async () => {
  const h=await harness({decision:{action:"clarify",question:"你希望记录工作，还是处理发票？"}});
  await h.dispatcher.handleRawEvent({...raw,message_type:"text",content:"帮我处理一下"});
  assert.equal((await h.state.getRouterConversation(Number(raw.create_time))).attempts,1);
  await h.dispatcher.handleRawEvent({...raw,message_id:"m2",message_type:"text",content:"就是这个"});
  assert.equal(await h.state.getRouterConversation(),null); assert.equal(h.runs.length,0); assert.equal(h.sends.length,2); assert.match(h.sends[1].text,/daily-work/); assert.match(h.sends[1].text,/invoice/);
});

test("explicit cancellation becomes a silent idempotent outcome",async () => {
  const h=await harness({decision:{action:"unsupported",reason:"cancelled"}});
  await h.state.setRouterConversation({capability:"daily-work",question:"补充哪一场？",startedAt:new Date(raw.create_time*1).toISOString(),attempts:1,status:"open"});
  const result=await h.dispatcher.handleRawEvent({...raw,message_type:"text",content:"不用了"});
  assert.equal(result.status,"ignored"); assert.equal(h.runs.length,0); assert.equal(h.sends.length,0); assert.deepEqual(h.state.unreplied(),[]);
});

test("business ignored is silent and not_applicable asks once without trying another capability",async () => {
  const ignored=await harness({status:"ignored"}); await ignored.dispatcher.handleRawEvent(raw); assert.equal(ignored.sends.length,0); assert.deepEqual(ignored.runs,["invoice"]);
  const no=await harness({handle:async()=>({status:"not_applicable",reply:null,artifacts:[]})}); await no.dispatcher.handleRawEvent(raw); assert.deepEqual(no.runs,["invoice"]); assert.equal(no.sends.length,1); assert.match(no.sends[0].text,/无法确定/);
});

test("unsupported and model-specific router failures invoke no capability and send classified safe replies",async () => {
  const unsupported=await harness({decision:{action:"unsupported",reason:"目前没有相应能力"}}); await unsupported.dispatcher.handleRawEvent(raw); assert.equal(unsupported.runs.length,0); assert.equal(unsupported.sends.length,1);
  for (const [model,reply] of [["codex",CODEX_FAILURE_REPLY],["deepseek",DEEPSEEK_FAILURE_REPLY]]) {
    const failed=await harness({model,decision:()=>{throw new Error("secret");}}); await failed.dispatcher.handleRawEvent({...raw,message_type:"text",content:"记录工作"});
    assert.equal(failed.runs.length,0); assert.equal(failed.sends.length,1); assert.equal(failed.sends[0].text,reply); assert.deepEqual(failed.writes,[]); assert.deepEqual(failed.modes,[model]);
  }
});

test("router input rejection uses the V3 sensitive-data reply for both models with zero AI follow-up or model write",async()=>{
  for (const model of ["codex","deepseek"]) {
    let aiCalls=0;
    const guardedRouter=createRouterTextTask({invoke:async()=>{aiCalls++;},invokeDeepSeekClient:async()=>{aiCalls++;},deepseekEnabled:true});
    const h=await harness({model,decision:input=>guardedRouter(input)});
    const result=await h.dispatcher.handleRawEvent({...raw,message_type:"text",content:"我的密码是 hunter2"});
    assert.equal(result.status,"rejected"); assert.deepEqual(h.runs,[]); assert.deepEqual(h.writes,[]); assert.deepEqual(h.modes,[model]);
    assert.equal(h.routerCalls.length,1); assert.equal(aiCalls,0); assert.equal(h.sends.length,1); assert.equal(h.sends[0].text,SENSITIVE_REPLY);
  }
});

test("DeepSeek daily-work transport and Schema failures write neither business data nor model state",async t=>{
  for (const errorCode of ["deepseek_timeout","deepseek_output_invalid"]) await t.test(errorCode,async()=>{
    let service,businessWrites=0,decisions=0;
    const h=await harness({
      model:"deepseek",decision:{action:"route",capability:"daily-work",confidence:"high",reasonCode:"direct_match"},
      handle:(_name,message,context)=>service.handleMessage(message,context)
    });
    service=new DailyWorkService({
      state:h.state,catalog:{list:async()=>[]},
      decide:async input=>{decisions++;assert.equal(input.model,"deepseek");throw new Error(errorCode);},
      writer:{create:async()=>{businessWrites++;},supplement:async()=>{businessWrites++;}}
    });
    const result=await h.dispatcher.handleRawEvent({...raw,message_type:"text",content:"今天完成评审"});
    assert.equal(result.status,"failed"); assert.equal(decisions,1); assert.equal(businessWrites,0); assert.deepEqual(h.writes,[]); assert.deepEqual(h.modes,["deepseek"]); assert.equal(h.state.getConversation(),null);
    assert.equal(h.sends[0].text,DEEPSEEK_FAILURE_REPLY);
  });
});

test("send failure resumes the same reply without rerunning router or capability",async () => {
  let first=true; const sent=[]; const h=await harness({send:async message=>{if(first){first=false;throw new Error("network");}sent.push(message);}});
  await assert.rejects(()=>h.dispatcher.handleRawEvent(raw),/message_send_failed/); assert.equal(h.routerCalls.length,1); assert.equal(h.runs.length,1);
  await h.dispatcher.resumeReplies(); assert.equal(h.routerCalls.length,1); assert.equal(h.runs.length,1); assert.equal(sent.length,1);
});
