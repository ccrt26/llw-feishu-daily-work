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
      codexInvoke:async({context,workspaceDir,workspaceRoot})=>{
        assert.equal(workspaceDir,root);
        assert.equal(workspaceRoot,undefined);
        assert.ok(Array.isArray(context.sources));
        assert.equal("sourceEvidence" in context,false);
        return context.instructionText.includes("以后")
          ?{
          type:"ask",question:"确认保存这条长期规则吗？",
          waitingType:"waiting_confirmation",preparedTool:null,
          preparedRule:"清晰且符合归档规则的餐饮发票默认归档。"
        }
          :{type:"reply",text:"测试概括。"};
      },
      deepseekInvoke:async({context})=>{
        assert.deepEqual(context.sources,[]);
        assert.equal("sourceEvidence" in context,false);
        return {
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
        };
      }
    });
    assert.deepEqual(report,{
      rawInputsIncluded:false,rawOutputsIncluded:false,
      codex:{kind:"reply"},
      codexRule:{kind:"ask",hasPreparedRule:true},
      deepseek:{kind:"tool",toolName:"record_daily_work"}
    });
    assert.equal(JSON.stringify(report).includes("方案评审"),false);
  } finally { await rm(root,{recursive:true,force:true}); }
});
