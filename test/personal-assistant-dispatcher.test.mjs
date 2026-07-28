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
  assert.equal(saved[0].outcome.reasonCode,"personal_assistant_failed");
  assert.equal(saved[0].outcome.reply.includes("private_provider_detail"),false);
  assert.deepEqual(failures,["personal_assistant_failed"]);
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
