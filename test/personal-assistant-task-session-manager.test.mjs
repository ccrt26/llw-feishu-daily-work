import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {StateStore} from "../src/state-store.mjs";
import {
  PersonalAssistantTaskSessionManager
} from "../src/personal-assistant/task-session-manager.mjs";

const FEISHU_TASK_ID="F".repeat(43);
const WECHAT_TASK_ID="W".repeat(43);
const NOW="2026-07-29T01:00:00.000Z";
const LATER="2026-07-29T01:01:00.000Z";
const AFTER_EXPIRY="2026-07-30T01:00:00.001Z";

function message({
  source="feishu",
  id="message-1",
  text="先分析这个项目",
  receivedAt=NOW,
  attachments=[]
}={}) {
  const wechat=source==="wechat";
  return {
    source,
    sourceMessageId:id,
    userId:wechat?"wechat-owner":"feishu-owner",
    conversationId:wechat?"wechat-owner":"feishu-chat",
    receivedAt,
    instructionText:text,
    attachments,
    replyTarget:wechat
      ?{
        source,
        sourceMessageId:id,
        conversationId:"wechat-owner",
        contextToken:`context-${id}`
      }
      :{
        source,
        sourceMessageId:id,
        conversationId:"feishu-chat"
      }
  };
}

async function harness() {
  const root=await mkdtemp(join(tmpdir(),"llw-pa-task-manager-"));
  const file=join(root,"state.json");
  const state=await StateStore.open(file);
  const ids=[FEISHU_TASK_ID,WECHAT_TASK_ID];
  const manager=new PersonalAssistantTaskSessionManager({
    state,
    bindings:{
      feishu:{userId:"feishu-owner",conversationId:"feishu-chat"},
      wechat:{userId:"wechat-owner",conversationId:"wechat-owner"}
    },
    selectModel:async()=>"codex",
    createId:()=>ids.shift(),
    now:()=>Date.parse(NOW)
  });
  return {file,state,manager};
}

test("durably accepts supplements before work and makes an old snapshot stale",async()=>{
  const h=await harness();
  const accepted=await h.manager.accept(message());
  assert.deepEqual(accepted,{
    taskId:FEISHU_TASK_ID,
    revision:1,
    source:"feishu",
    isNew:true,
    messageKey:"feishu:message-1"
  });
  const snapshot=await h.manager.claim("feishu");
  assert.equal(snapshot.revision,1);
  assert.equal(snapshot.message.instructionText,"先分析这个项目");

  await h.manager.accept(message({
    id:"message-2",
    text:"重点分析风险",
    receivedAt:LATER
  }));

  assert.equal(await h.manager.isCurrent(snapshot),false);
  assert.equal(h.manager.current("feishu").revision,2);
  const reopened=await StateStore.open(h.file);
  assert.equal(
    (await reopened.getPersonalAssistantTaskSession("feishu",LATER))
      .revision,
    2
  );
});

test("keeps Feishu and WeChat task identity, revision and pending input isolated",async()=>{
  const h=await harness();
  await h.manager.accept(message());
  await h.manager.accept(message({
    source:"wechat",
    id:"wechat-message-1",
    text:"整理另一份材料"
  }));

  assert.equal(h.manager.current("feishu").taskId,FEISHU_TASK_ID);
  assert.equal(h.manager.current("wechat").taskId,WECHAT_TASK_ID);
  assert.equal(h.manager.current("feishu").revision,1);
  assert.equal(h.manager.current("wechat").revision,1);
  assert.equal(
    h.manager.current("feishu").pendingInputs[0].messageKey,
    "feishu:message-1"
  );
  assert.equal(
    h.manager.current("wechat").pendingInputs[0].messageKey,
    "wechat:wechat-message-1"
  );
});

