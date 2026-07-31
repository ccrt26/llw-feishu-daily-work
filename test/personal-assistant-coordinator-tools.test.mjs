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

test("labels a Douyin workspace acquisition failure as public-video source preparation",async()=>{
  const h=await taskHarness();
  try {
    await h.manager.accept(taskMessage({
      text:"总结 https://www.douyin.com/video/7648947659570515236"
    }));
    const snapshot=await h.manager.claim("feishu");
    const coordinator=createTaskCoordinator(h,{
      publicVideoReader:{},
      taskWorkspace:{
        async prepareAndMerge(){
          throw new Error("private_media_track_detail");
        }
      }
    });
    await assert.rejects(
      coordinator.handleTask(snapshot),
      error=>error.message==="private_media_track_detail"&&
        error.failurePhase==="public_video_source_preparation_failed"
    );
  } finally {
    await rm(h.root,{recursive:true,force:true});
  }
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

test("rejects twenty PDF pages before AI or Writer",async()=>{
  const h=await taskHarness();
  let assistantCalls=0,writerCalls=0;
  const pdfSource=number=>({
    handle:{
      sourceId:`source-00${number}`,
      displayName:`扫描材料${number}.pdf`,
      mediaClass:"pdf",format:"pdf",
      relativePath:`source-00${number}.pdf`,
      byteSize:2_000,sha256:String(number).repeat(64),
      availability:"ready",instructionRole:"source_content",
      representationIndexPath:null,limitations:[]
    },
    absolutePath:`/private/task/source-00${number}.pdf`,
    archiveExtension:"pdf"
  });
  const pages=[1,2].flatMap(sourceNumber=>
    Array.from({length:10},(_,index)=>({
      sourceId:`source-00${sourceNumber}`,
      relativePath:
        `source-00${sourceNumber}.page-${String(index+1)
          .padStart(3,"0")}.png`,
      sha256:String(sourceNumber).repeat(64),
      pageNumber:index+1
    }))
  );
  const coordinator=createTaskCoordinator(h,{
    taskWorkspace:{
      async prepareAndMerge(){
        return {
          workspaceDir:"/private/task",
          sources:[pdfSource(1),pdfSource(2)],
          instructionText:"总结两份扫描材料",
          addedSourceIds:["source-001","source-002"]
        };
      }
    },
    pdfReader:{async prepare(){
      return {observations:[],modelImageFiles:pages};
    }},
    assistant:{async decide(){
      assistantCalls+=1;
      return {kind:"reply",text:"must not run"};
    }},
    writer:{async commit(){writerCalls+=1;}}
  });
  try {
    await h.manager.accept(taskMessage({
      text:"总结两份扫描材料",
      attachments:[
        {
          type:"file",sourceAttachmentId:"p1",
          displayName:"扫描材料1.pdf",extension:"pdf"
        },
        {
          type:"file",sourceAttachmentId:"p2",
          displayName:"扫描材料2.pdf",extension:"pdf"
        }
      ]
    }));
    const result=await coordinator.handleTask(
      await h.manager.claim("feishu")
    );
    assert.equal(result.outcome.status,"rejected");
    assert.match(result.outcome.reply,/开始新任务/u);
    assert.equal(assistantCalls,0);
    assert.equal(writerCalls,0);
  } finally {
    await rm(h.root,{recursive:true,force:true});
  }
});

test("marks source read unavailable when no reader is injected",async()=>{
  const h=await taskHarness();
  const coordinator=createTaskCoordinator(h,{
    assistant:{async decide(_context,options){
      assert.equal(options.allowSourceRead,false);
      return {kind:"reply",text:"只读完成"};
    }}
  });
  try {
    await h.manager.accept(taskMessage());
    const result=await coordinator.handleTask(
      await h.manager.claim("feishu")
    );
    assert.equal(result.outcome.status,"committed");
  } finally {
    await rm(h.root,{recursive:true,force:true});
  }
});

test("marks source read available when a reader is injected",async()=>{
  const h=await taskHarness();
  const coordinator=createTaskCoordinator(h,{
    taskWorkspace:{async ensure(){
      return {
        workspaceDir:"/private/task",
        sources:[videoBinding()]
      };
    }},
    sourceReader:{async read(){
      throw new Error("must_not_read");
    }},
    assistant:{async decide(_context,options){
      assert.equal(options.allowSourceRead,true);
      return {kind:"reply",text:"只读完成"};
    }}
  });
  try {
    await h.manager.accept(taskMessage());
    const result=await coordinator.handleTask(
      await h.manager.claim("feishu")
    );
    assert.equal(result.outcome.status,"committed");
  } finally {
    await rm(h.root,{recursive:true,force:true});
  }
});

test("does not advertise source read without one remaining image slot",async()=>{
  const h=await taskHarness();
  const coordinator=createTaskCoordinator(h,{
    sourceReader:{async read(){throw new Error("must_not_read");}},
    publicVideoReader:{async prepare(){
      return {
        observations:[],
        modelImageFiles:Array.from({length:16},(_,index)=>({
          sourceId:"source-001",
          relativePath:`source-001.timeline-${index}.png`,
          sha256:"a".repeat(64),
          startMs:index,
          endMs:index+1
        }))
      };
    }},
    assistant:{async decide(_context,options){
      assert.equal(options.allowSourceRead,false);
      return {kind:"reply",text:"图片预算已用满"};
    }}
  });
  try {
    await h.manager.accept(taskMessage());
    const result=await coordinator.handleTask(
      await h.manager.claim("feishu")
    );
    assert.equal(result.outcome.status,"committed");
  } finally {
    await rm(h.root,{recursive:true,force:true});
  }
});

test("adds one inspected interval observation and image to the next model call",async()=>{
  const h=await taskHarness();
  let assistantCalls=0,readerCalls=0;
  const intervalImage={
    sourceId:"source-001",
    relativePath:"source-001.inspect-5000-7000.png",
    sha256:"b".repeat(64),
    startMs:5_000,
    endMs:7_000
  };
  const observation={
    sourceId:"source-001",
    view:"inspect_time_range",
    derivedRelativePath:"source-001.inspect-5000-7000.json",
    sha256:"c".repeat(64),
    producedBy:"synthetic-range-reader",
    content:JSON.stringify({startMs:5_000,endMs:7_000}),
    limitations:["uniform_range_sampling"]
  };
  const coordinator=createTaskCoordinator(h,{
    taskWorkspace:{async ensure(){
      return {
        workspaceDir:"/private/task",
        sources:[videoBinding()]
      };
    }},
    sourceReader:{async read(){
      readerCalls+=1;
      return {
        observations:[observation],
        modelImageFiles:[intervalImage]
      };
    }},
    assistant:{async decide(context,options){
      assistantCalls+=1;
      if (assistantCalls===1) {
        assert.equal(options.allowSourceRead,true);
        return {
          kind:"source_read",
          requests:[{
            sourceId:"source-001",
            view:"inspect_time_range",
            startMs:5_000,
            endMs:7_000
          }]
        };
      }
      assert.equal(options.allowSourceRead,true);
      assert.deepEqual(options.modelImageFiles,[intervalImage]);
      assert.deepEqual(context.sourceObservations,[observation]);
      return {kind:"reply",text:"区间画面已核对"};
    }}
  });
  try {
    await h.manager.accept(taskMessage());
    const result=await coordinator.handleTask(
      await h.manager.claim("feishu")
    );
    assert.equal(result.outcome.status,"committed");
    assert.equal(readerCalls,1);
    assert.equal(assistantCalls,2);
  } finally {
    await rm(h.root,{recursive:true,force:true});
  }
});

test("turns an interval backend failure into one truthful zero-write reply",async()=>{
  const h=await taskHarness();
  let writerCalls=0;
  const coordinator=createTaskCoordinator(h,{
    sourceReader:{async read(){
      throw new Error("video_timeline_media_invalid");
    }},
    assistant:{async decide(){
      return {
        kind:"source_read",
        requests:[{
          sourceId:"source-001",
          view:"inspect_time_range",
          startMs:5_000,
          endMs:7_000
        }]
      };
    }},
    writer:{async commit(){writerCalls+=1;}}
  });
  try {
    await h.manager.accept(taskMessage());
    const result=await coordinator.handleTask(
      await h.manager.claim("feishu")
    );
    assert.equal(result.outcome.status,"committed");
    assert.match(result.outcome.reply,/未能取得.*时间区间/u);
    assert.match(result.outcome.reply,/没有执行保存或其他写入/u);
    assert.equal(writerCalls,0);
  } finally {
    await rm(h.root,{recursive:true,force:true});
  }
});

test("stops a stale task after interval reading before a second model call",async()=>{
  const h=await taskHarness();
  let assistantCalls=0,writerCalls=0;
  const coordinator=createTaskCoordinator(h,{
    sourceReader:{async read(){
      await h.manager.accept(taskMessage({
        id:"m2",
        text:"补充：关注最后的数字",
        receivedAt:"2026-07-28T00:01:00.000Z"
      }));
      return {
        observations:[],
        modelImageFiles:[]
      };
    }},
    assistant:{async decide(){
      assistantCalls+=1;
      return {
        kind:"source_read",
        requests:[{
          sourceId:"source-001",
          view:"inspect_time_range",
          startMs:5_000,
          endMs:7_000
        }]
      };
    }},
    writer:{async commit(){writerCalls+=1;}}
  });
  try {
    await h.manager.accept(taskMessage());
    const result=await coordinator.handleTask(
      await h.manager.claim("feishu")
    );
    assert.deepEqual(result,{status:"stale"});
    assert.equal(assistantCalls,1);
    assert.equal(writerCalls,0);
    assert.equal(h.state.getOutcome("feishu:m1"),null);
  } finally {
    await rm(h.root,{recursive:true,force:true});
  }
});

test("sends one processing receipt without consuming the final Outcome",async()=>{
  const h=await taskHarness();
  const sent=[];
  const coordinator=createTaskCoordinator(h,{
    publicVideoReader:{
      async prepare({onProcessingAccepted}) {
        await onProcessingAccepted();
        await onProcessingAccepted();
        return {observations:[],modelImageFiles:[]};
      }
    },
    assistant:{async decide(){
      return {kind:"reply",text:"视频总结完成。"};
    }},
    messenger:{async send(value){
      sent.push(structuredClone(value));
    }}
  });
  try {
    await h.manager.accept(taskMessage());
    const snapshot=await h.manager.claim("feishu");
    const result=await coordinator.handleTask(snapshot);

    assert.equal(result.outcome.status,"committed");
    assert.equal(sent.length,2);
    assert.equal(sent[0].text,"已收到，正在处理。");
    assert.equal(
      sent[0].idempotencyKey,
      `processing:${snapshot.taskId}`
    );
    assert.equal(sent[1].text,"视频总结完成。");
    assert.equal(
      h.state.getOutcome(`processing:${snapshot.taskId}`),
      null
    );
    assert.equal(h.state.getOutcome("feishu:m1").status,"committed");
  } finally {
    await rm(h.root,{recursive:true,force:true});
  }
});

test("a processing receipt send failure does not block the final reply",async()=>{
  const h=await taskHarness();
  const sent=[];
  const coordinator=createTaskCoordinator(h,{
    publicVideoReader:{
      async prepare({onProcessingAccepted}) {
        await onProcessingAccepted();
        return {observations:[],modelImageFiles:[]};
      }
    },
    assistant:{async decide(){
      return {kind:"reply",text:"最终结果仍然送达。"};
    }},
    messenger:{async send(value){
      if (value.idempotencyKey.startsWith("processing:")) {
        throw new Error("processing_reply_failed");
      }
      sent.push(structuredClone(value));
    }}
  });
  try {
    await h.manager.accept(taskMessage());
    const result=await coordinator.handleTask(
      await h.manager.claim("feishu")
    );

    assert.equal(result.outcome.status,"committed");
    assert.equal(sent.length,1);
    assert.equal(sent[0].text,"最终结果仍然送达。");
    assert.equal(h.state.getOutcome("feishu:m1").status,"committed");
  } finally {
    await rm(h.root,{recursive:true,force:true});
  }
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
    async ensure(){
      return {workspaceDir:"/private/task",sources:[]};
    },
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
    writer:overrides.writer??{},dailyWriter:{},invoiceWriter:{},
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
    sourceReader:overrides.sourceReader??null,
    pdfReader:overrides.pdfReader??null,
    publicVideoReader:overrides.publicVideoReader??null,
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

function videoBinding() {
  return {
    handle:{
      sourceId:"source-001",
      displayName:"测试公开视频.mp4",
      mediaClass:"video",
      format:"mp4",
      relativePath:"source-001.mp4",
      byteSize:100,
      sha256:"a".repeat(64),
      availability:"ready",
      durationMs:20_000,
      instructionRole:"source_content",
      representationIndexPath:"source-001.manifest.json",
      limitations:[]
    },
    absolutePath:"/private/task/source-001.mp4"
  };
}

function deferred() {
  let resolve;
  const promise=new Promise(done=>{resolve=done;});
  return {promise,resolve};
}
