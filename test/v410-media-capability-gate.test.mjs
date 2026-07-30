import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {buildFixtureManifest} from "../scripts/create-v410-media-fixtures.mjs";
import {
  evaluateGateResult,renderGateReport
} from "../scripts/v410-media-capability-gate.mjs";
import {
  PersonalAssistantDispatcher
} from "../src/personal-assistant/dispatcher.mjs";

test("fixture manifest labels synthetic bytes as fixed non-private facts",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v410-media-fixtures-"));
  const audio=join(root,"instruction.aiff");
  const video=join(root,"visual-facts.mov");
  await writeFile(audio,Buffer.alloc(1_024,1));
  await writeFile(video,Buffer.alloc(2_048,2));
  const manifest=await buildFixtureManifest({audio,video});
  assert.deepEqual(manifest.expectedVisualSequence,[
    "circle","square","triangle"
  ]);
  assert.equal(manifest.visualOnlyCode,"BLUE-7319");
  assert.equal(manifest.audioPhrase,"请把测试代号海风七三一九记录下来");
  assert.equal(manifest.containsUserData,false);
  assert.equal(manifest.visualOnlyCodeSpoken,false);
  assert.equal(manifest.sequenceSpoken,false);
  assert.equal(manifest.files.audio,"instruction.aiff");
  assert.equal(manifest.files.video,"visual-facts.mov");
  assert.match(manifest.sha256.audio,/^[a-f0-9]{64}$/u);
  assert.match(manifest.sha256.video,/^[a-f0-9]{64}$/u);
});

test("gate passes only direct audio, visual fact, order and timing evidence",()=>{
  const result=evaluateGateResult({
    audioPhrase:"请把测试代号海风七三一九记录下来",
    visualCode:"BLUE-7319",
    visualSequence:["circle","square","triangle"],
    codeTimeRangeMs:{start:5_100,end:6_900},
    directlyInspectedAudio:true,
    directlyInspectedVideo:true,
    limitations:[]
  });
  assert.equal(result.mandatoryPassed,true);
  assert.equal(result.directMediaSupported,true);
  assert.deepEqual(
    result.cases.map(item=>[item.id,item.status]),
    [
      ["audio_instruction","pass"],
      ["video_visual_only_fact","pass"],
      ["video_temporal_order","pass"],
      ["video_time_lookup","pass"]
    ]
  );
});

test("gate marks an admitted inability as unsupported instead of guessing",()=>{
  const result=evaluateGateResult({
    audioPhrase:null,
    visualCode:null,
    visualSequence:[],
    codeTimeRangeMs:null,
    directlyInspectedAudio:false,
    directlyInspectedVideo:false,
    limitations:["The CLI has no audio or video attachment input."]
  });
  assert.equal(result.mandatoryPassed,false);
  assert.equal(result.directMediaSupported,false);
  assert.ok(result.cases.every(item=>item.status==="unsupported"));
});

test("gate report contains evidence status without private absolute paths",()=>{
  const report=renderGateReport({
    environment:{
      codexVersion:"codex-cli test",
      nodeVersion:"v24.0.0",
      invocationMode:"one read-only Codex call"
    },
    elapsedMs:123,
    result:evaluateGateResult({
      audioPhrase:null,
      visualCode:null,
      visualSequence:[],
      codeTimeRangeMs:null,
      directlyInspectedAudio:false,
      directlyInspectedVideo:false,
      limitations:["Could not inspect /Users/private/source.mov"]
    })
  });
  assert.match(report,/Decision: STOP_AFTER_FOUNDATION/u);
  assert.doesNotMatch(report,/\/Users\/private/u);
  assert.match(report,/<absolute-path>/u);
});

