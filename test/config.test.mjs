import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindingFromEvent, loadConfig, saveConfig, validatePdfTools } from "../src/config.mjs";

function config(overrides = {}) {
  const base = {
    version: 4,
    vaultRoot: "/Volumes/test/LLW",
    stateFile: "/Users/test/state.json", heartbeatFile: "/Users/test/heartbeat.json",
    modelStateFile: "/Users/test/model-state", deepseekEnabled: false,
    deepseekModel:"deepseek-v4-pro",deepseekKeychainService:"com.llw.deepseek-api",deepseekKeychainAccount:"llw-assistant",
    cliPath: "/Users/test/bin/lark-cli", codexPath: "/Applications/ChatGPT.app/codex",
    profile: "llw-private", senderId: "user-1", chatId: "chat-1",
    capabilities:{
      "daily-work":{enabled:true,skillRoot:"/Volumes/test/LLW/.agents/skills/feishu-daily-work"},
      invoice:{
        enabled:true,skillRoot:"/Volumes/test/LLW/.agents/skills/filing-invoices",tempRoot:"/Users/test/tmp/invoices",
        archiveRoot:"/Volumes/test/LLW/亚信工作/日常发票/餐饮发票",maxFileBytes:20971520,aiTimeoutMs:120000,
        pdfInfoPath:"/Users/test/bin/pdfinfo",pdfToTextPath:"/Users/test/bin/pdftotext",pdfToPpmPath:"/Users/test/bin/pdftoppm",
        maxPdfPages:10,maxPdfTextBytes:262144,maxPdfRenderBytes:104857600,pdfPrepareTimeoutMs:60000
      }
    }
  };
  return {...base,...overrides};
}

test("saves mode-0600 config and validates required absolute paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llw-config-"));
  const file = join(dir, "config.json");
  await saveConfig(file, config());
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await loadConfig(file), config());
  await assert.rejects(async () => saveConfig(file, config({vaultRoot: "relative"})), /invalid_config_path/);
  await assert.rejects(async () => saveConfig(file, config({version:3})), /invalid_config_version/);
  await assert.rejects(async () => saveConfig(file, config({modelStateFile:"relative"})), /invalid_config_path:modelStateFile/);
  await assert.rejects(async () => saveConfig(file, config({deepseekEnabled:"false"})), /invalid_deepseek_enabled/);
  await assert.rejects(async () => saveConfig(file, config({deepseekModel:"deepseek-v4-flash"})), /invalid_deepseek_model/);
  await assert.rejects(async () => saveConfig(file, config({deepseekModel:"deepseek-chat"})), /invalid_deepseek_model/);
  await assert.rejects(async () => saveConfig(file, config({deepseekKeychainService:""})), /invalid_deepseek_keychain_name/);
  await assert.rejects(async () => saveConfig(file, {...config(),deepseekBaseUrl:"https:\/\/example.com"}), /unknown_config_field/);
  for (const modelStateFile of [config().stateFile,config().heartbeatFile,config().cliPath,config().codexPath,config().capabilities.invoice.pdfInfoPath]) {
    await assert.rejects(async () => saveConfig(file, config({modelStateFile})), /invalid_model_state_file_alias/);
  }
  await assert.rejects(async () => saveConfig(file, config({capabilities:{...config().capabilities,invoice:{...config().capabilities.invoice,maxFileBytes:20971521}}})), /invalid_max_file_bytes/);
  await assert.rejects(async () => saveConfig(file, config({capabilities:{...config().capabilities,invoice:{...config().capabilities.invoice,typo:true}}})), /unknown_capability_field/);
  await assert.rejects(async () => saveConfig(file, {...config(),token:"secret"}), /unknown_config_field/);
});

