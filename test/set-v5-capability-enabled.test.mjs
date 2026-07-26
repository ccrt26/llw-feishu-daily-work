import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {
  chmod,mkdtemp,readFile,rm,stat,symlink,writeFile
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

const script=fileURLToPath(new URL(
  "../src/set-v5-capability-enabled.mjs",import.meta.url
));

function v5() {
  return {
    version:5,
    vaultRoot:"/Volumes/test/LLW",
    stateFile:"/Users/test/state.json",
    heartbeatFile:"/Users/test/heartbeat.json",
    modelStateFile:"/Users/test/model-state",
    deepseekEnabled:true,
    deepseekModel:"deepseek-v4-pro",
    deepseekKeychainService:"com.llw.deepseek-api",
    deepseekKeychainAccount:"llw-assistant",
    wechatEnabled:true,
    wechatStateFile:"/Users/test/wechat-state.json",
    wechatKeychainService:"com.llw.wechat-ilink",
    wechatKeychainAccount:"llw-assistant",
    cliPath:"/Users/test/lark-cli",
    codexPath:"/Users/test/codex",
    profile:"private",
    senderId:"synthetic-user",
    chatId:"synthetic-chat",
    privateSkills:{
      root:"/Volumes/test/LLW/.agents/skills",
      manifestPath:"/Volumes/test/LLW/.agents/skills/manifest.json",
      expectedManifestSha256:"a".repeat(64)
    },
    capabilities:{
      "daily-work":{
        enabled:true,
        skillRoot:"/Volumes/test/LLW/.agents/skills/feishu-daily-work"
      },
      invoice:{
        enabled:true,
        skillRoot:"/Volumes/test/LLW/.agents/skills/filing-invoices",
        tempRoot:"/Users/test/jobs/invoice",
        archiveRoot:"/Volumes/test/LLW/亚信工作/日常发票/餐饮发票",
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
        tempRoot:"/Users/test/jobs/knowledge",
        libraries:[
          {
            libraryKey:"work-knowledge",
            displayName:"Synthetic Work",
            aliases:["Synthetic Work Library"],
            root:"/Volumes/test/LLW/work"
          },
          {
            libraryKey:"personal-knowledge",
            displayName:"Synthetic Personal",
            aliases:["Synthetic Personal Library"],
            root:"/Volumes/test/LLW/personal"
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
        tempRoot:"/Users/test/jobs/assistant",
        workspaceRoot:"/Users/test/workspaces/assistant",
        outputRoot:"/Users/test/output",
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

function run(file,capability,enabled) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[
      script,file,capability,enabled
    ],{stdio:["ignore","pipe","pipe"]});
    let stdout="",stderr="";
    child.stdout.on("data",chunk=>stdout+=chunk);
    child.stderr.on("data",chunk=>stderr+=chunk);
    child.once("error",reject);
    child.once("close",code=>resolve({code,stdout,stderr}));
  });
}

test("atomically toggles only one approved version-5 capability",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v5-toggle-"));
  const file=join(root,"config.json");
  const before=v5();
  await writeFile(file,`${JSON.stringify(before,null,2)}\n`,{mode:0o600});
  try {
    assert.deepEqual(
      await run(file,"knowledge-ingest","true"),
      {code:0,stdout:"",stderr:""}
    );
    const after=JSON.parse(await readFile(file,"utf8"));
    assert.deepEqual(after,{
      ...before,
      capabilities:{
        ...before.capabilities,
        "knowledge-ingest":{
          ...before.capabilities["knowledge-ingest"],enabled:true
        }
      }
    });
    assert.equal((await stat(file)).mode&0o777,0o600);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test("rejects unsafe toggle inputs without changing config bytes",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v5-toggle-unsafe-"));
  try {
    const cases=[
      ["unknown","mail-assistant","true",v5(),0o600],
      ["boolean","knowledge-ingest","yes",v5(),0o600],
      ["v4","knowledge-ingest","true",{...v5(),version:4},0o600],
      ["broad","assistant-work","true",v5(),0o644]
    ];
    for (const [name,capability,enabled,value,mode] of cases) {
      const file=join(root,`${name}.json`);
      const bytes=`${JSON.stringify(value,null,2)}\n`;
      await writeFile(file,bytes,{mode});
      await chmod(file,mode);
      assert.deepEqual(
        await run(file,capability,enabled),
        {code:1,stdout:"",stderr:""}
      );
      assert.equal(await readFile(file,"utf8"),bytes);
    }
    const target=join(root,"target.json"),link=join(root,"link.json");
    const bytes=`${JSON.stringify(v5(),null,2)}\n`;
    await writeFile(target,bytes,{mode:0o600});
    await symlink(target,link);
    assert.deepEqual(
      await run(link,"assistant-work","true"),
      {code:1,stdout:"",stderr:""}
    );
    assert.equal(await readFile(target,"utf8"),bytes);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});
