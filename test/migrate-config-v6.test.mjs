import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {spawn} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

const script=fileURLToPath(
  new URL("../src/migrate-config-v6.mjs",import.meta.url)
);

test("atomically upgrades exact version 5 and replaces only the manifest hash",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"llw-migrate-v6-"));
  const file=join(dir,"config.json");
  const before=v5();
  await writeFile(file,`${JSON.stringify(before)}\n`,{mode:0o600});
  try {
    const result=await run(file,"b".repeat(64));
    assert.deepEqual(result,{code:0,stdout:"",stderr:""});
    assert.deepEqual(JSON.parse(await readFile(file,"utf8")),{
      ...before,version:6,
      privateSkills:{
        ...before.privateSkills,expectedManifestSha256:"b".repeat(64)
      },
      personalAssistant:{
        enabled:true,skillName:"llw-personal-assistant",
        aiTimeoutMs:120000,maxContextBytes:524288,
        personalRulesFile:null
      }
    });
  } finally { await rm(dir,{recursive:true,force:true}); }
});

function v5() {
  const vault="/Volumes/test/LLW";
  return {
    version:5,vaultRoot:vault,
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
      root:"/Volumes/test/LLW/.agents/skills",
      manifestPath:"/Volumes/test/LLW/.agents/skills/manifest.json",
      expectedManifestSha256:"a".repeat(64)
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
    }
  };
}

function run(file,hash) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[script,file,hash],{
      stdio:["ignore","pipe","pipe"]
    });
    let stdout="",stderr="";
    child.stdout.on("data",chunk=>stdout+=chunk);
    child.stderr.on("data",chunk=>stderr+=chunk);
    child.once("error",reject);
    child.once("close",code=>resolve({code,stdout,stderr}));
  });
}