test("loads deployed version-4 config without model or DeepSeek connection fields using safe disabled defaults",async () => {
  const dir=await mkdtemp(join(tmpdir(),"llw-config-legacy-v4-")); const file=join(dir,"config.json");
  try {
    const {modelStateFile,deepseekEnabled,deepseekModel,deepseekKeychainService,deepseekKeychainAccount,...legacy}=config();
    await writeFile(file,`${JSON.stringify(legacy)}\n`,{mode:0o600});
    assert.deepEqual(await loadConfig(file),{...legacy,modelStateFile:"/Users/test/model-state",deepseekEnabled:false,deepseekModel:"deepseek-v4-pro",deepseekKeychainService:"com.llw.deepseek-api",deepseekKeychainAccount:"llw-assistant"});
    await writeFile(file,`${JSON.stringify({...legacy,deepseekEnabled:true})}\n`,{mode:0o600});
    assert.equal((await loadConfig(file)).deepseekEnabled,false);
    await assert.rejects(()=>saveConfig(file,legacy),/missing_config_field/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("requires the fixed state-directory model path and rejects case-folded or symlinked aliases",async () => {
  const dir=await mkdtemp(join(tmpdir(),"llw-config-model-path-")); const file=join(dir,"config.json");
  const stateDir=join(dir,"state"); const target=join(dir,"target"); const alias=join(dir,"alias");
  try {
    await mkdir(stateDir,{mode:0o700}); await mkdir(target,{mode:0o700}); await symlink(target,alias);
    const base=config({stateFile:join(stateDir,"state.json"),heartbeatFile:join(stateDir,"heartbeat.json"),modelStateFile:join(stateDir,"model-state")});
    await assert.rejects(()=>saveConfig(file,{...base,modelStateFile:join(stateDir,"other-model")}),/invalid_model_state_file/);
    await assert.rejects(()=>saveConfig(file,{...base,heartbeatFile:join(stateDir,"MODEL-STATE")}),/invalid_model_state_file_alias/);
    const linked={...base,stateFile:join(alias,"state.json"),heartbeatFile:join(alias,"heartbeat.json"),modelStateFile:join(alias,"model-state")};
    await writeFile(file,`${JSON.stringify(linked)}\n`,{mode:0o600});
    await assert.rejects(()=>loadConfig(file),/unsafe_model_state_path/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("version 4 requires exact PDF limits and absolute tool paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llw-config-pdf-"));
  const file = join(dir, "config.json");
  try {
    await assert.doesNotReject(() => saveConfig(file, config()));
    for (const [field,value,code] of [
      ["maxPdfPages",11,"invalid_max_pdf_pages"],
      ["maxPdfTextBytes",262143,"invalid_max_pdf_text_bytes"],
      ["maxPdfRenderBytes",104857599,"invalid_max_pdf_render_bytes"],
      ["pdfPrepareTimeoutMs",59999,"invalid_pdf_prepare_timeout"]
    ]) {
      const invoice={...config().capabilities.invoice,[field]:value};
      await assert.rejects(() => saveConfig(file,config({capabilities:{...config().capabilities,invoice}})),new RegExp(code));
    }
    const invoice={...config().capabilities.invoice,pdfInfoPath:"pdfinfo"};
    await assert.rejects(() => saveConfig(file,config({capabilities:{...config().capabilities,invoice}})),/invalid_config_path/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("PDF tools must be executable regular files and never symbolic links", async () => {
  const dir=await mkdtemp(join(tmpdir(),"llw-pdf-tools-"));
  const executable=join(dir,"tool");
  const noExecute=join(dir,"no-execute");
  const directory=join(dir,"directory");
  const link=join(dir,"link");
  try {
    await writeFile(executable,"#!/bin/sh\nexit 0\n",{mode:0o700});
    await writeFile(noExecute,"x",{mode:0o600});
    await mkdir(directory);
    await symlink(executable,link);
    await assert.doesNotReject(() => validatePdfTools({pdfInfoPath:executable,pdfToTextPath:executable,pdfToPpmPath:executable}));
    for (const unsafe of [noExecute,directory,link]) {
      await assert.rejects(() => validatePdfTools({pdfInfoPath:unsafe,pdfToTextPath:executable,pdfToPpmPath:executable}),/unsafe_pdf_tool/);
    }
    await chmod(executable,0o600);
    await assert.rejects(() => validatePdfTools({pdfInfoPath:executable,pdfToTextPath:executable,pdfToPpmPath:executable}),/unsafe_pdf_tool/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("requires binding only for service startup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llw-config-unbound-"));
  const file = join(dir, "config.json");
  await saveConfig(file, config({senderId: null, chatId: null}), {requireBinding: false});
  await assert.rejects(() => loadConfig(file), /binding_missing/);
  assert.equal((await loadConfig(file, {requireBinding: false})).senderId, null);
});

test("binds only the exact phrase from a p2p text event", () => {
  const event = {sender_id: "user-1", chat_id: "chat-1", chat_type: "p2p", message_type: "text", content: "LLW-BIND-DAILY-WORK"};
  assert.deepEqual(bindingFromEvent(event), {senderId: "user-1", chatId: "chat-1"});
  assert.equal(bindingFromEvent({...event, chat_type: "group"}), null);
  assert.equal(bindingFromEvent({...event, message_type: "image"}), null);
  assert.equal(bindingFromEvent({...event, content: "other"}), null);
});
