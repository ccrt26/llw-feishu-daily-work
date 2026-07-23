import test from "node:test";
import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {runRealDeepSeekEvals,selectFailedCaseIds} from "../tools/run-real-deepseek-evals.mjs";

const run=promisify(execFile);

test("lists the fixed 22-case formal-Skill evaluation plan without Keychain or network access",async()=>{
  const {stdout}=await run("/usr/local/bin/node",["tools/run-real-deepseek-evals.mjs","--list"],{
    cwd:new URL("..",import.meta.url),
    encoding:"utf8"
  });
  const plan=JSON.parse(stdout);
  assert.equal(plan.model,"deepseek-v4-pro");
  assert.equal(plan.keychainRead,false);
  assert.equal(plan.networkAccess,false);
  assert.deepEqual(plan.suites.map(item=>({name:item.name,count:item.count})),[
    {name:"router",count:10},
    {name:"daily-work",count:12}
  ]);
  for (const suite of plan.suites) {
    assert.match(suite.skillRoot,/\/LLW\/\.agents\/skills\//);
    assert.equal(suite.skillRoot.includes("/private/tmp/llw-v31-eval-skills"),false);
  }
});

test("runs the fixed suites through an injected client and keeps the report free of raw inputs and outputs",async()=>{
  const calls=[];
  let saved;
  const report=await runRealDeepSeekEvals({
    invoke:async ({evalCase,skillRoot})=>{
      calls.push({id:evalCase.id,skillRoot});
      const result=structuredClone(evalCase.expected);
      if (Object.hasOwn(result,"reason_code")) {
        result.reasonCode=result.reason_code;
        delete result.reason_code;
      }
      if (evalCase.id==="router-negative-cancel-without-conversation") result.reason="当前没有待取消任务。";
      if (evalCase.id==="daily-positive-multiturn-clarified-supplement") {
        result.records=[{original_text:evalCase.input.conversation.turns.find(turn=>turn.role==="user").text}];
      }
      return result;
    },
    writeReport:async value=>{saved=structuredClone(value);}
  });
  assert.equal(calls.length,22);
  assert.equal(calls.every(call=>call.skillRoot.includes("/LLW/.agents/skills/")),true);
  assert.deepEqual(report.summary,{total:22,passed:22,failed:0});
  assert.deepEqual(saved.summary,report.summary);
  assert.equal(report.rawInputsIncluded,false);
  assert.equal(report.rawOutputsIncluded,false);
  const serialized=JSON.stringify(report);
  assert.equal(serialized.includes("今天下午和客户确认了上线时间"),false);
  assert.equal(serialized.includes("参会人员还有华东区销售"),false);
});

test("selects and reruns only failed case IDs from one complete V4 Pro report",async()=>{
  const caseIds=selectFailedCaseIds({
    model:"deepseek-v4-pro",
    rawInputsIncluded:false,
    rawOutputsIncluded:false,
    keychain:{keyIncluded:false},
    summary:{total:3,passed:1,failed:2},
    suites:[
      {name:"router",cases:[{id:"router-positive-daily-work",passed:false},{id:"router-negative-unsupported-chat",passed:true}]},
      {name:"daily-work",cases:[{id:"daily-negative-knowledge-question",passed:false}]}
    ]
  });
  assert.deepEqual(caseIds,["router-positive-daily-work","daily-negative-knowledge-question"]);
  const calls=[];
  const report=await runRealDeepSeekEvals({
    caseIds,
    invoke:async ({evalCase})=>{
      calls.push(evalCase.id);
      const result=structuredClone(evalCase.expected);
      if (Object.hasOwn(result,"reason_code")) {
        result.reasonCode=result.reason_code;
        delete result.reason_code;
      }
      return result;
    },
    writeReport:async()=>{}
  });
  assert.deepEqual(calls,caseIds);
  assert.deepEqual(report.summary,{total:2,passed:2,failed:0});
});
