import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,mkdtemp,readdir,rm
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  createWechatIncomingMessage
} from "../src/core/incoming-message.mjs";
import {
  PersonalAssistantClient
} from "../src/personal-assistant/client.mjs";
import {
  PersonalAssistantCoordinator
} from "../src/personal-assistant/coordinator.mjs";
import {
  PersonalAssistantDispatcher
} from "../src/personal-assistant/dispatcher.mjs";
import {
  createPublicVideoSourcePreparer,
  createTurnSourcePreparerWithPublicVideo
} from "../src/personal-assistant/public-video-source-preparer.mjs";
import {
  createAssistantSourcePreparer
} from "../src/personal-assistant/source-preparer.mjs";
import {
  PersonalAssistantTaskSessionManager
} from "../src/personal-assistant/task-session-manager.mjs";
import {
  TaskSourceWorkspace
} from "../src/personal-assistant/task-source-workspace.mjs";
import {StateStore} from "../src/state-store.mjs";

const TASK_ID="C".repeat(43);
const FAILURE_REPLY=
  "本次无法访问 B 站视频来源（可能是网络或站点临时拒绝），所以没有调用转写、AI 或 Writer，也没有写入。需要时请重新发送同一链接。";

test("WeChat cancellation stops the only Bilibili source attempt",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v443-cancel-source-"));
  const firstStarted=deferred();
  const releaseFirst=deferred();
  const signals=[];
  try {
    const journey=await createFailureJourney({
      root,
      prepare:async({signal},call)=>{
        signals.push(signal);
        if (call===1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        throw new Error("bilibili_media_unavailable");
      }
    });
    const running=journey.dispatcher.handleTaskIncomingMessage(
      incoming("wechat-cancel-retry")
    );
    await firstStarted.promise;
    await journey.coordinator.cancelTaskWork({taskId:TASK_ID});
    releaseFirst.resolve();
    await running;

    assert.equal(journey.counts.site,1);
    assert.equal(signals.length,1);
    assert.ok(signals[0] instanceof AbortSignal);
    assert.equal(signals[0].aborted,true);
    assert.deepEqual(journey.downstream(),{
      reader:0,assistant:0,writer:0
    });
    assert.deepEqual(await publicVideoStaging(root),[]);
  } finally {
    releaseFirst.resolve();
    await rm(root,{recursive:true,force:true});
  }
});

test("WeChat uses one Bilibili attempt and reports a safe access reason",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v443-single-attempt-"));
  try {
    const journey=await createFailureJourney({
      root,
      prepare:async()=>{
        throw new Error("bilibili_access_denied");
      }
    });
    const result=await journey.dispatcher.handleTaskIncomingMessage(
      incoming("wechat-single-attempt")
    );

    assert.equal(result.status,"failed");
    assert.equal(journey.counts.site,1);
    assert.deepEqual(journey.downstream(),{
      reader:0,assistant:0,writer:0
    });
    assert.deepEqual(journey.failures,[
      "public_video_source:bilibili_access_denied"
    ]);
    const outcome=journey.state.getOutcome(
      "wechat:wechat-single-attempt"
    );
    assert.equal(
      outcome.reasonCode,
      "public_video_source_preparation_failed"
    );
    assert.equal(outcome.reply,FAILURE_REPLY);
    assert.equal(journey.sent.length,1);
    assert.equal(journey.sent[0].text,FAILURE_REPLY);
    assert.deepEqual(await publicVideoStaging(root),[]);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

async function createFailureJourney({root,prepare}) {
  await chmod(root,0o700);
  const counts={site:0,reader:0,assistant:0,writer:0};
  const bilibiliAdapter={
    async prepare(input) {
      counts.site+=1;
      return prepare(input,counts.site);
    }
  };
  const basePreparer=createAssistantSourcePreparer({
    tempRoot:join(root,"turn-intake"),
    download:async()=>{throw new Error("unexpected_download");}
  });
  const publicPreparer=createPublicVideoSourcePreparer({
    tempRoot:join(root,"public-intake"),
    bilibiliAdapter,
    douyinAdapter:{async prepare(){throw new Error("unexpected");}}
  });
  const prepareTurnSources=createTurnSourcePreparerWithPublicVideo({
    basePreparer,
    publicVideoSourcePreparer:publicPreparer
  });
  const state=await StateStore.open(join(root,"state.json"));
  const bindings={
    feishu:{userId:"owner",conversationId:"private-chat"},
    wechat:{userId:"wx-owner",conversationId:"wx-owner"}
  };
  const nowMs=Date.parse("2026-08-01T08:00:00.000Z");
  const taskManager=new PersonalAssistantTaskSessionManager({
    state,bindings,selectModel:async()=>"codex",
    createId:()=>TASK_ID,now:()=>nowMs
  });
  const taskWorkspace=new TaskSourceWorkspace({
    root:join(root,"task-sources"),prepareTurnSources
  });
  const assistant=new PersonalAssistantClient({
    codex:async()=>{
      counts.assistant+=1;
      throw new Error("unexpected_assistant");
    },
    deepseek:async()=>{throw new Error("unexpected_model");}
  });
  const sent=[];
  const messenger={
    async send(value) {sent.push(structuredClone(value));}
  };
  const writer={async commit(){counts.writer+=1;}};
  const coordinator=new PersonalAssistantCoordinator({
    prepareSource:prepareTurnSources,
    assistant,writer,
    dailyWriter:{async write(){counts.writer+=1;}},
    invoiceWriter:{async commit(){counts.writer+=1;}},
    outcomeStore:{
      get:key=>state.getOutcome(key),
      markReplied:key=>state.markReplied(key)
    },
    messenger,personalRules:[],model:"codex",skillVersion:"4.4.0",
    taskManager,taskWorkspace,
    publicVideoReader:{
      async prepare() {
        counts.reader+=1;
        throw new Error("unexpected_public_video_reader");
      }
    }
  });
  const failures=[];
  const dispatcher=new PersonalAssistantDispatcher({
    binding:{senderId:"owner",chatId:"private-chat"},
    bindings,state,coordinator,
    modelMode:{async read(){return "codex";}},
    deepseekEnabled:false,messenger,taskManager,taskWorkspace,
    onFailure:code=>failures.push(code),now:()=>nowMs,
    mediaInputGates:{
      nativeVoiceEnabled:false,audioFileEnabled:false,
      localVideoEnabled:false,webPageEnabled:false,
      bilibiliEnabled:true,douyinEnabled:false
    }
  });
  return {
    coordinator,dispatcher,state,sent,failures,counts,
    downstream:()=>({
      reader:counts.reader,
      assistant:counts.assistant,
      writer:counts.writer
    })
  };
}

function incoming(messageId) {
  return createWechatIncomingMessage({
    messageId,userId:"wx-owner",conversationId:"wx-owner",
    createTimeMs:Date.parse("2026-08-01T08:00:00.000Z"),
    type:"text",contextToken:`ctx-${messageId}`,
    text:"请总结 https://www.bilibili.com/video/BV1AbCdEfGhJ/ 不保存"
  });
}

async function publicVideoStaging(root) {
  try {
    return (await readdir(join(root,"public-intake")))
      .filter(name=>name.startsWith("llw-public-video-"));
  } catch (error) {
    if (error?.code==="ENOENT") return [];
    throw error;
  }
}

function deferred() {
  let resolve;
  const promise=new Promise(done=>{resolve=done;});
  return {promise,resolve};
}
