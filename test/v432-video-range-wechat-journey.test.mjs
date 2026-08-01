import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {
  chmod,mkdtemp,readFile,rm,writeFile
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
  SourceReader
} from "../src/personal-assistant/source-reader.mjs";
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

test("WeChat mobile Bilibili navigation receives one real interval before replying",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v432-range-journey-"));
  const nowMs=Date.parse("2026-07-31T02:00:00.000Z");
  let siteCalls=0,asrCalls=0,timelineCalls=0;
  let rangeCalls=0,writerCalls=0;
  try {
    await chmod(root,0o700);
    const audioBytes=Buffer.from("0000ftypM4A range journey audio");
    const videoBytes=Buffer.from("0000ftypmp42 range journey video");
    const bilibiliAdapter={
      async prepare({workspaceDir,url}) {
        siteCalls+=1;
        assert.equal(
          url,
          "https://www.bilibili.com/video/BV1AbCdEfGhJ/"
        );
        const audioFile=join(workspaceDir,"bilibili-audio.m4a");
        const videoFile=join(workspaceDir,"bilibili-video.mp4");
        await Promise.all([
          writeFile(audioFile,audioBytes,{mode:0o600}),
          writeFile(videoFile,videoBytes,{mode:0o600})
        ]);
        return {
          platform:"bilibili",
          mediaId:"BV1RangeSynthetic",
          canonicalUrl:
            "https://www.bilibili.com/video/BV1RangeSynthetic/",
          durationMs:20_000,
          audio:{
            file:audioFile,
            byteSize:audioBytes.length,
            sha256:sha(audioBytes),
            format:"m4a",
            detectedMime:"audio/mp4"
          },
          video:{
            file:videoFile,
            byteSize:videoBytes.length,
            sha256:sha(videoBytes),
            format:"mp4",
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
      basePreparer,
      publicVideoSourcePreparer:publicPreparer
    });
    const state=await StateStore.open(join(root,"state.json"));
    const bindings={
      feishu:{userId:"owner",conversationId:"private-chat"},
      wechat:{userId:"wx-owner",conversationId:"wx-owner"}
    };
    const taskManager=new PersonalAssistantTaskSessionManager({
      state,bindings,selectModel:async()=>"codex",
      createId:()=>"R".repeat(43),now:()=>nowMs
    });
    const taskWorkspace=new TaskSourceWorkspace({
      root:join(root,"task-sources"),
      prepareTurnSources
    });
    const publicVideoReader=new TaskPublicVideoReader({
      asr:{
        async transcribe({audioSha256,onProcessingAccepted}) {
          asrCalls+=1;
          await onProcessingAccepted();
          return {
            providerId:"volcengine",
            apiVersion:"v3",
            resourceId:"volc.bigasr.auc",
            requestProfile:"recording_file_standard_base64_m4a_v1",
            audioSha256,
            originalDurationMs:20_000,
            providerDurationMs:20_000,
            segments:[{
              startMs:0,
              endMs:10_000,
              text:"声音说明第六秒附近出现关键数字。",
              alternatives:[],
              isFinal:true,
              status:"recognized"
            }],
            coveredRanges:[{startMs:0,endMs:10_000}],
            uncoveredRanges:[{startMs:10_000,endMs:20_000}],
            coverageStatus:"partial",
            limitations:[
              "speech_coverage_partial"
            ]
          };
        }
      },
      timelineReader:{
        async read(input) {
          timelineCalls+=1;
          return publishImageEvidence({
            ...input,
            relativePath:`${input.sourceId}.timeline-001.png`,
            startMs:0,
            endMs:20_000,
            limitations:[
              "uniform_timeline_sampling","not_frame_by_frame"
            ]
          });
        },
        async readRange(input) {
          rangeCalls+=1;
          return publishImageEvidence({
            ...input,
            relativePath:[
              `${input.sourceId}.inspect`,
              `${input.startMs}`,
              `${input.endMs}.png`
            ].join("-"),
            startMs:input.startMs,
            endMs:input.endMs,
            limitations:[
              "uniform_range_sampling","not_frame_by_frame"
            ]
          });
        }
      },
      clock:()=>"2026-07-31T02:00:01.000Z"
    });
    const sourceReader=new SourceReader({
      backends:{
        inspect_time_range:input=>
          publicVideoReader.inspectTimeRange(input)
      },
      maxRequests:1,
      maxRangeMs:60_000,
      maxTotalRangeMs:60_000,
      maxModelImageFiles:1
    });
    const decisions=[];
    const assistant=new PersonalAssistantClient({
      codex:async(context,options)=>{
        decisions.push({
          context:structuredClone(context),
          options:structuredClone(options)
        });
        assert.equal(context.entry,"wechat");
        assert.equal(options.allowSourceRead,true);
        if (decisions.length===1) {
          assert.equal(context.sourceObservations.length,1);
          assert.equal(options.modelImageFiles.length,1);
          const initial=JSON.parse(
            context.sourceObservations[0].content
          );
          assert.equal(
            initial.transcript.coverageStatus,
            "partial"
          );
          assert.deepEqual(
            initial.transcript.uncoveredRanges,
            [{startMs:10_000,endMs:20_000}]
          );
          return {
            type:"source_read_request",
            requests:[{
              sourceId:"source-001",
              view:"inspect_time_range",
              startMs:5_000,
              endMs:7_000
            }]
          };
        }
        assert.equal(context.sourceObservations.length,2);
        assert.equal(options.modelImageFiles.length,2);
        const interval=JSON.parse(
          context.sourceObservations[1].content
        );
        assert.equal(interval.kind,"public_video_interval");
        assert.equal(interval.startMs,5_000);
        assert.equal(interval.endMs,7_000);
        assert.equal(
          options.modelImageFiles[1].relativePath,
          "source-001.inspect-5000-7000.png"
        );
        return {
          type:"reply",
          text:"已核对 5–7 秒真实画面，关键数字为 42；本次没有保存。"
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
      messenger,
      personalRules:[],
      model:"codex",
      skillVersion:"4.3.2",
      sourceReader,
      taskManager,
      taskWorkspace,
      publicVideoReader
    });
    const dispatcher=new PersonalAssistantDispatcher({
      binding:{senderId:"owner",chatId:"private-chat"},
      bindings,state,coordinator,
      modelMode:{async read(){return "codex";}},
      deepseekEnabled:false,
      messenger,
      taskManager,
      taskWorkspace,
      now:()=>nowMs,
      mediaInputGates:{
        nativeVoiceEnabled:false,
        audioFileEnabled:false,
        localVideoEnabled:false,
        webPageEnabled:false,
        bilibiliEnabled:true,
        douyinEnabled:false
      }
    });

    const result=await dispatcher.handleTaskIncomingMessage(
      createWechatIncomingMessage({
        messageId:"wechat-range-1",
        userId:"wx-owner",
        conversationId:"wx-owner",
        createTimeMs:nowMs,
        type:"text",
        contextToken:"ctx-range-1",
        text:[
          "请核对 ",
          "https://m.bilibili.com/video/BV1AbCdEfGhJ?",
          "buvid=redacted&p=1&share_source=WEIXIN ",
          "第六秒附近的关键数字，不保存"
        ].join("")
      })
    );

    assert.equal(result.status,"committed");
    assert.equal(siteCalls,1);
    assert.equal(asrCalls,1);
    assert.equal(timelineCalls,1);
    assert.equal(rangeCalls,1);
    assert.equal(decisions.length,2);
    assert.equal(writerCalls,0);
    assert.equal(sent.length,2);
    assert.equal(sent[0].text,"已收到，正在处理。");
    assert.match(sent[1].text,/5–7 秒真实画面/u);
    assert.equal(
      state.getOutcome("wechat:wechat-range-1").status,
      "committed"
    );
    const taskRoot=join(
      root,"task-sources",`llw-task-${"R".repeat(43)}`
    );
    const manifest=JSON.parse(await readFile(
      join(taskRoot,"source-001.manifest.json"),"utf8"
    ));
    assert.equal(
      manifest.derived.filter(item=>item.kind==="inspection").length,
      1
    );
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

async function publishImageEvidence({
  sourceId,workspaceDir,durationMs,startMs,endMs,
  relativePath,limitations
}) {
  const bytes=pngHeader(320,180);
  await writeFile(
    join(workspaceDir,relativePath),bytes,{mode:0o600}
  );
  const sampleMs=startMs+Math.floor((endMs-startMs)/2);
  return {
    durationMs,
    startMs,
    endMs,
    sampleCount:1,
    maxGapMs:endMs-startMs,
    samples:[{startMs,endMs,sampleMs}],
    images:[{
      sourceId,
      relativePath,
      sha256:sha(bytes),
      startMs,
      endMs
    }],
    limitations
  };
}

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
