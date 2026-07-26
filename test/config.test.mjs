import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindingFromEvent, loadConfig, saveConfig } from "../src/config.mjs";

function config(overrides = {}) {
  const base = {
    version: 4,
    vaultRoot: "/Volumes/test/LLW",
    stateFile: "/Users/test/state.json", heartbeatFile: "/Users/test/heartbeat.json",
    modelStateFile: "/Users/test/model-state", deepseekEnabled: false,
    deepseekModel:"deepseek-v4-pro",deepseekKeychainService:"com.llw.deepseek-api",deepseekKeychainAccount:"llw-assistant",
    wechatEnabled:false,wechatStateFile:"/Users/test/wechat-state.json",
    wechatKeychainService:"com.llw.wechat-ilink",wechatKeychainAccount:"llw-assistant",
    cliPath: "/Users/test/bin/lark-cli", codexPath: "/Applications/ChatGPT.app/codex",
    profile: "llw-private", senderId: "user-1", chatId: "chat-1",
    capabilities:{
      "daily-work":{enabled:true,skillRoot:"/Volumes/test/LLW/.agents/skills/feishu-daily-work"},
      invoice:{
        enabled:true,skillRoot:"/Volumes/test/LLW/.agents/skills/filing-invoices",tempRoot:"/Users/test/tmp/invoices",
        archiveRoot:"/Volumes/test/LLW/亚信工作/日常发票/餐饮发票",maxFileBytes:20971520,aiTimeoutMs:120000,
        pdfProcessorPath:"/Users/test/runtime/pdfium-5.11.0/pdfium-processor.py",
        maxPdfPages:10,maxPdfTextBytes:262144,maxPdfRenderBytes:104857600,pdfPrepareTimeoutMs:60000
      }
    }
  };
  return {...base,...overrides};
}

function configV5(overrides={}) {
  const base=config();
  return {
    ...base,
    version:5,
    privateSkills:{
      root:"/Volumes/test/LLW/.agents/skills",
      manifestPath:"/Volumes/test/LLW/.agents/skills/manifest.json",
      expectedManifestSha256:"a".repeat(64)
    },
    capabilities:{
      ...base.capabilities,
      "knowledge-ingest":knowledgeConfig(),
      "assistant-work":assistantConfig()
    },
    ...overrides
  };
}

function assistantConfig(overrides={}) {
  return {
    enabled:false,
    tempRoot:"/Users/test/tmp/assistant-work",
    workspaceRoot:"/Users/test/assistant-workspace",
    outputRoot:"/Users/test/assistant-output",
    maxSearchFiles:512,
    maxSearchFileBytes:262144,
    maxSearchResults:20,
    maxSourceExcerptBytes:262144,
    aiTimeoutMs:120000,
    maxOutputBytes:20971520,
    allowedOutputFormats:["docx","pptx","xlsx"],
    ...overrides
  };
}

function knowledgeConfig(overrides={}) {
  return {
    enabled:false,
    tempRoot:"/Users/test/tmp/knowledge",
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
    inputFormats:["text","txt","md"],
    ...overrides
  };
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
  await assert.rejects(async () => saveConfig(file, config({wechatEnabled:"false"})), /invalid_wechat_enabled/);
  await assert.rejects(async () => saveConfig(file, config({wechatStateFile:"relative"})), /invalid_config_path:wechatStateFile/);
  await assert.rejects(async () => saveConfig(file, config({wechatKeychainService:""})), /invalid_wechat_keychain_name/);
  await assert.rejects(async () => saveConfig(file, {...config(),deepseekBaseUrl:"https:\/\/example.com"}), /unknown_config_field/);
  for (const modelStateFile of [config().stateFile,config().heartbeatFile,config().cliPath,config().codexPath,config().capabilities.invoice.pdfProcessorPath]) {
    await assert.rejects(async () => saveConfig(file, config({modelStateFile})), /invalid_model_state_file_alias/);
  }
  await assert.rejects(async () => saveConfig(file, config({capabilities:{...config().capabilities,invoice:{...config().capabilities.invoice,maxFileBytes:20971521}}})), /invalid_max_file_bytes/);
  await assert.rejects(async () => saveConfig(file, config({capabilities:{...config().capabilities,invoice:{...config().capabilities.invoice,typo:true}}})), /unknown_capability_field/);
  await assert.rejects(async () => saveConfig(file, {...config(),token:"secret"}), /unknown_config_field/);
});

