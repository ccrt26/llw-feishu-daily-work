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

test("serializes both entries and rejects unbound or duplicate input before AI",async()=>{
  const handled=[];
  let active=0,maxActive=0;
  const dispatcher=new PersonalAssistantDispatcher({
    binding:{senderId:"owner",chatId:"private"},
    bindings:{
      feishu:{userId:"owner",conversationId:"private"},
      wechat:{userId:"wx-owner",conversationId:"wx-owner"}
    },
    state:{hasOutcome:key=>key==="feishu:duplicate"},
    coordinator:{async handle(message){
      active+=1;maxActive=Math.max(maxActive,active);
      await new Promise(resolve=>setImmediate(resolve));
      handled.push(message.sourceMessageId);
      active-=1;
      return {status:"committed"};
    }},
    modelMode:{},deepseekEnabled:false,messenger:{async send(){}}
  });
  const results=await Promise.all([
    dispatcher.handleIncomingMessage(incoming({sourceMessageId:"a"})),
    dispatcher.handleIncomingMessage(incoming({sourceMessageId:"b"}))
  ]);
  assert.equal(maxActive,1);
  assert.deepEqual(handled,["a","b"]);
  assert.deepEqual(results.map(value=>value.handled),[true,true]);
  assert.deepEqual(
    await dispatcher.handleIncomingMessage(incoming({
      sourceMessageId:"bad",userId:"other"
    })),
    {handled:false,reason:"sender_not_allowed"}
  );
  assert.deepEqual(
    await dispatcher.handleIncomingMessage(incoming({
      sourceMessageId:"duplicate"
    })),
    {handled:false,reason:"duplicate"}
  );
});

test("accepts an attachment with empty instructionText",async()=>{
  let calls=0;
  const dispatcher=new PersonalAssistantDispatcher({
    binding:{senderId:"owner",chatId:"private"},
    bindings:{feishu:{userId:"owner",conversationId:"private"}},
    state:{hasOutcome:()=>false},
    coordinator:{async handle(){calls+=1;return {status:"committed"};}},
    modelMode:{},deepseekEnabled:false,messenger:{async send(){}}
  });
  const result=await dispatcher.handleIncomingMessage(incoming({
    instructionText:"",
    attachments:[{
      type:"file",sourceAttachmentId:"file_1",
      displayName:"材料.pdf",extension:"pdf"
    }]
  }));
  assert.equal(result.handled,true);
  assert.equal(calls,1);
});

test("rejects a declared audio or video file before AI and Writer with a specific reply",async()=>{
  const saved=[],sent=[];
  let coordinatorCalls=0;
  const dispatcher=new PersonalAssistantDispatcher({
    binding:{senderId:"owner",chatId:"private"},
    bindings:{feishu:{userId:"owner",conversationId:"private"}},
    state:{
      hasOutcome:()=>false,
      async saveOutcome(key,outcome){saved.push({key,outcome});},
      async markReplied(key){saved.push({marked:key});}
    },
    coordinator:{async handle(){
      coordinatorCalls+=1;
      return {status:"committed"};
    }},
    modelMode:{},deepseekEnabled:false,
    messenger:{async send(value){sent.push(value);}},
    coalesceWindowMs:25
  });
  assert.deepEqual(
    await dispatcher.acceptIncomingMessage(incoming({
      sourceMessageId:"audio-1",instructionText:"",
      attachments:[{
        type:"file",sourceAttachmentId:"file_audio",
        displayName:"LLW_V401_UNSUPPORTED_AUDIO.aiff",extension:"aiff"
      }]
    })),
    {handled:true,status:"rejected"}
  );
  await dispatcher.flushAcceptedMessages();
  assert.equal(coordinatorCalls,0);
  assert.equal(saved[0].key,"feishu:audio-1");
  assert.equal(saved[0].outcome.status,"rejected");
  assert.equal(saved[0].outcome.reasonCode,"audio_file_disabled");
  assert.match(saved[0].outcome.reply,/尚未支持音频或视频/u);
  assert.match(saved[0].outcome.reply,/没有调用 AI 或 Writer/u);
  assert.equal(saved[0].outcome.artifacts.length,0);
  assert.equal(sent.length,1);
  assert.deepEqual(saved[1],{marked:"feishu:audio-1"});
});

