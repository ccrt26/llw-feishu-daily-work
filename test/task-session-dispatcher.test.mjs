import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Dispatcher} from "../src/core/dispatcher.mjs";
import {TaskSessionManager} from "../src/core/task-session-manager.mjs";
import {StateStore} from "../src/state-store.mjs";
import {createWechatIncomingMessage} from "../src/core/incoming-message.mjs";

const contract=(name,continuation)=>({
  capability:name,purpose:name,accepts:["text"],positive_examples:["正例"],
  negative_examples:["反例"],supports_continuation:continuation
});

async function harness(){
  const root=await mkdtemp(join(tmpdir(),"llw-aw-dispatcher-"));
  const state=await StateStore.open(join(root,"state.json"),{
    taskSessionPolicy:[{capability:"assistant-work",models:["codex"]}]
  });
  const manager=new TaskSessionManager({
    state,workspace:{create:async()=>{}},
    createId:()=> "123e4567-e89b-42d3-a456-426614174000"
  });
  await manager.create({
    goal:"修改合成方案",model:"codex",groundingMode:"hybrid",sourcePaths:[],
    startedAt:"2026-07-26T01:00:00.000Z"
  });
  const routerCalls=[],runs=[],sends=[]; let decision,modelReads=0;
  const capabilities=[
    {
      name:"assistant-work",routingContract:contract("assistant-work",true),
      handle:async (_message,context)=>{
        runs.push(["assistant-work",context.model]);
        return {status:"committed",reply:"已修改第二段。",artifacts:["task-session/synthetic/session.json"]};
      }
    },
    {
      name:"knowledge-ingest",routingContract:contract("knowledge-ingest",true),
      handle:async (_message,context)=>{
        runs.push(["knowledge-ingest",context.model]);
        return {status:"committed",reply:"已处理独立入库动作。",artifacts:["knowledge/synthetic"]};
      }
    }
  ];
  const dispatcher=new Dispatcher({
    binding:{senderId:"u1",chatId:"c1"},
    bindings:{wechat:{userId:"wx-owner",conversationId:"wx-owner"}},
    state,capabilities,taskSessionManager:manager,
    intentRouter:{decide:async input=>{
      routerCalls.push(structuredClone(input)); return decision;
    }},
    messenger:{send:async input=>sends.push(structuredClone(input))},
    modelMode:{read:async()=>{modelReads++;return "codex";}},
    deepseekEnabled:true
  });
  const send=async(text,messageId)=>{
    return dispatcher.handleIncomingMessage(createWechatIncomingMessage({
      messageId,userId:"wx-owner",conversationId:"wx-owner",
      createTimeMs:Date.parse("2026-07-26T01:02:00.000Z"),
      type:"text",text,contextToken:"synthetic-context"
    }));
  };
  return {
    state,manager,routerCalls,runs,sends,send,
    get modelReads(){return modelReads;},
    setDecision:value=>{decision=value;}
  };
}

test("supplies one minimal open Task Session to Router and continues on its fixed model",async()=>{
  const h=await harness();
  h.setDecision({
    action:"route",capability:"assistant-work",confidence:"high",
    reasonCode:"continuation"
  });
  const result=await h.send("第二段再自然一点","m1");
  assert.equal(result.status,"committed");
  assert.deepEqual(h.routerCalls[0].conversation,{
    capability:"assistant-work",status:"open",goal:"修改合成方案",
    task_summary:"",current_draft_version:0,model:"codex",
    grounding_mode:"hybrid",startedAt:"2026-07-26T01:00:00.000Z"
  });
  assert.deepEqual(h.runs,[["assistant-work","codex"]]);
  assert.equal(h.modelReads,0);
});

test("routes an explicit independent action without deleting the open working task",async()=>{
  const h=await harness();
  h.setDecision({
    action:"route",capability:"knowledge-ingest",confidence:"high",
    reasonCode:"new_task"
  });
  await h.send("把下面内容保存到知识库","m2");
  assert.deepEqual(h.runs,[["knowledge-ingest","codex"]]);
  assert.equal(h.manager.getOpen().capability,"assistant-work");
  assert.equal(h.modelReads,1);
});

test("explicit cancellation closes the open Task Session and persists a silent outcome",async()=>{
  const h=await harness();
  h.setDecision({action:"unsupported",reason:"cancelled"});
  const result=await h.send("取消当前任务","m3");
  assert.equal(result.status,"ignored");
  assert.equal(h.manager.getOpen(),null);
  assert.equal(h.sends.length,0);
});