test("loads deployed version-4 config without model or DeepSeek connection fields using safe disabled defaults",async () => {
  const dir=await mkdtemp(join(tmpdir(),"llw-config-legacy-v4-")); const file=join(dir,"config.json");
  try {
    const {
      modelStateFile,deepseekEnabled,deepseekModel,deepseekKeychainService,deepseekKeychainAccount,
      wechatEnabled,wechatStateFile,wechatKeychainService,wechatKeychainAccount,
      ...legacy
    }=config();
    await writeFile(file,`${JSON.stringify(legacy)}\n`,{mode:0o600});
    assert.deepEqual(await loadConfig(file),{
      ...legacy,
      modelStateFile:"/Users/test/model-state",
      deepseekEnabled:false,deepseekModel:"deepseek-v4-pro",
      deepseekKeychainService:"com.llw.deepseek-api",deepseekKeychainAccount:"llw-assistant",
      wechatEnabled:false,wechatStateFile:"/Users/test/wechat-state.json",
      wechatKeychainService:"com.llw.wechat-ilink",wechatKeychainAccount:"llw-assistant"
    });
    await writeFile(file,`${JSON.stringify({...legacy,deepseekEnabled:true})}\n`,{mode:0o600});
    assert.equal((await loadConfig(file)).deepseekEnabled,false);
    await writeFile(file,`${JSON.stringify({...legacy,wechatEnabled:true})}\n`,{mode:0o600});
    assert.equal((await loadConfig(file)).wechatEnabled,false);
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

test("version 4 requires exact PDF limits and one absolute processor path", async () => {
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
    const invoice={...config().capabilities.invoice,pdfProcessorPath:"pdfium-processor.py"};
    await assert.rejects(() => saveConfig(file,config({capabilities:{...config().capabilities,invoice}})),/invalid_config_path/);
    for (const legacy of ["pdfInfoPath","pdfToTextPath","pdfToPpmPath"]) {
      const mixed={...config().capabilities.invoice,[legacy]:"/legacy/tool"};
      await assert.rejects(()=>saveConfig(file,config({capabilities:{...config().capabilities,invoice:mixed}})),/unknown_capability_field/);
    }
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("requires binding only for service startup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llw-config-unbound-"));
  const file = join(dir, "config.json");
  await saveConfig(file, config({senderId: null, chatId: null}), {requireBinding: false});
  await assert.rejects(() => loadConfig(file), /binding_missing/);
  assert.equal((await loadConfig(file, {requireBinding: false})).senderId, null);
});

test("version 5 requires one exact private Skill root, manifest and expected hash",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"llw-config-v5-"));
  const file=join(dir,"config.json");
  try {
    await saveConfig(file,configV5());
    assert.deepEqual(await loadConfig(file),configV5());
    for (const privateSkills of [
      {...configV5().privateSkills,root:"relative"},
      {...configV5().privateSkills,manifestPath:"relative"},
      {...configV5().privateSkills,manifestPath:"/Volumes/test/LLW/.agents/other.json"},
      {...configV5().privateSkills,expectedManifestSha256:"A".repeat(64)},
      {...configV5().privateSkills,expectedManifestSha256:"a".repeat(63)},
      {...configV5().privateSkills,extra:true}
    ]) {
      await assert.rejects(
        ()=>saveConfig(file,configV5({privateSkills})),
        /invalid_private_skills|invalid_config_path|unknown_private_skills_field/
      );
    }
    const {privateSkills,...missing}=configV5();
    await assert.rejects(()=>saveConfig(file,missing),/missing_config_field/);
    await assert.rejects(()=>saveConfig(file,{...configV5(),version:6}),/invalid_config_version/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("version 5 requires one disabled exact knowledge-ingest configuration with disjoint managed roots",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"llw-config-v5-knowledge-"));
  const file=join(dir,"config.json");
  try {
    await assert.doesNotReject(()=>saveConfig(file,configV5()));
    const cases=[
      knowledgeConfig({enabled:true}),
      knowledgeConfig({tempRoot:"relative"}),
      knowledgeConfig({maxSourceBytes:262143}),
      knowledgeConfig({aiTimeoutMs:119999}),
      knowledgeConfig({inputFormats:["text","md"]}),
      knowledgeConfig({inputFormats:["text","txt","md","docx"]}),
      knowledgeConfig({extra:true}),
      knowledgeConfig({libraries:[knowledgeConfig().libraries[0]]}),
      knowledgeConfig({libraries:[
        knowledgeConfig().libraries[0],
        {...knowledgeConfig().libraries[1],libraryKey:"work-knowledge"}
      ]}),
      knowledgeConfig({libraries:[
        knowledgeConfig().libraries[0],
        {...knowledgeConfig().libraries[1],root:"/Volumes/test/LLW/work/nested"}
      ]}),
      knowledgeConfig({libraries:[
        knowledgeConfig().libraries[0],
        {...knowledgeConfig().libraries[1],aliases:["Synthetic Work Library"]}
      ]}),
      knowledgeConfig({libraries:[
        {...knowledgeConfig().libraries[0],root:"relative"},
        knowledgeConfig().libraries[1]
      ]}),
      knowledgeConfig({libraries:[
        {...knowledgeConfig().libraries[0],displayName:".hidden"},
        knowledgeConfig().libraries[1]
      ]})
    ];
    for (const knowledge of cases) {
      await assert.rejects(
        ()=>saveConfig(file,configV5({capabilities:{
          ...configV5().capabilities,
          "knowledge-ingest":knowledge
        }})),
        /knowledge|capability|config_path/
      );
    }
    const missing={...configV5(),capabilities:{...configV5().capabilities}};
    delete missing.capabilities["knowledge-ingest"];
    await assert.rejects(()=>saveConfig(file,missing),/capabilities|capability/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("version 5 requires one disabled exact assistant-work candidate configuration",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"llw-config-v5-assistant-"));
  const file=join(dir,"config.json");
  try {
    await assert.doesNotReject(()=>saveConfig(file,configV5()));
    for (const assistant of [
      assistantConfig({enabled:true}),
      assistantConfig({tempRoot:"relative"}),
      assistantConfig({workspaceRoot:"relative"}),
      assistantConfig({outputRoot:"relative"}),
      assistantConfig({maxSearchFiles:511}),
      assistantConfig({maxSearchFileBytes:262143}),
      assistantConfig({maxSearchResults:19}),
      assistantConfig({maxSourceExcerptBytes:262143}),
      assistantConfig({aiTimeoutMs:119999}),
      assistantConfig({maxOutputBytes:20971519}),
      assistantConfig({allowedOutputFormats:["docx"]}),
      assistantConfig({allowedOutputFormats:["docx","xlsx","pptx"]}),
      assistantConfig({extra:true}),
      assistantConfig({tempRoot:knowledgeConfig().tempRoot}),
      assistantConfig({outputRoot:knowledgeConfig().tempRoot}),
      assistantConfig({outputRoot:"/Users/test/assistant-workspace/output"}),
      assistantConfig({workspaceRoot:"/Volumes/test/LLW/workspace"})
    ]) {
      await assert.rejects(()=>saveConfig(file,configV5({capabilities:{
        ...configV5().capabilities,"assistant-work":assistant
      }})),/assistant|capability|config_path/);
    }
    const missing={...configV5(),capabilities:{...configV5().capabilities}};
    delete missing.capabilities["assistant-work"];
    await assert.rejects(()=>saveConfig(file,missing),/capabilities|capability/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("binds only the exact phrase from a p2p text event", () => {
  const event = {sender_id: "user-1", chat_id: "chat-1", chat_type: "p2p", message_type: "text", content: "LLW-BIND-DAILY-WORK"};
  assert.deepEqual(bindingFromEvent(event), {senderId: "user-1", chatId: "chat-1"});
  assert.equal(bindingFromEvent({...event, chat_type: "group"}), null);
  assert.equal(bindingFromEvent({...event, message_type: "image"}), null);
  assert.equal(bindingFromEvent({...event, content: "other"}), null);
});
