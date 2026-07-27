import test from "node:test";
import assert from "node:assert/strict";
import {PersonalAssistantCoordinator} from "../src/personal-assistant/coordinator.mjs";

function message({
  source="wechat",id="m1",instructionText="",attachments=[]
}={}) {
  return {
    source,sourceMessageId:id,userId:"owner",conversationId:"owner",
    receivedAt:"2026-07-28T00:00:00.000Z",
    instructionText,attachments,
    replyTarget:{
      source,sourceMessageId:id,conversationId:"owner",
      ...(source==="wechat"?{contextToken:"ctx"}:{})
    }
  };
}

test("combines waiting_file only with the later attachment from the same entry",async()=>{
  const conversations={feishu:null,wechat:null};
  const prepared=[];
  const decisions=[
    {
      kind:"ask",question:"请发送要保存的文件。",
      waitingType:"waiting_file",preparedTool:"save_knowledge"
    },
    {kind:"reply",text:"已理解这份材料，不执行写入。"}
  ];
  const coordinator=new PersonalAssistantCoordinator({
    prepareSource:async value=>{
      prepared.push(value.instructionText);
      return {
        preparedSource:{},evidence:null,imageFiles:[],
        cleanup:async()=>{}
      };
    },
    assistant:{async decide(){return decisions.shift();}},
    writer:{},dailyWriter:{},invoiceWriter:{},
    outcomeStore:{
      async get(){return null;},async save(){},async markReplied(){}
    },
    messenger:{async send(){}},
    conversationStore:{
      async get(source){return conversations[source];},
      async set(source,value){conversations[source]=structuredClone(value);},
      async clear(source){conversations[source]=null;}
    },
    personalRules:[],model:"codex",skillVersion:"4.0.1"
  });
  await coordinator.handle(message({
    id:"m1",instructionText:"把我接下来发的文件整理后保存到日常生活"
  }));
  assert.equal(conversations.wechat.waitingType,"waiting_file");
  assert.equal(conversations.feishu,null);
  await coordinator.handle(message({
    id:"m2",attachments:[{
      type:"file",sourceAttachmentId:"wxr_1",
      displayName:"材料.docx",extension:"docx"
    }]
  }));
  assert.deepEqual(prepared,[
    "把我接下来发的文件整理后保存到日常生活",
    "把我接下来发的文件整理后保存到日常生活"
  ]);
  assert.equal(conversations.wechat,null);
});

test("explicit cancellation clears waiting state without preparation, AI or Writer",async()=>{
  let prepares=0,assistantCalls=0,writerCalls=0;
  const conversations={
    feishu:{
      waitingType:"waiting_confirmation",question:"确认保存吗？",
      instructionText:"保存",preparedTool:"save_knowledge",confirmed:{},
      turns:[],model:"codex",startedAt:"2026-07-28T00:00:00.000Z",
      updatedAt:"2026-07-28T00:00:00.000Z"
    },
    wechat:null
  };
  let saved;
  const coordinator=new PersonalAssistantCoordinator({
    prepareSource:async()=>{prepares+=1;},
    assistant:{async decide(){assistantCalls+=1;}},
    writer:{async commit(){writerCalls+=1;}},
    outcomeStore:{
      async get(){return null;},
      async save(outcome){saved=outcome;},
      async markReplied(){}
    },
    messenger:{async send(){throw new Error("must_not_send");}},
    conversationStore:{
      async get(source){return conversations[source];},
      async set(){},
      async clear(source){conversations[source]=null;}
    },
    personalRules:[],model:"codex",skillVersion:"4.0.1"
  });
  const result=await coordinator.handle(message({
    source:"feishu",id:"cancel",instructionText:"不用了，取消"
  }));
  assert.equal(prepares,0);
  assert.equal(assistantCalls,0);
  assert.equal(writerCalls,0);
  assert.equal(conversations.feishu,null);
  assert.equal(result.status,"ignored");
  assert.equal(saved.noReplyRequired,true);
});

