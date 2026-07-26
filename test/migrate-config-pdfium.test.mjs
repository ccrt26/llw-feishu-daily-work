import test from "node:test";
import assert from "node:assert/strict";
import {chmod,mkdtemp,readFile,rm,stat,symlink,writeFile} from "node:fs/promises";
import {spawn} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

const script=fileURLToPath(new URL("../src/migrate-config-pdfium.mjs",import.meta.url));
const processor="/Users/test/runtime/pdfium-5.11.0/pdfium-processor.py";

function oldConfig() {
  return {
    version:4,vaultRoot:"/Volumes/test/LLW",stateFile:"/Users/test/state.json",heartbeatFile:"/Users/test/heartbeat.json",
    modelStateFile:"/Users/test/model-state",deepseekEnabled:true,deepseekModel:"deepseek-v4-pro",
    deepseekKeychainService:"com.llw.deepseek-api",deepseekKeychainAccount:"llw-assistant",
    wechatEnabled:true,wechatStateFile:"/Users/test/wechat-state.json",
    wechatKeychainService:"com.llw.wechat-ilink",wechatKeychainAccount:"llw-assistant",
    cliPath:"/Users/test/lark-cli",codexPath:"/Applications/ChatGPT.app/codex",profile:"private",
    senderId:"private-sender",chatId:"private-chat",
    capabilities:{
      "daily-work":{enabled:true,skillRoot:"/Volumes/test/LLW/.agents/skills/feishu-daily-work"},
      invoice:{
        enabled:true,skillRoot:"/Volumes/test/LLW/.agents/skills/filing-invoices",tempRoot:"/Users/test/tmp",
        archiveRoot:"/Volumes/test/LLW/亚信工作/日常发票/餐饮发票",maxFileBytes:20971520,aiTimeoutMs:120000,
        pdfInfoPath:"/old/pdfinfo",pdfToTextPath:"/old/pdftotext",pdfToPpmPath:"/old/pdftoppm",
        maxPdfPages:10,maxPdfTextBytes:262144,maxPdfRenderBytes:104857600,pdfPrepareTimeoutMs:60000
      }
    }
  };
}

function run(file) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[script,file,processor],{stdio:["ignore","pipe","pipe"]});
    let stdout="",stderr="";
    child.stdout.on("data",chunk=>stdout+=chunk);
    child.stderr.on("data",chunk=>stderr+=chunk);
    child.once("error",reject);
    child.once("close",code=>resolve({code,stdout,stderr}));
  });
}

test("atomically replaces only three Poppler fields in an exact version-4 config",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"llw-config-pdfium-migrate-")),file=join(dir,"config.json");
  const before=oldConfig();
  await writeFile(file,`${JSON.stringify(before,null,2)}\n`,{mode:0o600});
  try {
    assert.deepEqual(await run(file),{code:0,stdout:"",stderr:""});
    const after=JSON.parse(await readFile(file,"utf8"));
    const expected=structuredClone(before);
    delete expected.capabilities.invoice.pdfInfoPath;
    delete expected.capabilities.invoice.pdfToTextPath;
    delete expected.capabilities.invoice.pdfToPpmPath;
    expected.capabilities.invoice.pdfProcessorPath=processor;
    assert.deepEqual(after,expected);
    assert.equal((await stat(file)).mode&0o777,0o600);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("rejects already migrated, mixed, broad-mode and symlink configs without changing bytes",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"llw-config-pdfium-unsafe-"));
  try {
    const migrated=oldConfig();
    delete migrated.capabilities.invoice.pdfInfoPath;
    delete migrated.capabilities.invoice.pdfToTextPath;
    delete migrated.capabilities.invoice.pdfToPpmPath;
    migrated.capabilities.invoice.pdfProcessorPath=processor;
    const mixed={...oldConfig()};
    mixed.capabilities={...mixed.capabilities,invoice:{...mixed.capabilities.invoice,pdfProcessorPath:processor}};
    for (const [name,value,mode] of [["migrated",migrated,0o600],["mixed",mixed,0o600],["broad",oldConfig(),0o644]]) {
      const file=join(dir,`${name}.json`),bytes=`${JSON.stringify(value)}\n`;
      await writeFile(file,bytes,{mode}); await chmod(file,mode);
      assert.equal((await run(file)).code,1);
      assert.equal(await readFile(file,"utf8"),bytes);
    }
    const target=join(dir,"target.json"),link=join(dir,"link.json");
    await writeFile(target,`${JSON.stringify(oldConfig())}\n`,{mode:0o600}); await symlink(target,link);
    assert.equal((await run(link)).code,1);
    assert.equal(JSON.parse(await readFile(target,"utf8")).capabilities.invoice.pdfInfoPath,"/old/pdfinfo");
  } finally { await rm(dir,{recursive:true,force:true}); }
});