test("persists and reports only a bounded failure code before replying",async()=>{
  const saved=[],sent=[],failures=[];
  const dispatcher=new PersonalAssistantDispatcher({
    binding:{senderId:"owner",chatId:"private"},
    bindings:{feishu:{userId:"owner",conversationId:"private"}},
    state:{
      hasOutcome:()=>false,
      async saveOutcome(key,outcome){saved.push({key,outcome});},
      async markReplied(key){saved.push({marked:key});}
    },
    coordinator:{async handle(){throw new Error("private_provider_detail");}},
    modelMode:{},deepseekEnabled:false,
    messenger:{async send(value){sent.push(value);}},
    onFailure:code=>failures.push(code)
  });
  const result=await dispatcher.handleIncomingMessage(incoming());
  assert.deepEqual(result,{handled:true,status:"failed"});
  assert.equal(saved[0].key,"feishu:m1");
  assert.equal(saved[0].outcome.status,"failed");
  assert.equal(saved[0].outcome.reasonCode,"tool_execution_failed");
  assert.equal(saved[0].outcome.reply.includes("private_provider_detail"),false);
  assert.deepEqual(failures,["tool_execution_failed"]);
  assert.equal(sent.length,1);
  assert.equal(sent[0].idempotencyKey,"reply:feishu:m1");
  assert.deepEqual(saved[1],{marked:"feishu:m1"});
});

test("keeps a controlled provider failure code in Outcome and diagnostics",async()=>{
  const saved=[],failures=[];
  const dispatcher=new PersonalAssistantDispatcher({
    binding:{senderId:"owner",chatId:"private"},
    bindings:{feishu:{userId:"owner",conversationId:"private"}},
    state:{
      hasOutcome:()=>false,
      async saveOutcome(key,outcome){saved.push({key,outcome});},
      async markReplied(){}
    },
    coordinator:{async handle(){throw new Error("assistant_model_failed");}},
    modelMode:{},deepseekEnabled:false,
    messenger:{async send(){}},
    onFailure:code=>failures.push(code)
  });
  await dispatcher.handleIncomingMessage(incoming());
  assert.equal(saved[0].outcome.reasonCode,"assistant_model_failed");
  assert.deepEqual(failures,["assistant_model_failed"]);
});

test("preserves precise pre-Writer failures through one WeChat turn",async()=>{
  const replies=new Map([
    [
      "assistant_timeout",
      "AI 分析超过当前时间上限，本次没有确认任何写入；来源仍在当前任务中，可以直接重试。"
    ],
    [
      "assistant_process_failed",
      "AI 进程本次未能正常完成，本次没有确认任何写入；来源仍在当前任务中，可以直接重试。"
    ],
    [
      "assistant_result_invalid",
      "AI 返回结果未通过安全校验，本次没有确认任何写入；来源仍在当前任务中，可以直接重试。"
    ],
    [
      "pdf_prepare_failed",
      "PDF 已安全保留，但页面准备失败，本次没有完成分析，也没有确认任何写入；可以直接重试，不需要重新发送文件。"
    ]
  ]);
  for (const [code,expectedReply] of replies) {
    const saved=[],sent=[],failures=[];
    let writerCalls=0;
    const outcomeStore={
      async get(){return null;},
      async save(){throw new Error("unexpected_outcome_save");}
    };
    const coordinator=new PersonalAssistantCoordinator({
      prepareSource:code==="pdf_prepare_failed"
        ?async()=>{throw new Error(code);}
        :async()=>({sources:[],workspaceDir:"/private/tmp"}),
      assistant:{
        async decide(){throw new Error(code);}
      },
      writer:{
        async commit(){writerCalls+=1;}
      },
      dailyWriter:{
        async write(){writerCalls+=1;}
      },
      invoiceWriter:{
        async commit(){writerCalls+=1;}
      },
      documentWorkspace:{},
      artifactGenerator:async()=>{writerCalls+=1;},
      outcomeStore,
      messenger:{async send(){throw new Error("unexpected_coordinator_send");}},
      personalRules:[],
      model:"codex",
      skillVersion:"4.1.0"
    });
    const dispatcher=new PersonalAssistantDispatcher({
      binding:{senderId:"owner",chatId:"private"},
      bindings:{
        feishu:{userId:"owner",conversationId:"private"},
        wechat:{userId:"wx-owner",conversationId:"wx-owner"}
      },
      state:{
        hasOutcome:()=>false,
        async saveOutcome(key,outcome){saved.push({key,outcome});},
        async markReplied(key){saved.push({marked:key});}
      },
      coordinator,
      modelMode:{},deepseekEnabled:false,
      messenger:{async send(value){sent.push(value);}},
      onFailure:value=>failures.push(value)
    });
    const result=await dispatcher.handleIncomingMessage(incoming({
      source:"wechat",
      sourceMessageId:`wx-${code}`,
      userId:"wx-owner",
      conversationId:"wx-owner",
      replyTarget:{
        source:"wechat",
        sourceMessageId:`wx-${code}`,
        conversationId:"wx-owner",
        contextToken:"wechat-context"
      }
    }));
    assert.deepEqual(result,{handled:true,status:"failed"});
    assert.equal(saved[0].outcome.reasonCode,code);
    assert.equal(saved[0].outcome.reply,expectedReply);
    assert.deepEqual(failures,[code]);
    assert.equal(writerCalls,0);
    assert.equal(sent.length,1);
  }
});