test("atomically resolves a stage and persists one primary outcome plus aliases",async()=>{
  const h=await harness();
  await h.manager.accept(message());
  await h.manager.accept(message({
    id:"message-2",
    text:"重点分析风险",
    receivedAt:LATER
  }));
  const snapshot=await h.manager.claim("feishu");

  const committed=await h.manager.completeStage(snapshot,{
    status:"committed",
    reply:"已按补充要求完成分析。",
    artifacts:[],
    replyFiles:[],
    noReplyRequired:false,
    waiting:null,
    taskUpdate:{
      workingSummary:"已完成项目风险分析。",
      confirmedRequirements:["重点分析风险"],
      rejectedDirections:[]
    }
  });

  assert.equal(committed,true);
  const session=h.manager.current("feishu");
  assert.equal(session.resolvedRevision,2);
  assert.equal(session.pendingInputs.length,0);
  assert.equal(session.status,"active");
  assert.equal(h.state.getOutcome("feishu:message-1").status,"ignored");
  assert.equal(
    h.state.getOutcome("feishu:message-1").reasonCode,
    "absorbed_into_task_revision"
  );
  assert.equal(
    h.state.getOutcome("feishu:message-2").reply,
    "已按补充要求完成分析。"
  );
});

test("restores unresolved work after restart and clears only the selected channel",async()=>{
  const h=await harness();
  await h.manager.accept(message());
  await h.manager.accept(message({
    source:"wechat",
    id:"wechat-message-1",
    text:"整理另一份材料"
  }));

  const reopened=await StateStore.open(h.file);
  const ids=["X".repeat(43)];
  const manager=new PersonalAssistantTaskSessionManager({
    state:reopened,
    bindings:{
      feishu:{userId:"feishu-owner",conversationId:"feishu-chat"},
      wechat:{userId:"wechat-owner",conversationId:"wechat-owner"}
    },
    selectModel:async()=>"codex",
    createId:()=>ids.shift(),
    now:()=>Date.parse(NOW)
  });

  assert.deepEqual(await manager.recoverPending(),[
    "feishu","wechat"
  ]);
  await manager.close("feishu","ended",LATER);
  assert.equal(manager.current("feishu"),null);
  assert.equal(manager.current("wechat").taskId,WECHAT_TASK_ID);
  assert.equal(
    await reopened.getPersonalAssistantTaskSession("feishu",LATER),
    null
  );
});

test("replaces a paused task on ordinary input and reports the old task for cleanup",async()=>{
  const h=await harness();
  await h.manager.accept(message());
  await h.manager.pause("feishu",LATER);

  const accepted=await h.manager.accept(message({
    id:"message-2",
    text:"这是一个新的普通要求",
    receivedAt:"2026-07-29T01:02:00.000Z"
  }));

  assert.equal(accepted.isNew,true);
  assert.equal(accepted.replacedTaskId,FEISHU_TASK_ID);
  assert.equal(accepted.taskId,WECHAT_TASK_ID);
  assert.equal(h.manager.current("feishu").status,"active");
});

test("expires an in-memory task after 24 hours before accepting new input",async()=>{
  const h=await harness();
  await h.manager.accept(message());

  const accepted=await h.manager.accept(message({
    id:"message-after-expiry",
    text:"超时后的新要求",
    receivedAt:AFTER_EXPIRY
  }));

  assert.equal(accepted.isNew,true);
  assert.equal(accepted.taskId,WECHAT_TASK_ID);
  assert.equal(h.manager.current("feishu").revision,1);
  assert.equal(
    h.manager.current("feishu").pendingInputs[0].messageKey,
    "feishu:message-after-expiry"
  );
});

test("makes a snapshot stale after pause and resume even without a new input",async()=>{
  const h=await harness();
  await h.manager.accept(message());
  const snapshot=await h.manager.claim("feishu");

  await h.manager.pause("feishu",LATER);
  await h.manager.resume(
    "feishu","2026-07-29T01:02:00.000Z"
  );

  assert.equal(await h.manager.isCurrent(snapshot),false);
  assert.equal(await h.manager.completeStage(snapshot,{
    status:"committed",
    reply:"不应提交的旧回答",
    artifacts:[],
    replyFiles:[],
    noReplyRequired:false,
    waiting:null
  }),false);
});

