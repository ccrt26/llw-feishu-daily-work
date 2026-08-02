import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  PersonalAssistantCoordinator
} from "../src/personal-assistant/coordinator.mjs";
import {
  PersonalAssistantTaskSessionManager
} from "../src/personal-assistant/task-session-manager.mjs";
import {StateStore} from "../src/state-store.mjs";

test("uses one 600-second no-source-read call for a verified DOCX turn",async()=>{
  const h=await harness();
  let calls=0;
  const coordinator=createCoordinator(h,{
    sources:[docxSource()],
    docxReader:docxReader({status:"complete"}),
    assistant:{async decide(_context,options){
      calls+=1;
      assert.equal(options.timeoutMs,600_000);
      assert.equal(options.allowSourceRead,false);
      return {kind:"reply",text:"总结完成"};
    }}
  });
  try {
    const result=await runOne(h,coordinator);
    assert.equal(result.outcome.reply,"总结完成");
    assert.equal(calls,1);
  } finally { await rm(h.root,{recursive:true,force:true}); }
});

test("keeps one DOCX call when ordinary document sources are mixed in",async()=>{
  const h=await harness();
  let calls=0;
  const coordinator=createCoordinator(h,{
    sources:[docxSource(),plainSource("source-002","pptx")],
    docxReader:docxReader({status:"complete"}),
    assistant:{async decide(context,options){
      calls+=1;
      assert.deepEqual(context.sources.map(item=>item.format),["docx","pptx"]);
      assert.equal(options.timeoutMs,600_000);
      return {kind:"reply",text:"混合材料完成"};
    }}
  });
  try {
    await runOne(h,coordinator);
    assert.equal(calls,1);
  } finally { await rm(h.root,{recursive:true,force:true}); }
});

test("rejects DOCX plus public video before readers, AI, or Writer",async()=>{
  const h=await harness();
  const calls={docx:0,video:0,assistant:0,writer:0};
  const coordinator=createCoordinator(h,{
    sources:[docxSource(),publicVideoSource("source-002")],
    docxReader:{async prepare(){calls.docx+=1;}},
    publicVideoReader:{async prepare(){calls.video+=1;}},
    assistant:{async decide(){calls.assistant+=1;}},
    writer:{async commit(){calls.writer+=1;}}
  });
  try {
    const result=await runOne(h,coordinator);
    assert.equal(result.outcome.status,"rejected");
    assert.match(result.outcome.reply,/分成两个任务/u);
    assert.deepEqual(calls,{docx:0,video:0,assistant:0,writer:0});
  } finally { await rm(h.root,{recursive:true,force:true}); }
});

test("does not enter a second provider call when a DOCX result asks for source read",async()=>{
  const h=await harness();
  let assistantCalls=0,readerCalls=0,writerCalls=0;
  const coordinator=createCoordinator(h,{
    sources:[docxSource()],
    docxReader:docxReader({status:"complete"}),
    sourceReader:{async read(){readerCalls+=1;}},
    assistant:{async decide(){
      assistantCalls+=1;
      return {
        kind:"source_read",
        requests:[{
          sourceId:"source-001",view:"inspect_time_range",
          startMs:0,endMs:1_000
        }]
      };
    }},
    writer:{async commit(){writerCalls+=1;}}
  });
  try {
    const result=await runOne(h,coordinator);
    assert.match(result.outcome.reply,/没有执行保存/u);
    assert.equal(assistantCalls,1);
    assert.equal(readerCalls,0);
    assert.equal(writerCalls,0);
  } finally { await rm(h.root,{recursive:true,force:true}); }
});

test("sends one current-task progress message at five minutes without an Outcome",async()=>{
  const h=await harness();
  const started=deferred(),release=deferred(),sent=[];
  let scheduled=null,cleared=0;
  const coordinator=createCoordinator(h,{
    sources:[docxSource()],
    docxReader:docxReader({status:"complete"}),
    setTimer(fn,delay){scheduled={fn,delay};return "timer";},
    clearTimer(id){assert.equal(id,"timer");cleared+=1;},
    messenger:{async send(value){sent.push(structuredClone(value));}},
    assistant:{async decide(){
      started.resolve();
      await release.promise;
      return {kind:"reply",text:"最终完成"};
    }}
  });
  try {
    await h.manager.accept(taskMessage());
    const snapshot=await h.manager.claim("feishu");
    const running=coordinator.handleTask(snapshot);
    await started.promise;
    assert.equal(scheduled.delay,300_000);
    await scheduled.fn();
    await scheduled.fn();
    assert.equal(sent.length,1);
    assert.equal(
      sent[0].idempotencyKey,
      `docx-progress:${snapshot.taskId}:${snapshot.revision}`
    );
    assert.equal(h.state.getOutcome("feishu:m1"),null);
    release.resolve();
    const result=await running;
    assert.equal(result.outcome.reply,"最终完成");
    assert.equal(sent.length,2);
    assert.equal(cleared,1);
  } finally {
    release.resolve();
    await rm(h.root,{recursive:true,force:true});
  }
});