test("reports only a bounded coordinator phase for unknown internal errors",async()=>{
  const saved=[],failures=[];
  const dispatcher=new PersonalAssistantDispatcher({
    binding:{senderId:"owner",chatId:"private"},
    bindings:{feishu:{userId:"owner",conversationId:"private"}},
    state:{
      hasOutcome:()=>false,
      async saveOutcome(_key,outcome){saved.push(outcome);},
      async markReplied(){}
    },
    coordinator:{async handle(){
      const error=new Error("private_writer_detail");
      error.failurePhase="save_knowledge_execution_failed";
      throw error;
    }},
    modelMode:{},deepseekEnabled:false,
    messenger:{async send(){}},
    onFailure:code=>failures.push(code)
  });
  await dispatcher.handleIncomingMessage(incoming());
  assert.equal(
    saved[0].reasonCode,
    "save_knowledge_execution_failed"
  );
  assert.deepEqual(failures,["save_knowledge_execution_failed"]);
});

test("reports a bounded public-video preparation failure without provider detail",async()=>{
  const saved=[],sent=[],failures=[];
  const dispatcher=new PersonalAssistantDispatcher({
    binding:{senderId:"owner",chatId:"private"},
    bindings:{feishu:{userId:"owner",conversationId:"private"}},
    state:{
      hasOutcome:()=>false,
      async saveOutcome(_key,outcome){saved.push(outcome);},
      async markReplied(){}
    },
    coordinator:{async handle(){
      const error=new Error("private_provider_response");
      error.failurePhase="public_video_prepare_failed";
      throw error;
    }},
    modelMode:{},deepseekEnabled:false,
    messenger:{async send(value){sent.push(value);}},
    onFailure:code=>failures.push(code)
  });
  await dispatcher.handleIncomingMessage(incoming());
  assert.equal(saved[0].reasonCode,"public_video_prepare_failed");
  assert.equal(
    saved[0].reply,
    "公开视频来源已保留，但音频转写或画面准备失败，本次没有完成分析，也没有确认任何写入；可以直接重试。"
  );
  assert.equal(saved[0].reply.includes("private_provider_response"),false);
  assert.deepEqual(failures,["public_video_prepare_failed"]);
  assert.equal(sent.length,1);
});

test("prefers a bounded phase over a generic error message",async()=>{
  const saved=[],failures=[];
  const dispatcher=new PersonalAssistantDispatcher({
    binding:{senderId:"owner",chatId:"private"},
    bindings:{feishu:{userId:"owner",conversationId:"private"}},
    state:{
      hasOutcome:()=>false,
      async saveOutcome(_key,outcome){saved.push(outcome);},
      async markReplied(){}
    },
    coordinator:{async handle(){
      const error=new Error("tool_execution_failed");
      error.failurePhase="assistant_model_failed";
      throw error;
    }},
    modelMode:{},deepseekEnabled:false,
    messenger:{async send(){}},
    onFailure:code=>failures.push(code)
  });
  await dispatcher.handleIncomingMessage(incoming());
  assert.equal(saved[0].reasonCode,"assistant_model_failed");
  assert.deepEqual(failures,["assistant_model_failed"]);
});

test("coalesces an attachment-first split turn into one assistant task and one reply target",async()=>{
  const handled=[],saved=[];
  const dispatcher=new PersonalAssistantDispatcher({
    binding:{senderId:"owner",chatId:"private"},
    bindings:{feishu:{userId:"owner",conversationId:"private"}},
    state:{
      hasOutcome:()=>false,
      async saveOutcome(key,outcome){saved.push({key,outcome});}
    },
    coordinator:{
      async handle(message){
        handled.push(structuredClone(message));
        return {status:"committed"};
      }
    },
    modelMode:{},deepseekEnabled:false,messenger:{async send(){}},
    coalesceWindowMs:25
  });
  await dispatcher.acceptIncomingMessage(incoming({
    sourceMessageId:"file-1",receivedAt:"2026-07-28T00:00:00.000Z",
    instructionText:"",
    attachments:[{
      type:"file",sourceAttachmentId:"file_1",
      displayName:"材料.pdf",extension:"pdf"
    }],
    replyTarget:{
      source:"feishu",sourceMessageId:"file-1",conversationId:"private"
    }
  }));
  await dispatcher.acceptIncomingMessage(incoming({
    sourceMessageId:"text-2",receivedAt:"2026-07-28T00:00:01.000Z",
    instructionText:"概括这份 PDF，不保存",
    replyTarget:{
      source:"feishu",sourceMessageId:"text-2",conversationId:"private"
    }
  }));
  await dispatcher.flushAcceptedMessages();
  assert.equal(handled.length,1);
  assert.equal(handled[0].sourceMessageId,"file-1");
  assert.equal(handled[0].instructionText,"概括这份 PDF，不保存");
  assert.equal(handled[0].attachments[0].sourceAttachmentId,"file_1");
  assert.equal(handled[0].replyTarget.sourceMessageId,"text-2");
  assert.equal(saved.length,1);
  assert.equal(saved[0].key,"feishu:text-2");
  assert.equal(saved[0].outcome.reasonCode,"coalesced_into_turn");
  assert.equal(saved[0].outcome.noReplyRequired,true);
});

