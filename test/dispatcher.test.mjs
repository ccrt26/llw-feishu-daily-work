import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Dispatcher} from "../src/core/dispatcher.mjs";
import {StateStore} from "../src/state-store.mjs";

const raw={event_id:"e1",message_id:"m1",sender_id:"u1",chat_id:"c1",chat_type:"p2p",message_type:"image",content:"![Image](img_abc)",create_time:"1784426400000"};
const contract=name=>({capability:name,purpose:name==="invoice"?"归档发票":"记录工作",accepts:name==="invoice"?["image","file"]:["text"],positive_examples:["正例"],negative_examples:["反例"],supports_continuation:name==="daily-work"});

async function harness({decision,handle,status="committed",send}={}) {
  const dir=await mkdtemp(join(tmpdir(),"llw-dispatcher-")); const state=await StateStore.open(join(dir,"state.json"));
  const routerCalls=[],runs=[],sends=[];
  const capabilities=["daily-work","invoice"].map(name=>({name,routingContract:contract(name),handle:async event=>{runs.push(name);return handle?handle(name,event):{status,reply:status==="ignored"?null:`${name}完成`,artifacts:status==="committed"?["p"]:[]};}}));
  const intentRouter={decide:async input=>{routerCalls.push(structuredClone(input));return typeof decision==="function"?decision(input):decision||{action:"route",capability:"invoice",confidence:"high",reasonCode:"attachment_match"};}};
  const dispatcher=new Dispatcher({binding:{senderId:"u1",chatId:"c1"},state,capabilities,intentRouter,messenger:{send:send|| (async message=>sends.push(message))}});
  return {state,routerCalls,runs,sends,dispatcher};
}

test("routes once, invokes only the selected capability, persists before send and suppresses duplicates",async () => {
  const order=[]; const h=await harness({decision:{action:"route",capability:"invoice",confidence:"high",reasonCode:"attachment_match"},handle:async name=>{order.push(name);return {status:"committed",reply:"已归档",artifacts:["p"]};},send:async()=>order.push("send")});
  const original=h.state.saveOutcome.bind(h.state); h.state.saveOutcome=async(...args)=>{order.push("save");return original(...args);};
  await h.dispatcher.handleRawEvent(raw); await h.dispatcher.handleRawEvent(raw);
  assert.equal(h.routerCalls.length,1); assert.deepEqual(h.runs,["invoice"]); assert.deepEqual(order,["invoice","save","send"]);
});

test("security failures, empty text and duplicates never call the router",async () => {
  const h=await harness();
  await h.dispatcher.handleRawEvent({...raw,sender_id:"other"});
  await h.dispatcher.handleRawEvent({...raw,message_id:"m2",message_type:"text",content:"   "});
  assert.equal(h.routerCalls.length,0); assert.equal(h.sends.length,0);
});

test("one unclear turn asks once and a second unclear answer lists capabilities then closes",async () => {
  const h=await harness({decision:{action:"clarify",question:"你希望记录工作，还是处理发票？"}});
  await h.dispatcher.handleRawEvent({...raw,message_type:"text",content:"帮我处理一下"});
  assert.equal((await h.state.getRouterConversation()).attempts,1);
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

test("unsupported and router failure invoke no capability and send one safe reply",async () => {
  const unsupported=await harness({decision:{action:"unsupported",reason:"目前没有相应能力"}}); await unsupported.dispatcher.handleRawEvent(raw); assert.equal(unsupported.runs.length,0); assert.equal(unsupported.sends.length,1);
  const failed=await harness({decision:()=>{throw new Error("secret");}}); await failed.dispatcher.handleRawEvent(raw); assert.equal(failed.runs.length,0); assert.equal(failed.sends.length,1); assert.match(failed.sends[0].text,/暂时无法判断/);
});

test("send failure resumes the same reply without rerunning router or capability",async () => {
  let first=true; const sent=[]; const h=await harness({send:async message=>{if(first){first=false;throw new Error("network");}sent.push(message);}});
  await assert.rejects(()=>h.dispatcher.handleRawEvent(raw),/message_send_failed/); assert.equal(h.routerCalls.length,1); assert.equal(h.runs.length,1);
  await h.dispatcher.resumeReplies(); assert.equal(h.routerCalls.length,1); assert.equal(h.runs.length,1); assert.equal(sent.length,1);
});
