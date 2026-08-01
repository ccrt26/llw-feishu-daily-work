import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {PersonalAssistantDispatcher} from "../src/personal-assistant/dispatcher.mjs";
import {
  PersonalAssistantCoordinator
} from "../src/personal-assistant/coordinator.mjs";
import {
  PersonalAssistantTaskSessionManager
} from "../src/personal-assistant/task-session-manager.mjs";
import {StateStore} from "../src/state-store.mjs";

function incoming(overrides={}) {
  return {
    source:"feishu",sourceMessageId:"m1",
    userId:"owner",conversationId:"private",
    receivedAt:"2026-07-28T00:00:00.000Z",
    instructionText:"你好",attachments:[],
    replyTarget:{
      source:"feishu",sourceMessageId:"m1",conversationId:"private"
    },
    ...overrides
  };
}

test("durably accepts a supplement while the previous task revision is running",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-dispatcher-task-"));
  const state=await StateStore.open(join(root,"state.json"));
  const manager=new PersonalAssistantTaskSessionManager({
    state,
    bindings:{
      feishu:{userId:"owner",conversationId:"private"},
      wechat:{userId:"wx-owner",conversationId:"wx-owner"}
    },
    selectModel:async()=>"codex",
    createId:()=>"T".repeat(43),
    now:()=>Date.parse("2026-07-28T00:01:00.000Z")
  });
  const firstStarted=deferred();
  const releaseFirst=deferred();
  const handledRevisions=[];
  const dispatcher=new PersonalAssistantDispatcher({
    binding:{senderId:"owner",chatId:"private"},
    bindings:{
      feishu:{userId:"owner",conversationId:"private"},
      wechat:{userId:"wx-owner",conversationId:"wx-owner"}
    },
    state,taskManager:manager,
    coordinator:{
      async handleTask(snapshot){
        handledRevisions.push(snapshot.revision);
        if (snapshot.revision===1) {
          firstStarted.resolve();
          await releaseFirst.promise;
          assert.equal(await manager.isCurrent(snapshot),false);
          return {status:"stale"};
        }
        const committed=await manager.completeStage(snapshot,{
          status:"committed",
          reply:"包含补充要求的新答案",
          artifacts:[],
          replyFiles:[],
          noReplyRequired:false,
          waiting:null
        });
        assert.equal(committed,true);
        return {status:"committed"};
      }
    },
    modelMode:{},deepseekEnabled:false,messenger:{async send(){}}
  });
  try {
    assert.deepEqual(
      await dispatcher.acceptIncomingMessage(incoming({
        sourceMessageId:"first",
        instructionText:"分析这份材料"
      })),
      {handled:true,status:"accepted"}
    );
    assert.equal(manager.current("feishu").revision,1);
    await firstStarted.promise;

    const accepted=await dispatcher.acceptIncomingMessage(incoming({
      sourceMessageId:"supplement",
      receivedAt:"2026-07-28T00:01:00.000Z",
      instructionText:"补充：重点分析风险"
    }));

    assert.deepEqual(accepted,{handled:true,status:"accepted"});
    assert.equal(manager.current("feishu").revision,2);
    releaseFirst.resolve();
    await dispatcher.flushAcceptedMessages();
    assert.deepEqual(handledRevisions,[1,2]);
    assert.equal(
      state.getOutcome("feishu:supplement").reply,
      "包含补充要求的新答案"
    );
    assert.equal(
      state.getOutcome("feishu:first").reasonCode,
      "absorbed_into_task_revision"
    );
  } finally {
    releaseFirst.resolve();
    await rm(root,{recursive:true,force:true});
  }
});