test("coalesces a text-first split turn and does not cross entry boundaries",async()=>{
  const handled=[];
  const dispatcher=new PersonalAssistantDispatcher({
    binding:{senderId:"owner",chatId:"private"},
    bindings:{
      feishu:{userId:"owner",conversationId:"private"},
      wechat:{userId:"wx-owner",conversationId:"wx-owner"}
    },
    state:{hasOutcome:()=>false,async saveOutcome(){}},
    coordinator:{
      async handle(message){
        handled.push(structuredClone(message));
        return {status:"committed"};
      }
    },
    modelMode:{},deepseekEnabled:false,messenger:{async send(){}},
    coalesceWindowMs:25
  });
  await dispatcher.acceptIncomingMessage(incoming({
    sourceMessageId:"text-1",
    instructionText:"整理后保存到日常生活"
  }));
  await dispatcher.acceptIncomingMessage(incoming({
    source:"wechat",sourceMessageId:"wx-text-1",
    userId:"wx-owner",conversationId:"wx-owner",
    receivedAt:"2026-07-28T00:00:00.000Z",
    instructionText:"只概括，不保存",attachments:[],
    replyTarget:{
      source:"wechat",sourceMessageId:"wx-text-1",
      conversationId:"wx-owner",contextToken:"ctx"
    }
  }));
  await dispatcher.acceptIncomingMessage(incoming({
    sourceMessageId:"file-2",receivedAt:"2026-07-28T00:00:01.000Z",
    instructionText:"",
    attachments:[{
      type:"file",sourceAttachmentId:"file_2",
      displayName:"材料.docx",extension:"docx"
    }],
    replyTarget:{
      source:"feishu",sourceMessageId:"file-2",conversationId:"private"
    }
  }));
  await dispatcher.acceptIncomingMessage(incoming({
    source:"wechat",sourceMessageId:"wx-file-2",
    userId:"wx-owner",conversationId:"wx-owner",
    receivedAt:"2026-07-28T00:00:01.000Z",instructionText:"",
    attachments:[{
      type:"file",sourceAttachmentId:"wxr_1",
      displayName:"材料.pdf",extension:"pdf"
    }],
    replyTarget:{
      source:"wechat",sourceMessageId:"wx-file-2",
      conversationId:"wx-owner",contextToken:"ctx"
    }
  }));
  await dispatcher.flushAcceptedMessages();
  assert.equal(handled.length,2);
  const feishu=handled.find(message=>message.source==="feishu");
  const wechat=handled.find(message=>message.source==="wechat");
  assert.equal(feishu.sourceMessageId,"text-1");
  assert.equal(feishu.instructionText,"整理后保存到日常生活");
  assert.equal(wechat.sourceMessageId,"wx-text-1");
  assert.equal(wechat.instructionText,"只概括，不保存");
});

test("cancels a held source burst without sending it to the assistant",async()=>{
  const saved=[],handled=[];
  const dispatcher=new PersonalAssistantDispatcher({
    binding:{senderId:"owner",chatId:"private"},
    bindings:{feishu:{userId:"owner",conversationId:"private"}},
    state:{
      hasOutcome:()=>false,
      async saveOutcome(key,outcome){saved.push({key,outcome});}
    },
    coordinator:{
      async handle(message){
        handled.push(message.sourceMessageId);
        return {status:"ignored"};
      }
    },
    modelMode:{},deepseekEnabled:false,messenger:{async send(){}},
    coalesceWindowMs:25
  });
  await dispatcher.acceptIncomingMessage(incoming({
    sourceMessageId:"file-held",instructionText:"",
    attachments:[{
      type:"file",sourceAttachmentId:"file-held",
      displayName:"材料.docx",extension:"docx"
    }]
  }));
  await dispatcher.acceptIncomingMessage(incoming({
    sourceMessageId:"cancel",instructionText:"不用了，取消"
  }));
  await dispatcher.flushAcceptedMessages();
  assert.deepEqual(handled,["cancel"]);
  assert.equal(saved.length,1);
  assert.equal(saved[0].key,"feishu:file-held");
  assert.equal(saved[0].outcome.reasonCode,"cancelled");
});

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
    coalesceWindowMs:5
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

function deferred() {
  let resolve;
  const promise=new Promise(done=>{resolve=done;});
  return {promise,resolve};
}
