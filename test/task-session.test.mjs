import test from "node:test";
import assert from "node:assert/strict";
import {validateTaskSession} from "../src/core/task-session.mjs";

const policy=[{capability:"assistant-work",models:["codex"]}];

function session(overrides={}) {
  return {
    version:1,
    session_id:"123e4567-e89b-42d3-a456-426614174000",
    capability:"assistant-work",
    status:"open",
    model:"codex",
    grounding_mode:"hybrid",
    goal:"根据项目资料整理验收说明",
    task_summary:"",
    confirmed_requirements:["保留来源"],
    rejected_directions:[],
    source_paths:["projects/acceptance.md"],
    current_draft_version:0,
    recent_turns:[{role:"user",text:"先整理一个提纲"}],
    started_at:"2026-07-26T05:00:00.000Z",
    updated_at:"2026-07-26T05:00:00.000Z",
    ...overrides
  };
}

test("validates and deep-clones one exact bounded Task Session",()=>{
  const input=session();
  const result=validateTaskSession(input,{
    policy,
    verifiedSourcePaths:["projects/acceptance.md"]
  });
  assert.deepEqual(result,input);
  assert.notEqual(result,input);
  assert.notEqual(result.confirmed_requirements,input.confirmed_requirements);
  assert.notEqual(result.recent_turns,input.recent_turns);
  result.confirmed_requirements.push("不改变原文");
  result.recent_turns[0].text="changed";
  assert.deepEqual(input.confirmed_requirements,["保留来源"]);
  assert.equal(input.recent_turns[0].text,"先整理一个提纲");
});

function rejects(input,options={
  policy,
  verifiedSourcePaths:["projects/acceptance.md"]
}) {
  assert.throws(
    ()=>validateTaskSession(input,options),
    error=>error?.message==="invalid_task_session"&&
      !error.message.includes("projects/acceptance.md")&&
      !error.message.includes("根据项目资料")
  );
}

test("rejects malformed fields, values and bounds with one content-free error",()=>{
  const mutations=[
    value=>{ value.extra=true; },
    value=>{ value.version=2; },
    value=>{ value.session_id="123E4567-E89B-42D3-A456-426614174000"; },
    value=>{ value.capability="daily-work"; },
    value=>{ value.status="paused"; },
    value=>{ value.model="deepseek"; },
    value=>{ value.goal=""; },
    value=>{ value.goal="a".repeat(1001); },
    value=>{ value.task_summary="a".repeat(8001); },
    value=>{ value.confirmed_requirements=["same","same"]; },
    value=>{ value.confirmed_requirements=["a".repeat(1001)]; },
    value=>{ value.rejected_directions=Array.from({length:21},(_,index)=>`item-${index}`); },
    value=>{ value.current_draft_version=-1; },
    value=>{ value.current_draft_version=1.5; },
    value=>{ value.current_draft_version=1_000_001; },
    value=>{ value.recent_turns=Array.from({length:13},()=>({role:"user",text:"x"})); },
    value=>{ value.recent_turns=[{role:"system",text:"x"}]; },
    value=>{ value.recent_turns=[{role:"user",text:""}]; },
    value=>{ value.recent_turns=[{role:"user",text:"a".repeat(2001)}]; },
    value=>{ value.recent_turns=[{role:"user",text:"x",extra:true}]; },
    value=>{ value.started_at="2026-07-26T05:00:00Z"; },
    value=>{ value.updated_at="2026-07-26T04:59:59.999Z"; }
  ];
  for (const mutate of mutations) {
    const input=session();
    mutate(input);
    rejects(input);
  }
  for (const input of [null,[],new Date()]) rejects(input);
  const nonPlain=session();
  Object.setPrototypeOf(nonPlain,null);
  rejects(nonPlain);
});

test("rejects unsafe, duplicate or unverified relative source paths",()=>{
  for (const path of [
    "../outside.md","/absolute.md","folder\\file.md","~/private.md",
    "folder//file.md","folder/./file.md","https://example.com/file.md"
  ]) {
    rejects(session({source_paths:[path]}),{policy,verifiedSourcePaths:[path]});
  }
  rejects(session(),{policy,verifiedSourcePaths:[]});
  rejects(session({source_paths:["projects/acceptance.md","projects/acceptance.md"]}));
  rejects(session({source_paths:["a".repeat(241)]}),{
    policy,verifiedSourcePaths:["a".repeat(241)]
  });
  rejects(session({source_paths:Array.from({length:21},(_,index)=>`source-${index}.md`)}),{
    policy,
    verifiedSourcePaths:Array.from({length:21},(_,index)=>`source-${index}.md`)
  });
});

test("requires an exact unique continuation policy and allowed model",()=>{
  rejects(session(),{policy:[],verifiedSourcePaths:["projects/acceptance.md"]});
  rejects(session(),{
    policy:[{capability:"assistant-work",models:["codex"],extra:true}],
    verifiedSourcePaths:["projects/acceptance.md"]
  });
  rejects(session(),{
    policy:[
      {capability:"assistant-work",models:["codex"]},
      {capability:"assistant-work",models:["codex"]}
    ],
    verifiedSourcePaths:["projects/acceptance.md"]
  });
  rejects(session(),{
    policy:[{capability:"assistant-work",models:["codex","codex"]}],
    verifiedSourcePaths:["projects/acceptance.md"]
  });
  rejects(session(),{
    policy:[{capability:"assistant-work",models:["deepseek"]}],
    verifiedSourcePaths:["projects/acceptance.md"]
  });
});

test("accepts only explicit grounding modes",()=>{
  for (const grounding_mode of ["source_strict","hybrid","creative"]) {
    assert.equal(validateTaskSession(session({grounding_mode}),{
      policy,verifiedSourcePaths:["projects/acceptance.md"]
    }).grounding_mode,grounding_mode);
  }
  for (const grounding_mode of ["automatic","strict","",null]) {
    rejects(session({grounding_mode}));
  }
});

test("accepts terminal statuses but rejects a session larger than 32 KiB",()=>{
  for (const status of ["completed","cancelled","expired"]) {
    assert.equal(validateTaskSession(session({status}),{
      policy,verifiedSourcePaths:["projects/acceptance.md"]
    }).status,status);
  }
  const largeItems=Array.from(
    {length:20},
    (_,index)=>`${String(index).padStart(2,"0")}-${"a".repeat(997)}`
  );
  rejects(session({
    source_paths:[],
    confirmed_requirements:largeItems,
    rejected_directions:largeItems.map(item=>`b${item.slice(1)}`)
  }),{policy,verifiedSourcePaths:[]});
});