test("six false phase-0 gates stop WeChat media and web input before the assistant or Writer",async()=>{
  const gates={
    nativeVoiceEnabled:false,
    audioFileEnabled:false,
    localVideoEnabled:false,
    webPageEnabled:false,
    bilibiliEnabled:false,
    douyinEnabled:false
  };
  const cases=[
    [
      "native_voice_disabled",
      incoming({
        id:"native-voice",
        attachments:[attachment("voice.amr","amr")]
      })
    ],
    [
      "audio_file_disabled",
      incoming({
        id:"audio-file",
        attachments:[attachment("meeting.mp3","mp3")]
      })
    ],
    [
      "local_video_disabled",
      incoming({
        id:"local-video",
        attachments:[attachment("meeting.mp4","mp4")]
      })
    ],
    [
      "web_page_disabled",
      incoming({
        id:"web-page",
        instructionText:"总结 https://example.com/article"
      })
    ],
    [
      "bilibili_disabled",
      incoming({
        id:"bilibili",
        instructionText:"总结 https://www.bilibili.com/video/BV1test"
      })
    ],
    [
      "douyin_disabled",
      incoming({
        id:"douyin",
        instructionText:"总结 https://www.douyin.com/video/123"
      })
    ]
  ];
  let assistantCalls=0,writerCalls=0,replyFileCount=0;
  const saved=[];
  const dispatcher=new PersonalAssistantDispatcher({
    binding:{senderId:"owner",chatId:"private"},
    bindings:{
      feishu:{userId:"owner",conversationId:"private"},
      wechat:{userId:"wx-owner",conversationId:"wx-owner"}
    },
    state:{
      hasOutcome:()=>false,
      async saveOutcome(_key,outcome){saved.push(outcome);},
      async markReplied(){}
    },
    coordinator:{
      async handle(){
        assistantCalls+=1;
        writerCalls+=1;
        return {status:"committed"};
      }
    },
    modelMode:{},deepseekEnabled:false,
    messenger:{
      async send(value){replyFileCount+=value.replyFiles.length;}
    },
    mediaInputGates:gates
  });
  for (const [reasonCode,message] of cases) {
    const result=await dispatcher.handleIncomingMessage(message);
    assert.equal(result.status,"rejected");
    assert.equal(saved.at(-1).reasonCode,reasonCode);
    assert.deepEqual(saved.at(-1).replyFiles,[]);
  }
  assert.equal(assistantCalls,0);
  assert.equal(writerCalls,0);
  assert.equal(replyFileCount,0);
});

test("false media gates do not block ordinary text, image, Office, or PDF turns",async()=>{
  let assistantCalls=0;
  const dispatcher=new PersonalAssistantDispatcher({
    binding:{senderId:"owner",chatId:"private"},
    bindings:{
      feishu:{userId:"owner",conversationId:"private"},
      wechat:{userId:"wx-owner",conversationId:"wx-owner"}
    },
    state:{hasOutcome:()=>false},
    coordinator:{
      async handle(){
        assistantCalls+=1;
        return {status:"committed"};
      }
    },
    modelMode:{},deepseekEnabled:false,
    messenger:{async send(){}},
    mediaInputGates:{
      nativeVoiceEnabled:false,
      audioFileEnabled:false,
      localVideoEnabled:false,
      webPageEnabled:false,
      bilibiliEnabled:false,
      douyinEnabled:false
    }
  });
  for (const message of [
    incoming({id:"plain",instructionText:"总结今天的计划"}),
    incoming({
      id:"image",
      attachments:[{
        type:"image",sourceAttachmentId:"img",
        displayName:"图片.png",extension:"png"
      }]
    }),
    incoming({
      id:"office",
      attachments:[attachment("材料.docx","docx")]
    }),
    incoming({
      id:"pdf",
      attachments:[attachment("材料.pdf","pdf")]
    })
  ]) {
    assert.equal(
      (await dispatcher.handleIncomingMessage(message)).status,
      "committed"
    );
  }
  assert.equal(assistantCalls,4);
});

function incoming({
  id,instructionText="",attachments=[]
}) {
  return {
    source:"wechat",
    sourceMessageId:id,
    userId:"wx-owner",
    conversationId:"wx-owner",
    receivedAt:"2026-07-30T00:00:00.000Z",
    instructionText,
    attachments,
    replyTarget:{
      source:"wechat",
      sourceMessageId:id,
      conversationId:"wx-owner",
      contextToken:`ctx-${id}`
    }
  };
}

function attachment(displayName,extension) {
  return {
    type:"file",
    sourceAttachmentId:`resource-${extension}`,
    displayName,
    extension
  };
}