test("ignores a DOCX progress-send failure and still sends the final Outcome",async()=>{
  const h=await harness();
  const started=deferred(),release=deferred(),sent=[];
  let timer;
  const coordinator=createCoordinator(h,{
    sources:[docxSource()],docxReader:docxReader({status:"complete"}),
    setTimer(fn){timer=fn;return 1;},clearTimer(){},
    messenger:{async send(value){
      if (value.idempotencyKey.startsWith("docx-progress:")) {
        throw new Error("progress_failed");
      }
      sent.push(value);
    }},
    assistant:{async decide(){
      started.resolve();await release.promise;
      return {kind:"reply",text:"最终仍成功"};
    }}
  });
  try {
    await h.manager.accept(taskMessage());
    const running=coordinator.handleTask(await h.manager.claim("feishu"));
    await started.promise;
    await timer();
    release.resolve();
    assert.equal((await running).outcome.reply,"最终仍成功");
    assert.equal(sent.length,1);
  } finally {
    release.resolve();
    await rm(h.root,{recursive:true,force:true});
  }
});

for (const [name,coverage] of [
  ["partial",coverageValue({status:"partial",limitations:["chart"]})],
  ["missing",null],
  ["stale",coverageValue({originalSha256:"f".repeat(64)})]
]) {
  test(`blocks selected ${name} DOCX coverage before Writer reservation`,async()=>{
    const h=await harness();
    let reservations=0,writerCalls=0;
    const guarded=Object.create(h.manager);
    guarded.reserveWriter=async()=>{reservations+=1;return false;};
    const coordinator=createCoordinator(h,{
      taskManager:guarded,sources:[docxSource()],
      docxReader:docxReader({coverage}),
      assistant:{async decide(){return saveDecision({
        sourceIds:["source-001"],evidenceSourceIds:["source-001"]
      });}},
      writer:{async commit(){writerCalls+=1;}}
    });
    try {
      const result=await runOne(h,coordinator);
      assert.match(result.outcome.reply,/没有调用 Writer/u);
      assert.equal(reservations,0);
      assert.equal(writerCalls,0);
    } finally { await rm(h.root,{recursive:true,force:true}); }
  });
}

test("does not let an unselected partial DOCX block another selected source",async()=>{
  const h=await harness();
  let reservations=0;
  const guarded=Object.create(h.manager);
  guarded.reserveWriter=async()=>{reservations+=1;return false;};
  const coordinator=createCoordinator(h,{
    taskManager:guarded,
    sources:[docxSource(),plainSource("source-002","txt")],
    docxReader:docxReader({status:"partial",limitations:["chart"]}),
    assistant:{async decide(){return saveDecision({
      sourceIds:["source-002"],evidenceSourceIds:["source-002"]
    });}}
  });
  try {
    assert.deepEqual(await runOne(h,coordinator),{status:"stale"});
    assert.equal(reservations,1);
  } finally { await rm(h.root,{recursive:true,force:true}); }
});

test("allows a limitation-aware direct reply from a partial DOCX",async()=>{
  const h=await harness();
  const coordinator=createCoordinator(h,{
    sources:[docxSource()],
    docxReader:docxReader({status:"partial",limitations:["chart"]}),
    assistant:{async decide(){return {
      kind:"reply",text:"正文已总结；图表内容未完整读取。"
    };}}
  });
  try {
    const result=await runOne(h,coordinator);
    assert.match(result.outcome.reply,/图表内容未完整/u);
  } finally { await rm(h.root,{recursive:true,force:true}); }
});

async function harness() {
  const root=await mkdtemp(join(tmpdir(),"llw-coordinator-docx-"));
  const state=await StateStore.open(join(root,"state.json"));
  const manager=new PersonalAssistantTaskSessionManager({
    state,
    bindings:{
      feishu:{userId:"owner",conversationId:"c1"},
      wechat:{userId:"wx-owner",conversationId:"wx-owner"}
    },
    selectModel:async()=>"codex",createId:()=>"T".repeat(43),
    now:()=>Date.parse("2026-08-02T01:00:00.000Z")
  });
  return {root,state,manager};
}

