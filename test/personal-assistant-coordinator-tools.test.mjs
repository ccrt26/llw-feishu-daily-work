import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {PersonalAssistantCoordinator} from "../src/personal-assistant/coordinator.mjs";
import {
  PersonalAssistantTaskSessionManager
} from "../src/personal-assistant/task-session-manager.mjs";
import {StateStore} from "../src/state-store.mjs";

const base={
  source:"feishu",sourceMessageId:"m1",
  receivedAt:"2026-07-28T00:00:00.000Z",
  instructionText:"生成 Word",attachments:[],
  replyTarget:{source:"feishu",sourceMessageId:"m1",conversationId:"c1"}
};

test("dispatches create_document through its one registered executor",async()=>{
  let generated=0,saved=0;
  const coordinator=new PersonalAssistantCoordinator({
    prepareSource:async()=>({
      workspaceDir:"/private/tmp/llw-turn-document-test",
      sources:[],cleanup:async()=>{}
    }),
    assistant:{async decide(){return {kind:"tool",toolCall:{
      name:"create_document",arguments:{
        sourceIds:[],format:"docx",title:"交流方案",content:"正文"
      }
    }};}},
    writer:{},dailyWriter:{},invoiceWriter:{},
    documentWorkspace:{async generate(){
      generated+=1;
      return {
        kind:"docx",path:"/private/output/交流方案.docx",
        displayName:"交流方案.docx",mime:"application/docx",
        sha256:"a".repeat(64),size:100
      };
    },async verifyPublished(){return true;}},
    artifactGenerator:async()=>{},
    outcomeStore:{async get(){return null;},async save(){saved+=1;}},
    messenger:{async send(){}},personalRules:[],model:"codex",skillVersion:"4.0.1"
  });
  const result=await coordinator.handle(base);
  assert.equal(generated,1);
  assert.equal(saved,1);
  assert.equal(result.replyFile.kind,"docx");
});

test("labels an unknown post-decision failure with its bounded phase",async()=>{
  const coordinator=new PersonalAssistantCoordinator({
    prepareSource:async()=>({
      workspaceDir:"/private/tmp/llw-turn-stage-test",
      sources:[],cleanup:async()=>{}
    }),
    assistant:{async decide(){return {kind:"reply",text:"只读回答"};}},
    writer:{},dailyWriter:{},invoiceWriter:{},
    outcomeStore:{async get(){return null;},async save(){}},
    messenger:{async send(){}},
    conversationStore:{
      async get(){return null;},
      async clear(){throw new Error("private_state_detail");}
    },
    personalRules:[],model:"codex",skillVersion:"4.0.1"
  });
  await assert.rejects(
    coordinator.handle({...base,instructionText:"只读回答"}),
    error=>error.message==="private_state_detail"&&
      error.failurePhase==="conversation_state_failed"
  );
});

test("labels an unknown model-selection failure before source preparation",async()=>{
  const coordinator=new PersonalAssistantCoordinator({
    prepareSource:async()=>{throw new Error("must_not_prepare");},
    assistant:{async decide(){throw new Error("must_not_decide");}},
    writer:{},dailyWriter:{},invoiceWriter:{},
    outcomeStore:{async get(){return null;},async save(){}},
    messenger:{async send(){}},
    conversationStore:{async get(){return null;}},
    selectModel:async()=>{throw new Error("private_model_state_detail");},
    personalRules:[],model:"codex",skillVersion:"4.0.1"
  });
  await assert.rejects(
    coordinator.handle(base),
    error=>error.message==="private_model_state_detail"&&
      error.failurePhase==="model_selection_failed"
  );
});

test("rejects a Feishu cloud-document source in DeepSeek mode before export or AI",async()=>{
  let prepares=0,assistantCalls=0,saves=0,sends=0;
  const coordinator=new PersonalAssistantCoordinator({
    prepareSource:async()=>{
      prepares+=1;
      return {
        instructionText:"总结[飞书文档快照]",
        workspaceDir:"/private/tmp/must-not-prepare",
        sources:[],cleanup:async()=>{}
      };
    },
    assistant:{async decide(){
      assistantCalls+=1;
      return {kind:"reply",text:"must not decide"};
    }},
    writer:{},dailyWriter:{},invoiceWriter:{},
    outcomeStore:{
      async get(){return null;},
      async save(){saves+=1;}
    },
    messenger:{async send(){sends+=1;}},
    selectModel:async()=>"deepseek",
    personalRules:[],model:"codex",skillVersion:"4.0.1"
  });
  const result=await coordinator.handle({
    ...base,sourceMessageId:"cloud-deepseek",
    instructionText:
      "总结https://example.feishu.cn/docx/synthetic_token",
    replyTarget:{
      source:"feishu",sourceMessageId:"cloud-deepseek",conversationId:"c1"
    }
  });
  assert.equal(result.status,"rejected");
  assert.match(result.reply,/附件任务请先切换为 Codex/u);
  assert.equal(prepares,0);
  assert.equal(assistantCalls,0);
  assert.equal(saves,1);
  assert.equal(sends,1);
});

