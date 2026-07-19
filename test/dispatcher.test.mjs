import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dispatcher } from "../src/core/dispatcher.mjs";
import { StateStore } from "../src/state-store.mjs";

const raw = {
  event_id:"e1", message_id:"m1", sender_id:"u1", chat_id:"c1", chat_type:"p2p",
  message_type:"image", content:"![Image](img_abc)", create_time:"1784426400000"
};

async function harness({send, capability, state} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "llw-dispatcher-"));
  const actualState = state || await StateStore.open(join(dir, "state.json"));
  const sends = [];
  const runs = [];
  const actualCapability = capability || {
    name:"invoice",
    match:event => event.messageType === "image",
    handle:async () => {
      runs.push("handle");
      return {status:"committed", reply:"发票已归档", artifacts:["亚信工作/日常发票/餐饮发票/2026年07月/10.00.jpg"]};
    }
  };
  const messenger = {send:send || (async message => sends.push(message))};
  return {state:actualState, sends, runs, dispatcher:new Dispatcher({
    binding:{senderId:"u1", chatId:"c1"},
    state:actualState,
    capabilities:[actualCapability],
    messenger
  })};
}

test("persists outcome before sending and suppresses duplicate execution", async () => {
  const order = [];
  const dir = await mkdtemp(join(tmpdir(), "llw-dispatch-order-"));
  const state = await StateStore.open(join(dir, "state.json"));
  const originalSave = state.saveOutcome.bind(state);
  const originalMark = state.markReplied.bind(state);
  state.saveOutcome = async (...args) => { order.push("save"); return originalSave(...args); };
  state.markReplied = async (...args) => { order.push("mark"); return originalMark(...args); };
  const capability = {name:"invoice", match:() => true, handle:async () => {
    order.push("handle");
    return {status:"committed", reply:"发票已归档", artifacts:["p"]};
  }};
  const h = await harness({state, capability, send:async () => order.push("send")});
  await h.dispatcher.handleRawEvent(raw);
  await h.dispatcher.handleRawEvent(raw);
  assert.deepEqual(order, ["handle", "save", "send", "mark"]);
});

test("send failure leaves one unreplied outcome and resume does not rerun capability", async () => {
  let first = true;
  const sent = [];
  const h = await harness({send:async message => {
    if (first) { first = false; throw new Error("network_detail_must_not_escape"); }
    sent.push(message);
  }});
  await assert.rejects(() => h.dispatcher.handleRawEvent(raw), /message_send_failed/);
  assert.equal(h.runs.length, 1);
  assert.equal(h.state.unreplied().length, 1);
  await h.dispatcher.resumeReplies();
  assert.equal(h.runs.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].idempotencyKey, "invoice-reply:m1");
  assert.deepEqual(h.state.unreplied(), []);
});

test("another sender, another chat, and group events are silent", async () => {
  const h = await harness();
  for (const event of [
    {...raw, sender_id:"u2"},
    {...raw, chat_id:"c2"},
    {...raw, chat_type:"group"}
  ]) await h.dispatcher.handleRawEvent(event);
  assert.equal(h.runs.length, 0);
  assert.equal(h.sends.length, 0);
});

test("empty text is silently ignored before routing", async () => {
  const h = await harness({capability:{name:"daily-work", match:event => event.messageType === "text", handle:async () => { throw new Error("must_not_run"); }}});
  const result = await h.dispatcher.handleRawEvent({...raw, message_type:"text", content:"   "});
  assert.deepEqual(result, {handled:false, reason:"empty_text"});
  assert.equal(h.sends.length, 0);
});

test("bound malformed event gets one safe failure while unbound malformed event is silent", async () => {
  const h = await harness();
  await h.dispatcher.handleRawEvent({...raw, create_time:"bad"});
  await h.dispatcher.handleRawEvent({...raw, message_id:"m2", sender_id:"u2", create_time:"bad"});
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].text, "消息结构无效，本条未处理；请重新发送。");
  assert.equal(h.state.hasOutcome("m1"), true);
  assert.equal(h.state.hasOutcome("m2"), false);
});

test("route conflict persists a safe failure and invokes no capability", async () => {
  let runs = 0;
  const capability = name => ({name, match:() => true, handle:async () => { runs++; }});
  const dir = await mkdtemp(join(tmpdir(), "llw-route-conflict-"));
  const state = await StateStore.open(join(dir, "state.json"));
  const sends = [];
  const dispatcher = new Dispatcher({
    binding:{senderId:"u1",chatId:"c1"}, state,
    capabilities:[capability("invoice"),capability("other")],
    messenger:{send:async message => sends.push(message)}
  });
  await dispatcher.handleRawEvent(raw);
  assert.equal(runs, 0);
  assert.equal(sends[0].text, "消息路由配置冲突，本条未处理；请稍后重试。");
});
