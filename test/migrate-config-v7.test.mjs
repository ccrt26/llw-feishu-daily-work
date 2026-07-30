import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {
  chmod,mkdtemp,readFile,rm,writeFile
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

const script=fileURLToPath(
  new URL("../src/migrate-config-v7.mjs",import.meta.url)
);
const GATES={
  nativeVoiceEnabled:false,
  audioFileEnabled:false,
  localVideoEnabled:false,
  webPageEnabled:false,
  bilibiliEnabled:false,
  douyinEnabled:false
};

test("atomically migrates exact version 6 to version 7 with six false gates",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"llw-migrate-v7-"));
  const file=join(dir,"config.json");
  const before=v6();
  await writeFile(file,`${JSON.stringify(before,null,2)}\n`,{mode:0o600});
  try {
    assert.deepEqual(await run(file),{code:0,stdout:"",stderr:""});
    assert.deepEqual(JSON.parse(await readFile(file,"utf8")),{
      ...before,
      version:7,
      mediaInputGates:GATES
    });
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
});

test("rejects non-v6, unsafe, or extra input without changing config bytes",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"llw-migrate-v7-reject-"));
  try {
    for (const [name,value,mode,args=[]] of [
      ["already-v7",{...v6(),version:7,mediaInputGates:GATES},0o600],
      ["wrong-version",{...v6(),version:5},0o600],
      ["unsafe-mode",v6(),0o644],
      ["extra-argument",v6(),0o600,["unexpected"]]
    ]) {
      const file=join(dir,`${name}.json`);
      const bytes=`${JSON.stringify(value,null,2)}\n`;
      await writeFile(file,bytes,{mode:0o600});
      await chmod(file,mode);
      assert.deepEqual(
        await run(file,args),
        {code:1,stdout:"",stderr:""}
      );
      assert.equal(await readFile(file,"utf8"),bytes);
    }
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
});

function v6() {
  const vault="/Volumes/test/LLW";
  return {
    version:6,
    vaultRoot:vault,
    stateFile:"/Users/test/state/state.json",
    heartbeatFile:"/Users/test/state/heartbeat.json",
    modelStateFile:"/Users/test/state/model-state",
    deepseekEnabled:true,
    deepseekModel:"deepseek-v4-pro",
    deepseekKeychainService:"com.llw.deepseek-api",
    deepseekKeychainAccount:"llw-assistant",
    wechatEnabled:true,
    wechatStateFile:"/Users/test/state/wechat.json",
    wechatKeychainService:"com.llw.wechat-ilink",
    wechatKeychainAccount:"llw-assistant",
    cliPath:"/Users/test/bin/lark-cli",
    codexPath:"/Applications/ChatGPT.app/codex",
    profile:"private",
    senderId:"owner",
    chatId:"chat",
    privateSkills:{
      root:`${vault}/.agents/skills`,
      manifestPath:`${vault}/.agents/skills/manifest.json`,
      expectedManifestSha256:"a".repeat(64)
    },
    personalAssistant:{
      enabled:true,
      skillName:"llw-personal-assistant",
      aiTimeoutMs:120000,
      maxContextBytes:524288,
      maxSourcesPerTurn:8,
      maxSourceFileBytes:20971520,
      maxTurnSourceBytes:83886080,
      sourceBurstQuietMs:3000,
      sourceBurstMaxMs:15000,
      personalRulesFile:null
    },
    capabilities:{
      "daily-work":{
        enabled:true,
        skillRoot:`${vault}/.agents/skills/feishu-daily-work`
      },
      invoice:{
        enabled:true,
        skillRoot:`${vault}/.agents/skills/filing-invoices`,
        tempRoot:"/Users/test/tmp/invoice",
        archiveRoot:`${vault}/亚信工作/日常发票/餐饮发票`,
        maxFileBytes:20971520,
        aiTimeoutMs:120000,
        pdfProcessorPath:"/Users/test/runtime/pdfium-processor.py",
        maxPdfPages:10,
        maxPdfTextBytes:262144,
        maxPdfRenderBytes:104857600,
        pdfPrepareTimeoutMs:60000
      },
      "knowledge-ingest":{
        enabled:false,
        tempRoot:"/Users/test/tmp/knowledge",
        libraries:[
          {
            libraryKey:"work-knowledge",
            displayName:"Work",
            aliases:["工作"],
            root:`${vault}/work`
          },
          {
            libraryKey:"personal-knowledge",
            displayName:"Personal",
            aliases:["日常生活"],
            root:`${vault}/personal`
          }
        ],
        maxSourceBytes:262144,
        aiTimeoutMs:120000,
        inputFormats:[
          "text","txt","md","docx","pptx","xlsx","feishu-snapshot"
        ]
      },
      "assistant-work":{
        enabled:false,
        tempRoot:"/Users/test/tmp/document",
        workspaceRoot:"/Users/test/document-workspace",
        outputRoot:"/Users/test/document-output",
        maxSearchFiles:512,
        maxSearchFileBytes:262144,
        maxSearchResults:20,
        maxSourceExcerptBytes:262144,
        aiTimeoutMs:120000,
        maxOutputBytes:20971520,
        outputRetentionDays:7,
        allowedOutputFormats:["docx","pptx","xlsx"]
      }
    }
  };
}

function run(file,extra=[]) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[script,file,...extra],{
      stdio:["ignore","pipe","pipe"]
    });
    let stdout="",stderr="";
    child.stdout.on("data",chunk=>stdout+=chunk);
    child.stderr.on("data",chunk=>stderr+=chunk);
    child.once("error",reject);
    child.once("close",code=>resolve({code,stdout,stderr}));
  });
}
