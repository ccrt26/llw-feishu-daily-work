import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {
  access,chmod,mkdir,mkdtemp,rm,writeFile
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

test("WeChat 任务结束 closes the PDF task before one standalone Bilibili summary",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v442-bili-boundary-"));
  let nowMs=Date.parse("2026-08-01T09:30:00.000Z");
  let siteCalls=0,readerCalls=0,videoAiCalls=0,writerCalls=0;
  try {
    await chmod(root,0o700);
    const oldPdfBytes=Buffer.from(
      "%PDF-1.7\nSynthetic completed PDF task."
    );
    const audioBytes=Buffer.from("0000ftypM4A standalone audio");
    const videoBytes=Buffer.from("0000ftypmp42 standalone video");
    const basePreparer=createAssistantSourcePreparer({
      tempRoot:join(root,"turn-intake"),
      download:async()=>{
        const tempDir=join(root,"download-old-pdf");
        await mkdir(tempDir,{mode:0o700});
        const file=join(tempDir,"old.pdf");
        await writeFile(file,oldPdfBytes,{mode:0o600});
        return {file,tempDir};
      }
    });
    const publicPreparer=createPublicVideoSourcePreparer({
      tempRoot:join(root,"public-intake"),
      bilibiliAdapter:{
        async prepare({workspaceDir}) {
          siteCalls+=1;
          const audioFile=join(workspaceDir,"bilibili-audio.m4a");
          const videoFile=join(workspaceDir,"bilibili-video.mp4");
          await writeFile(audioFile,audioBytes,{mode:0o600});
          await writeFile(videoFile,videoBytes,{mode:0o600});
          return {
            platform:"bilibili",mediaId:"BV1Synthetic",
            canonicalUrl:
              "https://www.bilibili.com/video/BV1Synthetic/",
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
      },
      douyinAdapter:{async prepare(){throw new Error("unexpected_douyin");}}
    });
    const prepareTurnSources=createTurnSourcePreparerWithPublicVideo({
      basePreparer,publicVideoSourcePreparer:publicPreparer
    });
    const state=await StateStore.open(join(root,"state.json"));
    const bindings={
      feishu:{userId:"owner",conversationId:"private-chat"},
      wechat:{userId:"wx-owner",conversationId:"wx-owner"}
    };
    const taskIds=["O".repeat(43),"N".repeat(43)];
    const taskManager=new PersonalAssistantTaskSessionManager({
      state,bindings,selectModel:async()=>"codex",
      createId:()=>taskIds.shift(),now:()=>nowMs
    });
    const taskWorkspace=new TaskSourceWorkspace({
      root:join(root,"task-sources"),prepareTurnSources
    });
    const assistant=new PersonalAssistantClient({
      codex:async context=>{
        const mediaClass=context.sources[0]?.mediaClass;
        if (mediaClass==="document") {
          return {type:"reply",text:"旧 PDF 任务已处理。"};
        }
        assert.equal(mediaClass,"video");
        assert.equal(context.sources[0].sourceId,"source-001");
        videoAiCalls+=1;
        return {type:"reply",text:"独立 B 站视频已完成总结，没有保存。"};
      },
      deepseek:async()=>{throw new Error("unexpected_model");}
    });
    const sent=[];
    const messenger={
      async send(value){sent.push(structuredClone(value));}
    };
    const coordinator=new PersonalAssistantCoordinator({
      prepareSource:prepareTurnSources,assistant,
      writer:{async commit(){writerCalls+=1;}},
      dailyWriter:{async write(){writerCalls+=1;}},
      invoiceWriter:{async commit(){writerCalls+=1;}},
      outcomeStore:{
        get:key=>state.getOutcome(key),
        markReplied:key=>state.markReplied(key)
      },
      messenger,personalRules:[],model:"codex",skillVersion:"4.4.0",
      taskManager,taskWorkspace,
      publicVideoReader:{
        async prepare({sources}) {
          const videos=sources.filter(
            source=>(source.handle??source).mediaClass==="video"
          );
          if (!videos.length) {
            return {observations:[],modelImageFiles:[]};
          }
          readerCalls+=1;
          assert.equal(videos.length,1);
          assert.equal(videos[0].handle.sourceId,"source-001");
          return {observations:[],modelImageFiles:[]};
        }
      }
    });
    const dispatcher=new PersonalAssistantDispatcher({
      binding:{senderId:"owner",chatId:"private-chat"},
      bindings,state,coordinator,
      modelMode:{async read(){return "codex";}},
      deepseekEnabled:false,messenger,taskManager,taskWorkspace,
      now:()=>nowMs,
      mediaInputGates:{
        nativeVoiceEnabled:false,audioFileEnabled:false,
        localVideoEnabled:false,webPageEnabled:false,
        bilibiliEnabled:true,douyinEnabled:false
      }
    });

    const oldPdf=await dispatcher.handleTaskIncomingMessage(
      createWechatIncomingMessage({
        messageId:"old-pdf",userId:"wx-owner",
        conversationId:"wx-owner",createTimeMs:nowMs,
        type:"file",contextToken:"ctx-old-pdf",
        attachment:{
          type:"file",sourceAttachmentId:"old_pdf",
          displayName:"旧任务.pdf",extension:"pdf"
        }
      })
    );
    assert.equal(oldPdf.status,"committed");
    const oldTask=taskManager.current("wechat");
    assert.equal(oldTask.taskId,"O".repeat(43));
    assert.deepEqual(oldTask.sourceIds,["source-001"]);
    await access(taskWorkspace.workspace(oldTask.taskId));

    nowMs+=1_000;
    const ended=await dispatcher.handleTaskIncomingMessage(
      createWechatIncomingMessage({
        messageId:"end-old",userId:"wx-owner",
        conversationId:"wx-owner",createTimeMs:nowMs,
        type:"text",contextToken:"ctx-end-old",text:"当前任务已结束"
      })
    );
    assert.equal(ended.status,"committed");
    assert.equal(taskManager.current("wechat"),null);
    await assert.rejects(
      access(taskWorkspace.workspace(oldTask.taskId)),{code:"ENOENT"}
    );

    nowMs+=1_000;
    const video=await dispatcher.handleTaskIncomingMessage(
      createWechatIncomingMessage({
        messageId:"new-bili",userId:"wx-owner",
        conversationId:"wx-owner",createTimeMs:nowMs,
        type:"text",contextToken:"ctx-new-bili",
        text:"总结 https://www.bilibili.com/video/BV1AbCdEfGhJ/ 不保存"
      })
    );
    assert.equal(video.status,"committed");
    const newTask=taskManager.current("wechat");
    assert.equal(newTask.taskId,"N".repeat(43));
    assert.notEqual(newTask.taskId,oldTask.taskId);
    assert.deepEqual(newTask.sourceIds,["source-001"]);
    assert.deepEqual(
      {siteCalls,readerCalls,videoAiCalls,writerCalls},
      {siteCalls:1,readerCalls:1,videoAiCalls:1,writerCalls:0}
    );
    assert.equal(
      sent.filter(item=>item.text==="当前任务已结束。").length,
      1
    );
    assert.match(sent.at(-1).text,/完成总结/u);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}