test("moves inspected attachments into source ids without resolving their input",async()=>{
  const h=await harness();
  await h.manager.accept(message({
    text:"",
    attachments:[{
      type:"file",
      sourceAttachmentId:"file-1",
      displayName:"材料.pdf",
      extension:"pdf"
    }]
  }));
  const snapshot=await h.manager.claim("feishu");

  const updated=await h.manager.attachSources(snapshot,{
    addedSourceIds:["source-001"]
  });

  assert.deepEqual(updated.sourceIds,["source-001"]);
  assert.equal(updated.pendingInputs.length,1);
  assert.deepEqual(updated.pendingInputs[0].attachments,[]);
  assert.equal(updated.resolvedRevision,0);
  assert.equal(await h.manager.isCurrent(snapshot),true);
});

test("blocks a stale Writer reservation before any side effect",async()=>{
  const h=await harness();
  await h.manager.accept(message());
  const snapshot=await h.manager.claim("feishu");
  await h.manager.accept(message({
    id:"message-2",
    text:"补充新要求",
    receivedAt:LATER
  }));

  assert.equal(await h.manager.reserveWriter({
    source:"feishu",
    taskId:snapshot.taskId,
    revision:snapshot.revision,
    updatedAt:snapshot.session.updatedAt,
    toolName:"create_document"
  }),false);
  assert.equal(await h.manager.isCommitCompatible(snapshot),false);
});

test("finishes an already reserved Writer stage and preserves a later supplement",async()=>{
  const h=await harness();
  await h.manager.accept(message());
  const snapshot=await h.manager.claim("feishu");
  assert.equal(await h.manager.reserveWriter({
    source:"feishu",
    taskId:snapshot.taskId,
    revision:snapshot.revision,
    updatedAt:snapshot.session.updatedAt,
    toolName:"create_document"
  }),true);

  await h.manager.accept(message({
    id:"message-2",
    text:"补充：把标题改短",
    receivedAt:LATER
  }));

  assert.equal(await h.manager.isCurrent(snapshot),false);
  assert.equal(await h.manager.isCommitCompatible(snapshot),true);
  assert.equal(await h.manager.completeStage(snapshot,{
    status:"committed",
    reply:"旧版本已在补充到达前获得写入授权并完成。",
    artifacts:[{kind:"docx"}],
    replyFiles:[],
    noReplyRequired:false,
    waiting:null
  }),true);
  const current=h.manager.current("feishu");
  assert.equal(current.revision,2);
  assert.equal(current.resolvedRevision,1);
  assert.equal(current.writerCheckpoint,null);
  assert.deepEqual(
    current.pendingInputs.map(input=>input.messageKey),
    ["feishu:message-2"]
  );
  assert.equal(
    h.state.getOutcome("feishu:message-1").status,
    "committed"
  );
  assert.equal(h.state.getOutcome("feishu:message-2"),null);
});

test("binds the optional WeChat channel before accepting or recovering it",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-pa-task-binding-"));
  const state=await StateStore.open(join(root,"state.json"));
  try {
    const manager=new PersonalAssistantTaskSessionManager({
      state,
      bindings:{
        feishu:{
          userId:"feishu-owner",
          conversationId:"feishu-chat"
        },
        wechat:null
      },
      selectModel:async()=>"codex",
      createId:()=>WECHAT_TASK_ID,
      now:()=>Date.parse(NOW)
    });
    assert.deepEqual(await manager.recoverPending(),[]);
    assert.throws(
      ()=>manager.accept(message({
        source:"wechat",
        id:"wechat-before-binding"
      })),
      /task_session_manager_invalid/
    );

    manager.bind("wechat",{
      userId:"wechat-owner",
      conversationId:"wechat-owner"
    });
    const accepted=await manager.accept(message({
      source:"wechat",
      id:"wechat-after-binding"
    }));
    assert.equal(accepted.taskId,WECHAT_TASK_ID);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});
