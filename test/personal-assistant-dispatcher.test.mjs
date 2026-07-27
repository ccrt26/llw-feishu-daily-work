import test from "node:test";
import assert from "node:assert/strict";
import {PersonalAssistantDispatcher} from "../src/personal-assistant/dispatcher.mjs";

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

