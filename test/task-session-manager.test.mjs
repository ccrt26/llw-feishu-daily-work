import test from "node:test";
import assert from "node:assert/strict";
import {TaskSessionManager} from "../src/core/task-session-manager.mjs";

function harness({working}={}){
  let session=null; const calls=[];
  const state={
    getTaskSession:()=>structuredClone(session),
    saveTaskSession:async(value,options)=>{session=structuredClone(value);calls.push(["save",structuredClone(value),structuredClone(options)]);},
    closeTaskSession:async(status,updatedAt)=>{session={...session,status,updated_at:updatedAt};calls.push(["close",status,updatedAt]);}
  };
  const workspace={
    create:async input=>calls.push(["workspace",structuredClone(input)]),
    load:async()=>structuredClone(working)
  };
  const ids=["123e4567-e89b-42d3-a456-426614174000"];
  const manager=new TaskSessionManager({state,workspace,createId:()=>ids.shift()});
  return {manager,state,calls,get session(){return session;}};
}

test("creates one fixed Codex session and exposes only the minimal Router summary",async()=>{
  const h=harness();
  const created=await h.manager.create({
    goal:"写一份合成方案",model:"codex",groundingMode:"hybrid",
    sourcePaths:["工作资料/合成.md"],startedAt:"2026-07-26T01:00:00.000Z"
  });
  assert.equal(created.current_draft_version,0);
  assert.deepEqual(h.manager.routerConversation(),{
    capability:"assistant-work",status:"open",goal:"写一份合成方案",
    task_summary:"",current_draft_version:0,model:"codex",
    grounding_mode:"hybrid",startedAt:"2026-07-26T01:00:00.000Z"
  });
  await assert.rejects(()=>h.manager.create({
    goal:"另一任务",model:"codex",groundingMode:"hybrid",sourcePaths:[],
    startedAt:"2026-07-26T01:01:00.000Z"
  }),/task_session_unavailable/);
});

test("updates bounded turns and draft version while preserving identity and model",async()=>{
  const h=harness();
  const created=await h.manager.create({
    goal:"合成方案",model:"codex",groundingMode:"hybrid",sourcePaths:[],
    startedAt:"2026-07-26T01:00:00.000Z"
  });
  await h.manager.update({
    session:created,userText:"第二段更自然",assistantText:"修改后的第二段",
    sourcePaths:[],draftVersion:1,updatedAt:"2026-07-26T01:01:00.000Z"
  });
  assert.equal(h.session.model,"codex");
  assert.equal(h.session.current_draft_version,1);
  assert.deepEqual(h.session.recent_turns.map(turn=>turn.role),["user","assistant"]);
});

test("closes only an open session and never silently changes model",async()=>{
  const h=harness();
  await h.manager.create({
    goal:"合成方案",model:"codex",groundingMode:"hybrid",sourcePaths:[],
    startedAt:"2026-07-26T01:00:00.000Z"
  });
  await h.manager.close("completed","2026-07-26T01:02:00.000Z");
  assert.equal(h.session.status,"completed");
  await assert.rejects(()=>h.manager.close("cancelled","2026-07-26T01:03:00.000Z"),/task_session_unavailable/);
});

test("recovers exactly one workspace-ahead draft after a restart",async()=>{
  const h=harness({working:{
    currentDraftVersion:1,currentDraft:"第一版",
    sourcePaths:["工作资料/合成.md"],
    startedAt:"2026-07-26T01:00:00.000Z",
    updatedAt:"2026-07-26T01:01:00.000Z"
  }});
  await h.manager.create({
    goal:"合成方案",model:"codex",groundingMode:"hybrid",sourcePaths:[],
    startedAt:"2026-07-26T01:00:00.000Z"
  });
  const recovered=await h.manager.recover();
  assert.equal(recovered.current_draft_version,1);
  assert.deepEqual(recovered.source_paths,["工作资料/合成.md"]);
  assert.equal(h.session.current_draft_version,1);
});