test("drops an AI reply when a supplement changes the task revision",async()=>{
  const h=await taskHarness();
  const started=deferred(),release=deferred(),sent=[];
  const coordinator=createTaskCoordinator(h,{
    assistant:{async decide(){
      started.resolve();
      await release.promise;
      return {kind:"reply",text:"旧答案"};
    }},
    messenger:{async send(value){sent.push(value);}}
  });
  try {
    await h.manager.accept(taskMessage());
    const snapshot=await h.manager.claim("feishu");
    const running=coordinator.handleTask(snapshot);
    await started.promise;
    await h.manager.accept(taskMessage({
      id:"m2",
      text:"补充：重点分析风险",
      receivedAt:"2026-07-28T00:01:00.000Z"
    }));
    release.resolve();

    assert.deepEqual(await running,{status:"stale"});
    assert.equal(sent.length,0);
    assert.equal(h.state.getOutcome("feishu:m1"),null);
  } finally {
    release.resolve();
    await rm(h.root,{recursive:true,force:true});
  }
});

test("blocks a Writer when a supplement arrives at its reservation gate",async()=>{
  const h=await taskHarness();
  const atReservation=deferred(),releaseReservation=deferred();
  let generated=0;
  const guardedManager=Object.create(h.manager);
  guardedManager.reserveWriter=async request=>{
    atReservation.resolve();
    await releaseReservation.promise;
    return h.manager.reserveWriter(request);
  };
  const coordinator=createTaskCoordinator(h,{
    taskManager:guardedManager,
    assistant:{async decide(){return {kind:"tool",toolCall:{
      name:"create_document",
      arguments:{
        sourceIds:[],format:"docx",
        title:"旧标题",content:"旧正文"
      }
    }};}},
    documentWorkspace:{async generate(){
      generated+=1;
      return syntheticReplyFile("已授权标题.docx");
    },async verifyPublished(){return true;}}
  });
  try {
    await h.manager.accept(taskMessage());
    const snapshot=await h.manager.claim("feishu");
    const running=coordinator.handleTask(snapshot);
    await atReservation.promise;
    await h.manager.accept(taskMessage({
      id:"m2",
      text:"补充：改用新标题",
      receivedAt:"2026-07-28T00:01:00.000Z"
    }));
    releaseReservation.resolve();

    assert.deepEqual(await running,{status:"stale"});
    assert.equal(generated,0);
    assert.equal(h.state.getOutcome("feishu:m1"),null);
  } finally {
    releaseReservation.resolve();
    await rm(h.root,{recursive:true,force:true});
  }
});

test("finishes one Writer reserved before a supplement and leaves the supplement pending",async()=>{
  const h=await taskHarness();
  const reserved=deferred(),releaseWriter=deferred(),sent=[];
  let generated=0;
  const guardedManager=Object.create(h.manager);
  guardedManager.reserveWriter=async request=>{
    const result=await h.manager.reserveWriter(request);
    reserved.resolve();
    await releaseWriter.promise;
    return result;
  };
  const coordinator=createTaskCoordinator(h,{
    taskManager:guardedManager,
    assistant:{async decide(){return {kind:"tool",toolCall:{
      name:"create_document",
      arguments:{
        sourceIds:[],format:"docx",
        title:"已授权标题",content:"已授权正文"
      }
    }};}},
    documentWorkspace:{async generate(){
      generated+=1;
      return syntheticReplyFile("已授权标题.docx");
    },async verifyPublished(){return true;}},
    messenger:{async send(value){sent.push(value);}}
  });
  try {
    await h.manager.accept(taskMessage());
    const snapshot=await h.manager.claim("feishu");
    const running=coordinator.handleTask(snapshot);
    await reserved.promise;
    await h.manager.accept(taskMessage({
      id:"m2",
      text:"补充：下一版把标题改短",
      receivedAt:"2026-07-28T00:01:00.000Z"
    }));
    releaseWriter.resolve();

    const result=await running;
    assert.equal(result.status,"committed");
    assert.equal(generated,1);
    assert.equal(sent.length,1);
    assert.equal(h.state.getOutcome("feishu:m1").status,"committed");
    assert.equal(h.state.getOutcome("feishu:m2"),null);
    assert.deepEqual(
      h.manager.current("feishu").pendingInputs.map(
        input=>input.messageKey
      ),
      ["feishu:m2"]
    );
  } finally {
    releaseWriter.resolve();
    await rm(h.root,{recursive:true,force:true});
  }
});

