import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {runV401ModelSmoke} from "../tools/run-v401-model-smoke.mjs";

test("reports only bounded decision kinds for the representative model smoke",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v401-model-smoke-"));
  const configFile=join(root,"config.json");
  await writeFile(configFile,JSON.stringify({
    codexPath:"/test/codex",vaultRoot:"/test/vault",
    deepseekEnabled:true,deepseekModel:"deepseek-v4-pro",
    deepseekKeychainService:"service",deepseekKeychainAccount:"account"
  }),{mode:0o600});
  try {
    const report=await runV401ModelSmoke({
      configFile,skillRoot:root,
      codexInvoke:async()=>({type:"reply",text:"测试概括。"}),
      deepseekInvoke:async()=>({
        type:"tool_call",toolName:"record_daily_work",
        arguments:{
          operation:"create",targetRecordId:"",
          records:[{
            occurred_date:"2026-07-28",occurred_time:"",
            occurred_end_time:"",title:"方案评审",people:[],
            location:"",summary:"完成方案评审。",follow_ups:[],
            original_text:"今天完成了方案评审。"
          }]
        }
      })
    });
    assert.deepEqual(report,{
      rawInputsIncluded:false,rawOutputsIncluded:false,
      codex:{kind:"reply"},
      deepseek:{kind:"tool",toolName:"record_daily_work"}
    });
    assert.equal(JSON.stringify(report).includes("方案评审"),false);
  } finally { await rm(root,{recursive:true,force:true}); }
});

