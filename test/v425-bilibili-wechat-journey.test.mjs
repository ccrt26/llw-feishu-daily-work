import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {
  chmod,mkdtemp,rm,writeFile
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
  TaskPublicVideoReader
} from "../src/personal-assistant/task-public-video-reader.mjs";
import {
  TaskSourceWorkspace
} from "../src/personal-assistant/task-source-workspace.mjs";
import {StateStore} from "../src/state-store.mjs";

test("a WeChat typed Bilibili link reaches one assistant and reuses durable evidence",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v425-bili-journey-"));
  const firstTime=Date.parse("2026-07-30T07:00:00.000Z");
  let nowMs=firstTime;
  let siteCalls=0,asrCalls=0,timelineCalls=0,writerCalls=0;
  try {
    await chmod(root,0o700);
    const audioBytes=Buffer.from("0000ftypM4A WeChat journey audio");
    const videoBytes=Buffer.from("0000ftypmp42 WeChat journey video");
    const bilibiliAdapter={
      async prepare({workspaceDir}) {
        siteCalls+=1;
        const audioFile=join(workspaceDir,"bilibili-audio.m4a");
        const videoFile=join(workspaceDir,"bilibili-video.mp4");
        await writeFile(audioFile,audioBytes,{mode:0o600});
        await writeFile(videoFile,videoBytes,{mode:0o600});
        return {
          platform:"bilibili",
          mediaId:"BV1Synthetic",
          canonicalUrl:"https://www.bilibili.com/video/BV1Synthetic/",
          durationMs:20_000,
          audio:{
            file:audioFile,byteSize:audioBytes.length,
            sha256:sha(audioBytes),format:"m4a",
            detectedMime:"audio/mp4"
          },
          video:{
            file:videoFile,byteSize:videoBytes.length,
            sha256:sha(videoBytes),format:"mp4",
            detectedMime:"video/mp4"
          },
          limitations:[]
        };
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
      basePreparer,publicVideoSourcePreparer:publicPreparer
    });
    const state=await StateStore.open(join(root,"state.json"));
    const bindings={
      feishu:{userId:"owner",conversationId:"private-chat"},
      wechat:{userId:"wx-owner",conversationId:"wx-owner"}
    };
    const taskManager=new PersonalAssistantTaskSessionManager({
      state,bindings,selectModel:async()=>"codex",
      createId:()=>"V".repeat(43),now:()=>nowMs
    });
    const taskWorkspace=new TaskSourceWorkspace({
      root:join(root,"task-sources"),prepareTurnSources
    });
    const publicVideoReader=new TaskPublicVideoReader({
      asr:{
        async transcribe({audioSha256}) {
          asrCalls+=1;
          return {
            providerId:"volcengine",apiVersion:"v3",
            resourceId:"volc.bigasr.auc",
            requestProfile:"recording_file_standard_base64_m4a_v1",
            audioSha256,
            originalDurationMs:20_000,
            providerDurationMs:20_000,
            segments:[{
              startMs:0,endMs:20_000,
              text:"声音中说到了真实经营数据。",
              alternatives:[],isFinal:true,status:"recognized"
            }],
            coveredRanges:[{startMs:0,endMs:20_000}],
            uncoveredRanges:[],
            coverageStatus:"complete",
            limitations:[
              "provider_utterance_timestamps_not_word_exact"
            ]
          };
        }
      },
      timelineReader:{
        async read(input) {
          timelineCalls+=1;
          const bytes=pngHeader(320,180);
          const relativePath=
            `${input.sourceId}.timeline-001.png`;
          await writeFile(
            join(input.workspaceDir,relativePath),
            bytes,{mode:0o600}
          );
          return {
            durationMs:20_000,sampleCount:2,maxGapMs:10_000,
            samples:[
              {startMs:0,endMs:10_000,sampleMs:5_000},
              {startMs:10_000,endMs:20_000,sampleMs:15_000}
            ],
            images:[{
              sourceId:input.sourceId,relativePath,
              sha256:sha(bytes),startMs:0,endMs:20_000
            }],
            limitations:[
              "uniform_timeline_sampling","not_frame_by_frame"
            ]
          };
        }
      }
    });
    const decisions=[];
    const assistant=new PersonalAssistantClient({
      codex:async(context,options)=>{
        decisions.push(structuredClone(context));
        assert.equal(context.entry,"wechat");
        assert.equal(context.sources[0].mediaClass,"video");
        assert.equal(context.sourceObservations.length,1);
        assert.equal(options.modelImageFiles.length,1);
        const evidence=JSON.parse(
          context.sourceObservations[0].content
        );
        assert.match(
          evidence.transcript.segments[0].text,/经营数据/u
        );
        assert.equal(
          evidence.visualTimeline.coverageStatus,"complete"
        );
        return {
          type:"reply",
          text:decisions.length===1
            ?"已结合完整音频转写和全时间线画面完成总结；没有保存。"
            :"补充说明：画面是全时间线均匀取样，不是逐帧查看；没有保存。"
        };
      },
      deepseek:async()=>{throw new Error("unexpected_model");}
    });
    const sent=[];
    const messenger={
      async send(value){sent.push(structuredClone(value));}
    };
    const coordinator=new PersonalAssistantCoordinator({
      prepareSource:prepareTurnSources,
      assistant,
      writer:{async commit(){writerCalls+=1;}},
      dailyWriter:{async write(){writerCalls+=1;}},
      invoiceWriter:{async commit(){writerCalls+=1;}},
      outcomeStore:{
        get:key=>state.getOutcome(key),
        markReplied:key=>state.markReplied(key)
      },
      messenger,personalRules:[],model:"codex",
      skillVersion:"4.1.0",
      taskManager,taskWorkspace,publicVideoReader
    });
    const dispatcher=new PersonalAssistantDispatcher({
      binding:{senderId:"owner",chatId:"private-chat"},
      bindings,state,coordinator,
      modelMode:{async read(){return "codex";}},
      deepseekEnabled:false,messenger,
      taskManager,taskWorkspace,now:()=>nowMs,
      mediaInputGates:{
        nativeVoiceEnabled:false,audioFileEnabled:false,
        localVideoEnabled:false,webPageEnabled:false,
        bilibiliEnabled:true,douyinEnabled:false
      }
    });

    const first=await dispatcher.handleIncomingMessage(
      createWechatIncomingMessage({
        messageId:"wechat-bili-1",
        userId:"wx-owner",conversationId:"wx-owner",
        createTimeMs:firstTime,type:"text",
        contextToken:"ctx-bili-1",
        text:"总结 https://b23.tv/Mn2sUpl，不保存"
      })
    );
    assert.equal(first.status,"committed");
    assert.equal(siteCalls,1);
    assert.equal(asrCalls,1);
    assert.equal(timelineCalls,1);
    assert.equal(writerCalls,0);
    assert.equal(sent[0].replyTarget.source,"wechat");

    nowMs=firstTime+20_000;
    const second=await dispatcher.handleIncomingMessage(
      createWechatIncomingMessage({
        messageId:"wechat-bili-2",
        userId:"wx-owner",conversationId:"wx-owner",
        createTimeMs:nowMs,type:"text",
        contextToken:"ctx-bili-2",
        text:"再说明画面理解的限制，不保存"
      })
    );
    assert.equal(second.status,"committed");
    assert.equal(taskManager.current("wechat").taskId,"V".repeat(43));
    assert.equal(siteCalls,1);
    assert.equal(asrCalls,1);
    assert.equal(timelineCalls,1);
    assert.equal(writerCalls,0);
    assert.equal(decisions.length,2);
    assert.equal(sent.length,2);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

function pngHeader(width,height) {
  const value=Buffer.alloc(24);
  Buffer.from([
    0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a
  ]).copy(value,0);
  value.writeUInt32BE(13,8);
  value.write("IHDR",12,"ascii");
  value.writeUInt32BE(width,16);
  value.writeUInt32BE(height,20);
  return value;
}

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}
