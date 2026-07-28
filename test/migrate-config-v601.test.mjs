import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,mkdtemp,readFile,rm,symlink,writeFile
} from "node:fs/promises";
import {spawn} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

const script=fileURLToPath(
  new URL("../src/migrate-config-v601.mjs",import.meta.url)
);

test("atomically adds the AI-first source limits to the exact legacy V6 shape",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-migrate-v601-"));
  const file=join(root,"config.json");
  const before=legacyV6();
  await writeFile(file,`${JSON.stringify(before,null,2)}\n`,{mode:0o600});
  try {
    assert.deepEqual(await run(file,"b".repeat(64)),{
      code:0,stdout:"",stderr:""
    });
    assert.deepEqual(JSON.parse(await readFile(file,"utf8")),{
      ...before,
      privateSkills:{
        ...before.privateSkills,expectedManifestSha256:"b".repeat(64)
      },
      personalAssistant:{
        ...before.personalAssistant,
        maxSourcesPerTurn:8,maxSourceFileBytes:20*1024*1024,
        maxTurnSourceBytes:80*1024*1024,
        sourceBurstQuietMs:3_000,sourceBurstMaxMs:15_000
      }
    });
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test("rejects non-legacy, broad, symlinked and malformed inputs byte-for-byte",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-migrate-v601-reject-"));
  try {
    const cases=[
      ["already-new",{
        ...legacyV6(),
        personalAssistant:{
          ...legacyV6().personalAssistant,
          maxSourcesPerTurn:8,maxSourceFileBytes:20*1024*1024,
          maxTurnSourceBytes:80*1024*1024,
          sourceBurstQuietMs:3_000,sourceBurstMaxMs:15_000
        }
      }],
      ["extra-field",{
        ...legacyV6(),
        personalAssistant:{
          ...legacyV6().personalAssistant,unexpected:true
        }
      }],
      ["wrong-value",{
        ...legacyV6(),
        personalAssistant:{
          ...legacyV6().personalAssistant,maxContextBytes:1
        }
      }]
    ];
    for (const [name,value] of cases) {
      const file=join(root,`${name}.json`);
      const bytes=`${JSON.stringify(value,null,2)}\n`;
      await writeFile(file,bytes,{mode:0o600});
      assert.deepEqual(await run(file,"b".repeat(64)),{
        code:1,stdout:"",stderr:""
      });
      assert.equal(await readFile(file,"utf8"),bytes);
    }
    const broad=join(root,"broad.json");
    const broadBytes=`${JSON.stringify(legacyV6())}\n`;
    await writeFile(broad,broadBytes,{mode:0o640});
    assert.deepEqual(await run(broad,"b".repeat(64)),{
      code:1,stdout:"",stderr:""
    });
    assert.equal(await readFile(broad,"utf8"),broadBytes);

    const target=join(root,"target.json");
    const targetBytes=`${JSON.stringify(legacyV6())}\n`;
    await writeFile(target,targetBytes,{mode:0o600});
    const link=join(root,"link.json");
    await symlink(target,link);
    assert.deepEqual(await run(link,"b".repeat(64)),{
      code:1,stdout:"",stderr:""
    });
    assert.equal(await readFile(target,"utf8"),targetBytes);

    await chmod(broad,0o600);
    assert.deepEqual(await run(broad,"A".repeat(64)),{
      code:1,stdout:"",stderr:""
    });
    assert.equal(await readFile(broad,"utf8"),broadBytes);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

function legacyV6() {
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
      root:"/Volumes/test/LLW/.agents/skills",
      manifestPath:"/Volumes/test/LLW/.agents/skills/manifest.json",
      expectedManifestSha256:"a".repeat(64)
    },
    personalAssistant:{
      enabled:true,skillName:"llw-personal-assistant",
      aiTimeoutMs:120000,maxContextBytes:524288,
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
