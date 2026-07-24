import test from "node:test";
import assert from "node:assert/strict";
import {chmod,mkdtemp,readFile,rm,stat,symlink,writeFile} from "node:fs/promises";
import {spawn} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

const script=fileURLToPath(new URL("../src/migrate-config-v4.mjs",import.meta.url));
const pdfFields={
  pdfInfoPath:"/runtime/pdfinfo",pdfToTextPath:"/runtime/pdftotext",pdfToPpmPath:"/runtime/pdftoppm",
  maxPdfPages:10,maxPdfTextBytes:262144,maxPdfRenderBytes:104857600,pdfPrepareTimeoutMs:60000
};

function v3() {
  return {
    version:3,vaultRoot:"/Volumes/test/LLW",stateFile:"/Users/test/state.json",heartbeatFile:"/Users/test/heartbeat.json",
    cliPath:"/Users/test/lark-cli",codexPath:"/Applications/ChatGPT.app/codex",profile:"private",
    senderId:"ou_private_sender",chatId:"oc_private_chat",
    capabilities:{
      "daily-work":{enabled:true,skillRoot:"/Volumes/test/LLW/.agents/skills/feishu-daily-work"},
      invoice:{enabled:true,skillRoot:"/Volumes/test/LLW/.agents/skills/filing-invoices",tempRoot:"/Users/test/tmp",archiveRoot:"/Volumes/test/LLW/亚信工作/日常发票/餐饮发票",maxFileBytes:20971520,aiTimeoutMs:120000}
    }
  };
}

function run(file) {
  return new Promise((resolve,reject) => {
    const child=spawn(process.execPath,[script,file],{env:{...process.env,LLW_PDFINFO_PATH:pdfFields.pdfInfoPath,LLW_PDFTOTEXT_PATH:pdfFields.pdfToTextPath,LLW_PDFTOPPM_PATH:pdfFields.pdfToPpmPath},stdio:["ignore","pipe","pipe"]});
    let stdout="",stderr="";
    child.stdout.on("data",chunk => stdout+=chunk);
    child.stderr.on("data",chunk => stderr+=chunk);
    child.once("error",reject);
    child.once("close",code => resolve({code,stdout,stderr}));
  });
}

test("atomically migrates exact v3 to v4 without printing protected values",async () => {
  const dir=await mkdtemp(join(tmpdir(),"llw-config-migrate-"));
  const file=join(dir,"config.json");
  const before=v3();
  await writeFile(file,`${JSON.stringify(before,null,2)}\n`,{mode:0o600});
  try {
    const result=await run(file);
    assert.deepEqual(result,{code:0,stdout:"",stderr:""});
    const after=JSON.parse(await readFile(file,"utf8"));
    assert.equal(after.version,4);
    assert.equal(after.modelStateFile,"/Users/test/model-state");
    assert.equal(after.deepseekEnabled,false);
    assert.equal(after.deepseekModel,"deepseek-v4-pro");
    assert.equal(after.deepseekKeychainService,"com.llw.deepseek-api");
    assert.equal(after.deepseekKeychainAccount,"llw-assistant");
    assert.equal(after.wechatEnabled,false);
    assert.equal(after.wechatStateFile,"/Users/test/wechat-state.json");
    assert.equal(after.wechatKeychainService,"com.llw.wechat-ilink");
    assert.equal(after.wechatKeychainAccount,"llw-assistant");
    assert.deepEqual(after.capabilities.invoice,{...before.capabilities.invoice,...pdfFields});
    const {
      modelStateFile,deepseekEnabled,deepseekModel,deepseekKeychainService,deepseekKeychainAccount,
      wechatEnabled,wechatStateFile,wechatKeychainService,wechatKeychainAccount,
      ...withoutModelFields
    }=after;
    assert.deepEqual({...withoutModelFields,version:3,capabilities:{...after.capabilities,invoice:before.capabilities.invoice}},before);
    assert.equal((await stat(file)).mode & 0o777,0o600);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("rejects v4, broad permissions and symbolic links without changing bytes",async () => {
  const dir=await mkdtemp(join(tmpdir(),"llw-config-migrate-unsafe-"));
  try {
    for (const [name,value,mode] of [["v4",{...v3(),version:4},0o600],["broad",v3(),0o644]]) {
      const file=join(dir,`${name}.json`); const bytes=`${JSON.stringify(value)}\n`;
      await writeFile(file,bytes,{mode}); await chmod(file,mode);
      const result=await run(file);
      assert.equal(result.code,1); assert.equal(result.stdout,""); assert.equal(result.stderr,"");
      assert.equal(await readFile(file,"utf8"),bytes);
    }
    const target=join(dir,"target.json"),link=join(dir,"link.json");
    await writeFile(target,`${JSON.stringify(v3())}\n`,{mode:0o600}); await symlink(target,link);
    const result=await run(link);
    assert.equal(result.code,1); assert.equal(result.stdout,""); assert.equal(result.stderr,"");
    assert.equal(JSON.parse(await readFile(target,"utf8")).version,3);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
