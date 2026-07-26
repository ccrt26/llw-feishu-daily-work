import test from "node:test";
import assert from "node:assert/strict";
import {chmod,mkdtemp,readFile,rm,stat,symlink,writeFile} from "node:fs/promises";
import {spawn} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

const script=fileURLToPath(new URL("../src/migrate-config-v5.mjs",import.meta.url));
const privateSkills={
  root:"/Volumes/test/LLW/.agents/skills",
  manifestPath:"/Volumes/test/LLW/.agents/skills/manifest.json",
  expectedManifestSha256:"a".repeat(64)
};
const knowledge={
  tempRoot:"/Users/test/knowledge-jobs",
  libraries:[
    {
      libraryKey:"work-knowledge",displayName:"Synthetic Work",
      aliases:["Synthetic Work Library"],root:"/Volumes/test/LLW/work"
    },
    {
      libraryKey:"personal-knowledge",displayName:"Synthetic Personal",
      aliases:["Synthetic Personal Library"],root:"/Volumes/test/LLW/personal"
    }
  ],
  maxSourceBytes:262144,
  aiTimeoutMs:120000,
  inputFormats:["text","txt","md"]
};
const assistant={
  tempRoot:"/Users/test/assistant-work-jobs",
  workspaceRoot:"/Users/test/assistant-workspace",
  maxSearchFiles:512,maxSearchFileBytes:262144,maxSearchResults:20,
  maxSourceExcerptBytes:262144,aiTimeoutMs:120000,allowedOutputFormats:[]
};

function v4() {
  return {
    version:4,vaultRoot:"/Volumes/test/LLW",
    stateFile:"/Users/test/state.json",heartbeatFile:"/Users/test/heartbeat.json",
    modelStateFile:"/Users/test/model-state",deepseekEnabled:true,deepseekModel:"deepseek-v4-pro",
    deepseekKeychainService:"com.llw.deepseek-api",deepseekKeychainAccount:"llw-assistant",
    wechatEnabled:true,wechatStateFile:"/Users/test/wechat-state.json",
    wechatKeychainService:"com.llw.wechat-ilink",wechatKeychainAccount:"llw-assistant",
    cliPath:"/Users/test/lark-cli",codexPath:"/Applications/ChatGPT.app/codex",
    profile:"private",senderId:"synthetic-user",chatId:"synthetic-chat",
    capabilities:{
      "daily-work":{enabled:true,skillRoot:"/Volumes/test/LLW/.agents/skills/feishu-daily-work"},
      invoice:{
        enabled:true,skillRoot:"/Volumes/test/LLW/.agents/skills/filing-invoices",
        tempRoot:"/Users/test/tmp",archiveRoot:"/Volumes/test/LLW/亚信工作/日常发票/餐饮发票",
        maxFileBytes:20971520,aiTimeoutMs:120000,
        pdfProcessorPath:"/Users/test/runtime/pdfium-processor.py",
        maxPdfPages:10,maxPdfTextBytes:262144,maxPdfRenderBytes:104857600,pdfPrepareTimeoutMs:60000
      }
    }
  };
}

function migrationArgs(knowledgeFile,assistantFile) {
  return [
    privateSkills.root,
    privateSkills.manifestPath,
    privateSkills.expectedManifestSha256,
    knowledgeFile,
    assistantFile
  ];
}

function run(file,args=[]) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[script,file,...args],{stdio:["ignore","pipe","pipe"]});
    let stdout="",stderr="";
    child.stdout.on("data",chunk=>stdout+=chunk);
    child.stderr.on("data",chunk=>stderr+=chunk);
    child.once("error",reject);
    child.once("close",code=>resolve({code,stdout,stderr}));
  });
}