test("recovers a durably accepted task after a process restart",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-dispatcher-restart-"));
  const file=join(root,"state.json");
  const firstState=await StateStore.open(file);
  const bindings={
    feishu:{userId:"owner",conversationId:"private"},
    wechat:{userId:"wx-owner",conversationId:"wx-owner"}
  };
  const firstManager=new PersonalAssistantTaskSessionManager({
    state:firstState,bindings,
    selectModel:async()=>"codex",
    createId:()=>"R".repeat(43),
    now:()=>Date.parse("2026-07-28T00:01:00.000Z")
  });
  await firstManager.accept(incoming({
    sourceMessageId:"before-restart",
    instructionText:"重启后继续这个任务"
  }));

  const reopened=await StateStore.open(file);
  const recoveredManager=new PersonalAssistantTaskSessionManager({
    state:reopened,bindings,
    selectModel:async()=>"codex",
    createId:()=>"N".repeat(43),
    now:()=>Date.parse("2026-07-28T00:01:00.000Z")
  });
  const revisions=[];
  const dispatcher=new PersonalAssistantDispatcher({
    binding:{senderId:"owner",chatId:"private"},
    bindings,state:reopened,taskManager:recoveredManager,
    coordinator:{
      async handleTask(snapshot){
        revisions.push(snapshot.revision);
        assert.equal(await recoveredManager.completeStage(snapshot,{
          status:"committed",
          reply:"重启后已继续完成",
          artifacts:[],
          replyFiles:[],
          noReplyRequired:false,
          waiting:null
        }),true);
        return {status:"committed"};
      }
    },
    modelMode:{},deepseekEnabled:false,messenger:{async send(){}}
  });
  try {
    assert.deepEqual(await dispatcher.recoverPendingTasks(),[
      "feishu"
    ]);
    await dispatcher.flushAcceptedMessages();
    assert.deepEqual(revisions,[1]);
    assert.equal(
      reopened.getOutcome("feishu:before-restart").reply,
      "重启后已继续完成"
    );
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test("runs Feishu and WeChat task pipelines independently",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-dispatcher-channels-"));
  const state=await StateStore.open(join(root,"state.json"));
  const ids=["F".repeat(43),"W".repeat(43)];
  const manager=new PersonalAssistantTaskSessionManager({
    state,
    bindings:{
      feishu:{userId:"owner",conversationId:"private"},
      wechat:{userId:"wx-owner",conversationId:"wx-owner"}
    },
    selectModel:async()=>"codex",
    createId:()=>ids.shift(),
    now:()=>Date.parse("2026-07-28T00:00:00.000Z")
  });
  const bothStarted=deferred();
  const release=deferred();
  const started=new Set();
  const dispatcher=new PersonalAssistantDispatcher({
    binding:{senderId:"owner",chatId:"private"},
    bindings:{
      feishu:{userId:"owner",conversationId:"private"},
      wechat:{userId:"wx-owner",conversationId:"wx-owner"}
    },
    state,taskManager:manager,
    coordinator:{
      async handleTask(snapshot){
        started.add(snapshot.session.source);
        if (started.size===2) bothStarted.resolve();
        await release.promise;
        assert.equal(await manager.completeStage(snapshot,{
          status:"committed",
          reply:`${snapshot.session.source} 已完成`,
          artifacts:[],
          replyFiles:[],
          noReplyRequired:false,
          waiting:null
        }),true);
        return {status:"committed"};
      }
    },
    modelMode:{},deepseekEnabled:false,messenger:{async send(){}}
  });
  try {
    await dispatcher.acceptIncomingMessage(incoming({
      sourceMessageId:"feishu-independent"
    }));
    await dispatcher.acceptIncomingMessage(incoming({
      source:"wechat",
      sourceMessageId:"wechat-independent",
      userId:"wx-owner",
      conversationId:"wx-owner",
      replyTarget:{
        source:"wechat",
        sourceMessageId:"wechat-independent",
        conversationId:"wx-owner",
        contextToken:"wechat-context"
      }
    }));
    let timer;
    try {
      await Promise.race([
        bothStarted.promise,
        new Promise((_,reject)=>{
          timer=setTimeout(
            ()=>reject(new Error("channels_were_serialized")),250
          );
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
    assert.deepEqual([...started].sort(),["feishu","wechat"]);
    release.resolve();
    await dispatcher.flushAcceptedMessages();
  } finally {
    release.resolve();
    await rm(root,{recursive:true,force:true});
  }
});

test("keeps the same task after a completed debounce scheduling window",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-dispatcher-debounce-"));
  const state=await StateStore.open(join(root,"state.json"));
  const manager=new PersonalAssistantTaskSessionManager({
    state,
    bindings:{
      feishu:{userId:"owner",conversationId:"private"},
      wechat:{userId:"wx-owner",conversationId:"wx-owner"}
    },
    selectModel:async()=>"codex",
    createId:()=>"D".repeat(43),
    now:()=>Date.parse("2026-07-28T01:00:00.000Z")
  });
  const taskIds=[];
  const dispatcher=new PersonalAssistantDispatcher({
    binding:{senderId:"owner",chatId:"private"},
    bindings:{
      feishu:{userId:"owner",conversationId:"private"},
      wechat:{userId:"wx-owner",conversationId:"wx-owner"}
    },
    state,taskManager:manager,
    coordinator:{
      async handleTask(snapshot){
        taskIds.push(snapshot.taskId);
        assert.equal(await manager.completeStage(snapshot,{
          status:"committed",
          reply:`完成 revision ${snapshot.revision}`,
          artifacts:[],
          replyFiles:[],
          noReplyRequired:false,
          waiting:null
        }),true);
        return {status:"committed"};
      }
    },
    modelMode:{},deepseekEnabled:false,messenger:{async send(){}},
    sourceBurstQuietMs:5
  });
  try {
    await dispatcher.acceptIncomingMessage(incoming({
      sourceMessageId:"before-window",
      instructionText:"先完成初步分析"
    }));
    await dispatcher.flushAcceptedMessages();
    const taskId=manager.current("feishu").taskId;

    await dispatcher.acceptIncomingMessage(incoming({
      sourceMessageId:"after-window",
      receivedAt:"2026-07-28T01:00:00.000Z",
      instructionText:"一小时后补充结论格式"
    }));
    assert.equal(manager.current("feishu").taskId,taskId);
    assert.equal(manager.current("feishu").revision,2);
    await dispatcher.flushAcceptedMessages();

    assert.deepEqual(taskIds,[taskId,taskId]);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test("cancels a running task before the slow business pipeline is released",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-dispatcher-cancel-"));
  const state=await StateStore.open(join(root,"state.json"));
  const manager=new PersonalAssistantTaskSessionManager({
    state,
    bindings:{
      feishu:{userId:"owner",conversationId:"private"},
      wechat:{userId:"wx-owner",conversationId:"wx-owner"}
    },
    selectModel:async()=>"codex",
    createId:()=>"C".repeat(43),
    now:()=>Date.parse("2026-07-28T00:01:00.000Z")
  });
  const started=deferred();
  const release=deferred();
  const cancelled=[],removed=[];
  const dispatcher=new PersonalAssistantDispatcher({
    binding:{senderId:"owner",chatId:"private"},
    bindings:{
      feishu:{userId:"owner",conversationId:"private"},
      wechat:{userId:"wx-owner",conversationId:"wx-owner"}
    },
    state,taskManager:manager,
    taskWorkspace:{
      async remove({taskId}){removed.push(taskId);}
    },
    cancelTaskWork:async value=>{cancelled.push(value);},
    coordinator:{
      async handleTask(snapshot){
        started.resolve();
        await release.promise;
        assert.equal(await manager.isCurrent(snapshot),false);
        return {status:"stale"};
      }
    },
    modelMode:{},deepseekEnabled:false,messenger:{async send(){}}
  });
  try {
    await dispatcher.acceptIncomingMessage(incoming({
      sourceMessageId:"running-task",
      instructionText:"执行一个慢任务"
    }));
    await started.promise;

    const result=await dispatcher.acceptIncomingMessage(incoming({
      sourceMessageId:"cancel-running",
      receivedAt:"2026-07-28T00:01:00.000Z",
      instructionText:"取消"
    }));

    assert.deepEqual(result,{handled:true,status:"committed"});
    assert.equal(manager.current("feishu"),null);
    assert.equal(cancelled.length,1);
    assert.deepEqual(removed,["C".repeat(43)]);
    assert.equal(
      state.getOutcome("feishu:running-task").reasonCode,
      "cancelled"
    );
    release.resolve();
    await dispatcher.flushAcceptedMessages();
    assert.match(
      state.getOutcome("feishu:cancel-running").reply,
      /已取消/u
    );
  } finally {
    release.resolve();
    await rm(root,{recursive:true,force:true});
  }
});

test("reports a safe public-video cause without exposing internal details",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-dispatcher-video-failure-"));
  const state=await StateStore.open(join(root,"state.json"));
  const manager=new PersonalAssistantTaskSessionManager({
    state,
    bindings:{
      feishu:{userId:"owner",conversationId:"private"},
      wechat:{userId:"wx-owner",conversationId:"wx-owner"}
    },
    selectModel:async()=>"codex",
    createId:()=>"V".repeat(43),
    now:()=>Date.parse("2026-07-28T00:01:00.000Z")
  });
  const failures=[];
  const dispatcher=new PersonalAssistantDispatcher({
    binding:{senderId:"owner",chatId:"private"},
    bindings:{
      feishu:{userId:"owner",conversationId:"private"},
      wechat:{userId:"wx-owner",conversationId:"wx-owner"}
    },
    state,taskManager:manager,
    coordinator:{
      async handleTask(snapshot) {
        const failure=new Error("public_video_source_invalid");
        failure.failurePhase="public_video_source_preparation_failed";
        failure.publicVideoFailureCode=snapshot.revision===1
          ?"bilibili_media_unavailable"
          :snapshot.revision===2
            ?"bilibili_audio_hash_mismatch"
            :"not_allowlisted_sensitive_detail";
        throw failure;
      }
    },
    onFailure:code=>failures.push(code),
    modelMode:{},deepseekEnabled:false,messenger:{async send(){}}
  });
  try {
    await dispatcher.acceptIncomingMessage(incoming({
      sourceMessageId:"source-failure",
      instructionText:"处理公开视频"
    }));
    await dispatcher.flushAcceptedMessages();
    const first=state.getOutcome("feishu:source-failure");
    assert.equal(
      first.reasonCode,
      "public_video_source_preparation_failed"
    );
    assert.equal(
      first.reply,
      "B 站本次没有提供完整可用的音频和画面，所以没有调用转写、AI 或 Writer，也没有写入。需要时请重新发送同一链接。"
    );

    await dispatcher.acceptIncomingMessage(incoming({
      sourceMessageId:"revalidation-source-failure",
      receivedAt:"2026-07-28T00:01:00.000Z",
      instructionText:"再次处理公开视频"
    }));
    await dispatcher.flushAcceptedMessages();
    const second=state.getOutcome("feishu:revalidation-source-failure");
    assert.equal(second.reasonCode,"public_video_source_preparation_failed");
    assert.equal(
      second.reply,
      "视频来源已取得，但本地安全校验未通过，所以没有调用转写、AI 或 Writer，也没有写入。请重新发送；如果持续出现，请反馈给维护人员。"
    );
    await dispatcher.acceptIncomingMessage(incoming({
      sourceMessageId:"unknown-source-failure",
      receivedAt:"2026-07-28T00:01:00.000Z",
      instructionText:"第三次处理公开视频"
    }));
    await dispatcher.flushAcceptedMessages();
    const third=state.getOutcome("feishu:unknown-source-failure");
    assert.equal(third.reasonCode,"public_video_source_preparation_failed");
    assert.equal(
      third.reply,
      "未能完整取得公开视频的音频和画面，本次没有调用转写、AI 或 Writer，也没有确认任何写入；请重新发送同一链接。"
    );
    assert.deepEqual(failures,[
      "public_video_source:bilibili_media_unavailable",
      "public_video_source:bilibili_audio_hash_mismatch",
      "public_video_source_preparation_failed"
    ]);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

function deferred() {
  let resolve;
  const promise=new Promise(done=>{resolve=done;});
  return {promise,resolve};
}