test("keeps one task source available across an AI question and later answer",async()=>{
  const h=await taskHarness();
  const calls={prepare:0,load:0,remove:0};
  const source={
    handle:{
      sourceId:"source-001",
      displayName:"项目材料.pdf",
      mediaClass:"document",
      format:"pdf",
      relativePath:"source-001.pdf",
      byteSize:100,
      sha256:"b".repeat(64),
      availability:"ready"
    },
    absolutePath:"/private/task/source-001.pdf",
    archiveExtension:"pdf"
  };
  let decisions=0;
  const coordinator=createTaskCoordinator(h,{
    taskWorkspace:{
      async prepareAndMerge(){
        calls.prepare+=1;
        return {
          workspaceDir:"/private/task",
          sources:[source],
          instructionText:"分析项目材料",
          addedSourceIds:["source-001"]
        };
      },
      async load({expectedSourceIds}){
        calls.load+=1;
        assert.deepEqual(expectedSourceIds,["source-001"]);
        return {
          workspaceDir:"/private/task",
          sources:[source]
        };
      },
      async remove(){calls.remove+=1;}
    },
    assistant:{async decide(context){
      decisions+=1;
      assert.deepEqual(
        context.sources.map(item=>item.sourceId),
        ["source-001"]
      );
      if (decisions===1) {
        return {
          kind:"ask",
          question:"需要保存，还是只总结？",
          waitingType:"waiting_confirmation",
          preparedTool:null
        };
      }
      assert.equal(
        context.task.waiting.question,
        "需要保存，还是只总结？"
      );
      return {
        kind:"reply",
        text:"已按你的补充要求只做总结。",
        taskUpdate:{
          workingSummary:"已完成项目材料总结。",
          confirmedRequirements:["只总结"],
          rejectedDirections:["不保存"]
        }
      };
    }}
  });
  try {
    await h.manager.accept(taskMessage({
      text:"分析项目材料",
      attachments:[{
        type:"file",
        sourceAttachmentId:"file-1",
        displayName:"项目材料.pdf",
        extension:"pdf"
      }]
    }));
    const first=await h.manager.claim("feishu");
    assert.equal(
      (await coordinator.handleTask(first)).status,
      "committed"
    );
    assert.deepEqual(
      h.manager.current("feishu").sourceIds,
      ["source-001"]
    );
    assert.equal(
      h.manager.current("feishu").waiting.type,
      "waiting_confirmation"
    );

    await h.manager.accept(taskMessage({
      id:"m2",
      text:"只总结，不保存",
      receivedAt:"2026-07-28T00:01:00.000Z"
    }));
    const second=await h.manager.claim("feishu");
    assert.equal(
      (await coordinator.handleTask(second)).status,
      "committed"
    );

    assert.deepEqual(calls,{prepare:1,load:1,remove:0});
    assert.equal(
      h.manager.current("feishu").workingSummary,
      "已完成项目材料总结。"
    );
    assert.deepEqual(
      h.manager.current("feishu").confirmedRequirements,
      ["只总结"]
    );
  } finally {
    await rm(h.root,{recursive:true,force:true});
  }
});

async function taskHarness() {
  const root=await mkdtemp(join(tmpdir(),"llw-coordinator-task-"));
  const state=await StateStore.open(join(root,"state.json"));
  const manager=new PersonalAssistantTaskSessionManager({
    state,
    bindings:{
      feishu:{userId:"owner",conversationId:"c1"},
      wechat:{userId:"wx-owner",conversationId:"wx-owner"}
    },
    selectModel:async()=>"codex",
    createId:()=>"T".repeat(43),
    now:()=>Date.parse("2026-07-28T00:01:00.000Z")
  });
  return {root,state,manager};
}

function createTaskCoordinator(h,overrides={}) {
  const taskWorkspace={
    async load(){
      return {workspaceDir:null,sources:[]};
    },
    ...overrides.taskWorkspace
  };
  return new PersonalAssistantCoordinator({
    prepareSource:async()=>({
      workspaceDir:null,sources:[],cleanup:async()=>{}
    }),
    assistant:overrides.assistant,
    writer:{},dailyWriter:{},invoiceWriter:{},
    documentWorkspace:overrides.documentWorkspace??{
      async generate(){throw new Error("must_not_generate");},
      async verifyPublished(){return true;}
    },
    artifactGenerator:async()=>{},
    outcomeStore:{
      get:key=>h.state.getOutcome(key),
      save:(outcome,key)=>h.state.saveOutcome(key,{
        capability:"personal-assistant",
        ...outcome,
        createdAt:"2026-07-28T00:00:00.000Z"
      }),
      markReplied:key=>h.state.markReplied(key)
    },
    messenger:overrides.messenger??{async send(){}},
    personalRules:[],
    model:"codex",
    skillVersion:"4.1.0",
    taskManager:overrides.taskManager??h.manager,
    taskWorkspace
  });
}

function taskMessage({
  id="m1",
  text="分析这个项目",
  receivedAt="2026-07-28T00:00:00.000Z",
  attachments=[]
}={}) {
  return {
    source:"feishu",
    sourceMessageId:id,
    userId:"owner",
    conversationId:"c1",
    receivedAt,
    instructionText:text,
    attachments,
    replyTarget:{
      source:"feishu",
      sourceMessageId:id,
      conversationId:"c1"
    }
  };
}

function syntheticReplyFile(displayName="result.docx") {
  return {
    kind:"docx",
    path:"/private/output/result.docx",
    displayName,
    mime:"application/docx",
    sha256:"a".repeat(64),
    size:100
  };
}

function deferred() {
  let resolve;
  const promise=new Promise(done=>{resolve=done;});
  return {promise,resolve};
}