test("atomically migrates exact version 4 to disabled version 5 knowledge metadata",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"llw-config-v5-migrate-"));
  const file=join(dir,"config.json");
  const knowledgeFile=join(dir,"knowledge.json");
  const assistantFile=join(dir,"assistant.json");
  const before=v4();
  await writeFile(file,`${JSON.stringify(before,null,2)}\n`,{mode:0o600});
  await writeFile(knowledgeFile,`${JSON.stringify(knowledge,null,2)}\n`,{mode:0o600});
  await writeFile(assistantFile,`${JSON.stringify(assistant,null,2)}\n`,{mode:0o600});
  try {
    assert.deepEqual(await run(file,migrationArgs(knowledgeFile,assistantFile)),{code:0,stdout:"",stderr:""});
    assert.deepEqual(JSON.parse(await readFile(file,"utf8")),{
      ...before,
      version:5,
      capabilities:{
        ...before.capabilities,
        "knowledge-ingest":{enabled:false,...knowledge},
        "assistant-work":{enabled:false,...assistant}
      },
      privateSkills
    });
    assert.equal((await stat(file)).mode&0o777,0o600);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("rejects invalid arguments, non-v4 input, broad mode and symlink without changing bytes",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"llw-config-v5-unsafe-"));
  try {
    const knowledgeFile=join(dir,"knowledge.json");
    const assistantFile=join(dir,"assistant.json");
    await writeFile(knowledgeFile,`${JSON.stringify(knowledge)}\n`,{mode:0o600});
    await writeFile(assistantFile,`${JSON.stringify(assistant)}\n`,{mode:0o600});
    const cases=[
      ["missing",v4(),0o600,[]],
      ["root",v4(),0o600,["relative",privateSkills.manifestPath,privateSkills.expectedManifestSha256,knowledgeFile,assistantFile]],
      ["manifest",v4(),0o600,[privateSkills.root,"/Volumes/test/other.json",privateSkills.expectedManifestSha256,knowledgeFile,assistantFile]],
      ["hash",v4(),0o600,[privateSkills.root,privateSkills.manifestPath,"A".repeat(64),knowledgeFile,assistantFile]],
      ["fragment",v4(),0o600,[privateSkills.root,privateSkills.manifestPath,privateSkills.expectedManifestSha256,"relative",assistantFile]],
      ["assistant-fragment",v4(),0o600,[privateSkills.root,privateSkills.manifestPath,privateSkills.expectedManifestSha256,knowledgeFile,"relative"]],
      ["v5",{...v4(),version:5,privateSkills},0o600,migrationArgs(knowledgeFile,assistantFile)],
      ["broad",v4(),0o644,migrationArgs(knowledgeFile,assistantFile)]
    ];
    for (const [name,value,mode,args] of cases) {
      const file=join(dir,`${name}.json`),bytes=`${JSON.stringify(value)}\n`;
      await writeFile(file,bytes,{mode}); await chmod(file,mode);
      const result=await run(file,args);
      assert.deepEqual(result,{code:1,stdout:"",stderr:""});
      assert.equal(await readFile(file,"utf8"),bytes);
    }
    const target=join(dir,"target.json"),link=join(dir,"link.json");
    const bytes=`${JSON.stringify(v4())}\n`;
    await writeFile(target,bytes,{mode:0o600}); await symlink(target,link);
    assert.deepEqual(await run(link,migrationArgs(knowledgeFile,assistantFile)),{code:1,stdout:"",stderr:""});
    assert.equal(await readFile(target,"utf8"),bytes);
    const broadKnowledge=join(dir,"broad-knowledge.json");
    await writeFile(broadKnowledge,`${JSON.stringify(knowledge)}\n`,{mode:0o644});
    await chmod(broadKnowledge,0o644);
    const safeFile=join(dir,"safe-config.json");
    const safeBytes=`${JSON.stringify(v4())}\n`;
    await writeFile(safeFile,safeBytes,{mode:0o600});
    assert.deepEqual(await run(safeFile,migrationArgs(broadKnowledge,assistantFile)),{code:1,stdout:"",stderr:""});
    const broadAssistant=join(dir,"broad-assistant.json");
    await writeFile(broadAssistant,`${JSON.stringify(assistant)}\n`,{mode:0o644});
    await chmod(broadAssistant,0o644);
    assert.deepEqual(
      await run(safeFile,migrationArgs(knowledgeFile,broadAssistant)),
      {code:1,stdout:"",stderr:""}
    );
    assert.equal(await readFile(safeFile,"utf8"),safeBytes);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
