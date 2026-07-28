import test from "node:test";
import assert from "node:assert/strict";
import {
  SourceBurstCollector
} from "../src/personal-assistant/source-burst-collector.mjs";

function message(id,{
  source="feishu",userId="owner",conversationId="private",
  instructionText="",attachments=[]
}={}) {
  return {
    source,sourceMessageId:id,userId,conversationId,
    receivedAt:"2026-07-28T00:00:00.000Z",
    instructionText,attachments,
    replyTarget:{source,sourceMessageId:id,conversationId}
  };
}

function file(id,extension="docx") {
  return {
    type:"file",sourceAttachmentId:`resource-${id}`,
    displayName:`${id}.${extension}`,extension
  };
}

function harness() {
  const clock=new FakeClock(),ready=[];
  const collector=new SourceBurstCollector({
    quietMs:3000,maxMs:15000,maxSources:8,
    now:()=>clock.now,
    setTimer:(callback,delay)=>clock.setTimer(callback,delay),
    clearTimer:id=>clock.clearTimer(id),
    onReady:value=>ready.push(value)
  });
  return {clock,ready,collector};
}

test("coalesces text then DOCX then PDF after the quiet deadline",() => {
  const {clock,ready,collector}=harness();
  collector.accept(message("text",{instructionText:"比较并总结"}));
  clock.advance(1000);
  collector.accept(message("docx",{attachments:[file("a")]}));
  clock.advance(1000);
  collector.accept(message("pdf",{attachments:[file("b","pdf")]}));
  clock.advance(2999);
  assert.equal(ready.length,0);
  clock.advance(1);
  assert.equal(ready.length,1);
  assert.equal(ready[0].message.sourceMessageId,"text");
  assert.equal(ready[0].message.instructionText,"比较并总结");
  assert.deepEqual(
    ready[0].message.attachments.map(value=>value.displayName),
    ["a.docx","b.pdf"]
  );
  assert.deepEqual(
    ready[0].aliases.map(value=>value.sourceMessageId),
    ["docx","pdf"]
  );
  assert.equal(ready[0].message.replyTarget.sourceMessageId,"pdf");
});

test("holds a fragmented WeChat multi-file upload until the hard window",() => {
  const clock=new FakeClock(),ready=[];
  const collector=new SourceBurstCollector({
    quietMs:3000,attachmentQuietMs:15000,maxMs:15000,maxSources:8,
    now:()=>clock.now,
    setTimer:(callback,delay)=>clock.setTimer(callback,delay),
    clearTimer:id=>clock.clearTimer(id),
    onReady:value=>ready.push(value)
  });
  collector.accept(message("text",{
    source:"wechat",userId:"wx",conversationId:"wx",
    instructionText:"把这三份材料保存到日常生活"
  }));
  clock.advance(2000);
  collector.accept(message("pdf",{
    source:"wechat",userId:"wx",conversationId:"wx",
    attachments:[file("c","pdf")]
  }));
  clock.advance(4000);
  assert.equal(ready.length,0);
  collector.accept(message("docx-b",{
    source:"wechat",userId:"wx",conversationId:"wx",
    attachments:[file("b")]
  }));
  clock.advance(4000);
  assert.equal(ready.length,0);
  collector.accept(message("docx-a",{
    source:"wechat",userId:"wx",conversationId:"wx",
    attachments:[file("a")]
  }));
  clock.advance(4999);
  assert.equal(ready.length,0);
  clock.advance(1);
  assert.equal(ready.length,1);
  assert.equal(ready[0].message.instructionText,
    "把这三份材料保存到日常生活");
  assert.deepEqual(
    ready[0].message.attachments.map(value=>value.displayName),
    ["c.pdf","b.docx","a.docx"]
  );
});

test("coalesces DOCX then PDF then text and accepts three same-event files",() => {
  const {clock,ready,collector}=harness();
  collector.accept(message("docx",{attachments:[file("a")]}));
  collector.accept(message("pdf",{attachments:[file("b","pdf")]}));
  collector.accept(message("text",{instructionText:"统一整理"}));
  clock.advance(3000);
  assert.equal(ready.length,1);
  assert.equal(ready[0].message.sourceMessageId,"docx");
  assert.equal(ready[0].message.instructionText,"统一整理");
  assert.equal(ready[0].message.attachments.length,2);

  collector.accept(message("same",{
    instructionText:"比较",
    attachments:[file("c"),file("d","pdf"),file("e","xlsx")]
  }));
  clock.advance(3000);
  assert.equal(ready[1].message.attachments.length,3);
  assert.deepEqual(ready[1].aliases,[]);
});

test("never coalesces across entry, user or conversation",() => {
  const {clock,ready,collector}=harness();
  collector.accept(message("a",{instructionText:"A"}));
  collector.accept(message("b",{
    source:"wechat",userId:"wx",conversationId:"wx",instructionText:"B"
  }));
  collector.accept(message("c",{userId:"other",instructionText:"C"}));
  collector.accept(message("d",{conversationId:"other",instructionText:"D"}));
  clock.advance(3000);
  assert.equal(ready.length,4);
  assert.deepEqual(
    ready.map(value=>value.message.sourceMessageId).sort(),
    ["a","b","c","d"]
  );
});

test("starts a new turn for a source arriving after the hard deadline",() => {
  const {clock,ready,collector}=harness();
  collector.accept(message("first",{attachments:[file("a")]}));
  for (let index=1;index<5;index+=1) {
    clock.advance(2900);
    collector.accept(message(`keep-${index}`,{instructionText:`补充 ${index}`}));
  }
  clock.advance(3400);
  assert.equal(clock.now,15000);
  assert.equal(ready.length,1);
  collector.accept(message("late",{attachments:[file("late","pdf")]}));
  clock.advance(3000);
  assert.equal(ready.length,2);
  assert.equal(ready[1].message.sourceMessageId,"late");
});

test("deduplicates events, cancels pending state and rejects a ninth source",() => {
  const {clock,ready,collector}=harness();
  const first=message("first",{attachments:[file("a")]});
  collector.accept(first);
  collector.accept(structuredClone(first));
  clock.advance(3000);
  assert.equal(ready[0].message.attachments.length,1);
  assert.deepEqual(ready[0].aliases,[]);

  collector.accept(message("eight",{
    attachments:Array.from({length:8},(_,index)=>file(`f-${index}`))
  }));
  const rejected=collector.accept(message("ninth",{
    attachments:[file("ninth")]
  }));
  assert.equal(rejected.status,"rejected");
  assert.equal(rejected.reason,"too_many_sources");
  const cancelled=collector.cancel(message("cancel"));
  assert.equal(cancelled.messages.length,1);
  clock.advance(3000);
  assert.equal(ready.length,1);
});

class FakeClock {
  constructor() {
    this.now=0;
    this.nextId=1;
    this.timers=new Map();
  }
  setTimer(callback,delay) {
    const id=this.nextId++;
    this.timers.set(id,{at:this.now+delay,callback});
    return id;
  }
  clearTimer(id) {
    this.timers.delete(id);
  }
  advance(milliseconds) {
    const target=this.now+milliseconds;
    while (true) {
      const next=[...this.timers.entries()]
        .filter(([,timer])=>timer.at<=target)
        .sort((left,right)=>left[1].at-right[1].at||left[0]-right[0])[0];
      if (!next) break;
      const [id,timer]=next;
      this.timers.delete(id);
      this.now=timer.at;
      timer.callback();
    }
    this.now=target;
  }
}
