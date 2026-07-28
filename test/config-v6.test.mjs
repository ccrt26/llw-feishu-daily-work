import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {loadConfig,saveConfig} from "../src/config.mjs";

function v6(overrides={}) {
  const vault="/Volumes/test/LLW";
  return {
    version:6,vaultRoot:vault,
    stateFile:"/Users/test/state/state.json",
    heartbeatFile:"/Users/test/state/heartbeat.json",
    modelStateFile:"/Users/test/state/model-state",
    deepseekEnabled:true,deepseekModel:"deepseek-v4-pro",
    deepseekKeychainService:"com.llw.deepseek-api",
    deepseekKeychainAccount:"llw-assistant",
    wechatEnabled:true,wechatStateFile:"/Users/test/state/wechat.json",
    wechatKeychainService:"com.llw.wechat-ilink",
    wechatKeychainAccount:"llw-assistant",
    cliPath:"/Users/test/bin/lark-cli",
    codexPath:"/Applications/ChatGPT.app/codex",
    profile:"private",senderId:"owner",chatId:"chat",
    privateSkills:{
      root:`${vault}/.agents/skills`,
      manifestPath:`${vault}/.agents/skills/manifest.json`,
      expectedManifestSha256:"a".repeat(64)
    },
    personalAssistant:{
      enabled:true,skillName:"llw-personal-assistant",
      aiTimeoutMs:120000,maxContextBytes:524288,
      maxSourcesPerTurn:8,maxSourceFileBytes:20971520,
      maxTurnSourceBytes:83886080,
      sourceBurstQuietMs:3000,sourceBurstMaxMs:15000,
      personalRulesFile:null
    },
    capabilities:{
      "daily-work":{
        enabled:true,skillRoot:`${vault}/.agents/skills/feishu-daily-work`
      },
      invoice:{
        enabled:true,skillRoot:`${vault}/.agents/skills/filing-invoices`,
        tempRoot:"/Users/test/tmp/invoice",
        archiveRoot:`${vault}/亚信工作/日常发票/餐饮发票`,
        maxFileBytes:20971520,aiTimeoutMs:120000,
        pdfProcessorPath:"/Users/test/runtime/pdfium-processor.py",
        maxPdfPages:10,maxPdfTextBytes:262144,
        maxPdfRenderBytes:104857600,pdfPrepareTimeoutMs:60000
      },
      "knowledge-ingest":{
        enabled:false,tempRoot:"/Users/test/tmp/knowledge",
        libraries:[
          {
            libraryKey:"work-knowledge",displayName:"Work",
            aliases:["工作"],root:`${vault}/work`
          },
          {
            libraryKey:"personal-knowledge",displayName:"Personal",
            aliases:["日常生活"],root:`${vault}/personal`
          }
        ],
        maxSourceBytes:262144,aiTimeoutMs:120000,
        inputFormats:[
          "text","txt","md","docx","pptx","xlsx","feishu-snapshot"
        ]
      },
      "assistant-work":{
        enabled:false,tempRoot:"/Users/test/tmp/document",
        workspaceRoot:"/Users/test/document-workspace",
        outputRoot:"/Users/test/document-output",
        maxSearchFiles:512,maxSearchFileBytes:262144,
        maxSearchResults:20,maxSourceExcerptBytes:262144,
        aiTimeoutMs:120000,maxOutputBytes:20971520,
        outputRetentionDays:7,
        allowedOutputFormats:["docx","pptx","xlsx"]
      }
    },
    ...overrides
  };
}

test("version 6 requires exactly one enabled personal assistant and defers rules path",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"llw-config-v6-"));
  const file=join(dir,"config.json");
  try {
    await saveConfig(file,v6());
    assert.deepEqual(await loadConfig(file),v6());
    for (const personalAssistant of [
      {...v6().personalAssistant,enabled:false},
      {...v6().personalAssistant,skillName:"router"},
      {...v6().personalAssistant,aiTimeoutMs:30000},
      {...v6().personalAssistant,maxContextBytes:262144},
      {...v6().personalAssistant,maxSourcesPerTurn:9},
      {...v6().personalAssistant,maxSourceFileBytes:1},
      {...v6().personalAssistant,maxTurnSourceBytes:1},
      {...v6().personalAssistant,sourceBurstQuietMs:1},
      {...v6().personalAssistant,sourceBurstMaxMs:1},
      {...v6().personalAssistant,personalRulesFile:"relative"},
      {...v6().personalAssistant,extra:true}
    ]) {
      await assert.rejects(
        ()=>saveConfig(file,v6({personalAssistant})),
        /personal_assistant|config_path/
      );
    }
    await assert.doesNotReject(()=>saveConfig(file,v6({
      personalAssistant:{
        ...v6().personalAssistant,
        personalRulesFile:"/Volumes/test/LLW/.llw-private/personal-rules.json"
      }
    })));
  } finally { await rm(dir,{recursive:true,force:true}); }
});