function createCoordinator(h,overrides={}) {
  const sources=overrides.sources??[];
  return new PersonalAssistantCoordinator({
    assistant:overrides.assistant,
    writer:overrides.writer??{},dailyWriter:{},invoiceWriter:{},
    documentWorkspace:{
      async generate(){throw new Error("must_not_generate");},
      async verifyPublished(){return true;}
    },
    artifactGenerator:async()=>{},
    outcomeStore:{
      get:key=>h.state.getOutcome(key),markReplied:key=>h.state.markReplied(key)
    },
    messenger:overrides.messenger??{async send(){}},
    personalRules:[],skillVersion:"4.4.5",
    sourceReader:overrides.sourceReader??null,
    pdfReader:overrides.pdfReader??null,
    docxReader:overrides.docxReader??null,
    publicVideoReader:overrides.publicVideoReader??null,
    taskManager:overrides.taskManager??h.manager,
    taskWorkspace:{
      async ensure(){return {workspaceDir:"/private/task",sources};},
      async load(){return {workspaceDir:"/private/task",sources};}
    },
    setTimer:overrides.setTimer,
    clearTimer:overrides.clearTimer
  });
}

async function runOne(h,coordinator) {
  await h.manager.accept(taskMessage());
  return coordinator.handleTask(await h.manager.claim("feishu"));
}

function docxReader({
  status="complete",limitations=[],coverage=undefined
}={}) {
  const resolved=coverage===undefined
    ?coverageValue({status,limitations})
    :coverage;
  return {async prepare(){return {
    observations:[],modelImageFiles:[],
    coverageBySource:resolved?{"source-001":resolved}:{}
  };}};
}

function coverageValue(overrides={}) {
  return {
    sourceId:"source-001",originalSha256:"a".repeat(64),
    indexRelativePath:"source-001.docx-index.json",
    indexSha256:"b".repeat(64),status:"complete",limitations:[],
    ...overrides
  };
}

function docxSource() {
  return {
    handle:{
      sourceId:"source-001",displayName:"材料.docx",mediaClass:"document",
      format:"docx",relativePath:"source-001.docx",byteSize:100,
      sha256:"a".repeat(64),availability:"ready"
    },
    absolutePath:"/private/task/source-001.docx",archiveExtension:"docx"
  };
}

function plainSource(sourceId,format) {
  return {
    handle:{
      sourceId,displayName:`材料.${format}`,mediaClass:"document",format,
      relativePath:`${sourceId}.${format}`,byteSize:100,
      sha256:"c".repeat(64),availability:"ready"
    },
    absolutePath:`/private/task/${sourceId}.${format}`,archiveExtension:format
  };
}

function publicVideoSource(sourceId) {
  return {
    handle:{
      sourceId,displayName:"公开视频.mp4",mediaClass:"video",format:"mp4",
      relativePath:`${sourceId}.mp4`,byteSize:100,sha256:"d".repeat(64),
      availability:"ready",durationMs:20_000,
      representationIndexPath:`${sourceId}.manifest.json`,limitations:[]
    },absolutePath:`/private/task/${sourceId}.mp4`,archiveExtension:"mp4"
  };
}

function saveDecision({sourceIds,evidenceSourceIds}) {
  return {kind:"tool",toolCall:{name:"save_knowledge",arguments:{
    libraryKey:"personal-knowledge",folderSegments:[],title:"资料",
    summary:"摘要",tags:[],sourceIds,evidenceSourceIds,
    knowledgeSections:{
      keyFacts:["事实"],structureAndMainContent:"正文内容足够长。",
      reusableContent:[],sourceNotes:"来源说明",contentIndex:"内容索引足够长。"
    }
  }}};
}

function taskMessage() {
  return {
    source:"feishu",sourceMessageId:"m1",userId:"owner",conversationId:"c1",
    receivedAt:"2026-08-02T01:00:00.000Z",instructionText:"阅读总结并入库",
    attachments:[],replyTarget:{
      source:"feishu",sourceMessageId:"m1",conversationId:"c1"
    }
  };
}

function deferred() {
  let resolve;
  const promise=new Promise(done=>{resolve=done;});
  return {promise,resolve};
}
