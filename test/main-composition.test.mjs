import test from "node:test";
import assert from "node:assert/strict";
import {mkdir,mkdtemp,readFile,realpath,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

test("production entry accepts only V7 and loads no retired routing layer",async()=>{
  const main=await readFile(
    fileURLToPath(new URL("../src/main.mjs",import.meta.url)),"utf8"
  );
  for (const forbidden of [
    "feishu-intent-router",
    "buildCapabilityRegistry",
    "createRouterTextTask",
    "createRouterVisualTask",
    "validateIntentRouterSkill",
    "createKnowledgeIngestCapability",
    "createAssistantWorkCapability",
    "knowledge_source_incomplete"
  ]) assert.equal(main.includes(forbidden),false,forbidden);
  assert.match(
    main,
    /if \(config\.version!==7\) \{\s*throw new Error\("config_migration_required"\);\s*\}/
  );
  assert.equal(main.includes("legacy-main"),false);
});

test("version 7 enters one personal-assistant composition",async()=>{
  const source=await readFile(
    fileURLToPath(new URL("../src/main.mjs",import.meta.url)),"utf8"
  );
  assert.match(
    source,
    /if \(config\.version!==7\) \{[\s\S]*?config_migration_required[\s\S]*?\}\s*await runPersonalAssistantMain\(config\);/
  );
  for (const expected of [
    "PersonalAssistantClient","createAssistantSourcePreparer",
    "PersonalAssistantCoordinator","PersonalAssistantDispatcher",
    "invokePersonalAssistantCodex","invokePersonalAssistantDeepSeek",
    "loadPersonalAssistantSkillBundle",
    "PersonalRulesStore","PersonalAssistantTaskSessionManager",
    "TaskSourceWorkspace"
  ]) assert.equal(source.includes(expected),true);
  for (const expected of [
    "TaskPdfReader",
    "mediaInputGates:config.mediaInputGates",
    "cancelTaskWork:value=>coordinator.cancelTaskWork(value)",
    "createBilibiliPublicAdapter",
    "createVolcengineVideoAsrAdapter",
    "ExternalVideoAsrUsageStore",
    "createVideoTimelineReaderAdapter",
    "createPublicVideoSourcePreparer",
    "createTurnSourcePreparerWithPublicVideo",
    "TaskPublicVideoReader",
    "SourceReader",
    "inspectIsoBmffMediaHeader",
    "createDouyinPublicAdapter",
    "createDouyinWebKitReaderAdapter"
  ]) assert.equal(source.includes(expected),true);
  assert.match(
    source,
    /config\.mediaInputGates\.bilibiliEnabled[\s\S]*?config\.mediaInputGates\.douyinEnabled[\s\S]*?VIDEO_TIMELINE_HELPER_PATH[\s\S]*?VIDEO_TIMELINE_HELPER_SHA256[\s\S]*?DOUYIN_WEBKIT_HELPER_PATH[\s\S]*?DOUYIN_WEBKIT_HELPER_SHA256/
  );
  assert.match(
    source,
    /keychainService:\s*"com\.llw\.assistant\.volcengine\.video-asr\.api-key"[\s\S]*?keychainAccount:"llw-assistant"/
  );
  assert.match(
    source,
    /new PersonalAssistantCoordinator\(\{[\s\S]*?sourceReader:publicVideoRuntime\.sourceReader[\s\S]*?publicVideoReader:publicVideoRuntime\.publicVideoReader/
  );
  assert.match(
    source,
    /config\.personalAssistant\.personalRulesFile\s*\?\s*await PersonalRulesStore\.open/
  );
  assert.match(
    source,
    /personalRulesStore,\s*\n\s*taskManager,taskWorkspace/
  );
  for (const expected of [
    "const basePrepareTurnSources=createAssistantSourcePreparer({",
    "maxSourcesPerTurn:config.personalAssistant.maxSourcesPerTurn",
    "maxTurnSourceBytes:config.personalAssistant.maxTurnSourceBytes",
    "const feishuDocumentExporter=createFeishuDocumentExporter({",
    "exportFeishuDocument:feishuDocumentExporter.exportSnapshot",
    "workspaceDir",
    "sourceBurstQuietMs:config.personalAssistant.sourceBurstQuietMs",
    "sourceBurstMaxMs:config.personalAssistant.sourceBurstMaxMs",
    "sourceBurstAttachmentQuietMs:config.personalAssistant.sourceBurstMaxMs"
  ]) assert.equal(source.includes(expected),true);
  assert.equal(
    (source.match(/new PersonalAssistantTaskSessionManager\(\{/gu)||[])
      .length,
    1
  );
  assert.equal(
    (source.match(/new TaskSourceWorkspace\(\{/gu)||[]).length,
    1
  );
  assert.match(
    source,
    /root:join\(dirname\(config\.stateFile\),"task-sources"\)/
  );
  assert.match(
    source,
    /taskManager,taskWorkspace[\s\S]*?skillVersion:"4\.4\.0"/
  );
  assert.match(
    source,
    /skillBundle=await loadPersonalAssistantSkillBundle\(\{[\s\S]*?runtimeFiles:skillEntry\.runtimeFiles/
  );
  assert.match(
    source,
    /invokePersonalAssistantCodex\(\{[\s\S]*?skillBundle,context,imageFiles/
  );
  assert.match(
    source,
    /workspaceDir,imageFiles,modelImageFiles,allowSourceRead[\s\S]*?invokePersonalAssistantCodex\(\{[\s\S]*?allowSourceRead/
  );
  assert.match(
    source,
    /taskManager,taskWorkspace,[\s\S]*?new PersonalAssistantDispatcher/
  );
  assert.match(source,/await dispatcher\.recoverPendingTasks\(\)/);
  const mainStart=source.indexOf("async function runPersonalAssistantMain");
  const mainComposition=source.slice(
    mainStart,source.indexOf("\nexport async function startChatEntries",mainStart)
  );
  assert.equal(mainComposition.includes("prepareKnowledgeOfficeFile"),false);
  assert.equal(mainComposition.includes("createSourceEvidence"),false);
  assert.equal(mainComposition.includes("knowledge_source_incomplete"),false);
  assert.equal(mainComposition.includes("workspaceRoot:config.vaultRoot"),false);
  assert.equal(mainComposition.includes("conversationStore:"),false);
  const {
    PERSONAL_ASSISTANT_PRIVATE_SKILL_ALLOWLIST,
    VIDEO_TIMELINE_HELPER_PATH,
    VIDEO_TIMELINE_HELPER_SHA256
  }=await import("../src/main.mjs");
  assert.deepEqual(PERSONAL_ASSISTANT_PRIVATE_SKILL_ALLOWLIST,[{
    name:"llw-personal-assistant",
    capability:"personal-assistant",
    versions:["4.4.0"],
    semanticTasks:["personal-assistant.turn"],
    modelSupport:["codex","deepseek"],
    enabled:true
  }]);
  assert.equal(
    VIDEO_TIMELINE_HELPER_PATH,
    "/Users/ccrt/Library/Application Support/LLW Assistant/runtime/video-timeline-reader-v2/video_timeline_reader_v2"
  );
  assert.equal(
    VIDEO_TIMELINE_HELPER_SHA256,
    "4f967d8a45cbc2c7c517c8222619be1dd585a2269110f78723b94a50275039d6"
  );
});

test("startup explicitly migrates a live per-channel waiting conversation",async()=>{
  const source=await readFile(
    fileURLToPath(new URL("../src/main.mjs",import.meta.url)),"utf8"
  );
  assert.match(
    source,
    /StateStore\.open\(config\.stateFile,\{\s*migratePersonalAssistantConversations:true\s*\}\)/
  );
});

test("production model selection executes the unified wiring",async()=>{
  const {createPersonalAssistantModelSelector}=await import("../src/main.mjs");
  let reads=0;
  const selectModel=createPersonalAssistantModelSelector({
    modelMode:{async read(){reads+=1;return "codex";}},
    deepseekEnabled:true
  });
  assert.equal(await selectModel(),"codex");
  assert.equal(reads,1);
});

test("public-video production composition stays inert until one approved gate is enabled",async()=>{
  const {
    createPublicVideoProductionComposition
  }=await import("../src/main.mjs");
  const root=await mkdtemp(join(tmpdir(),"llw-bili-composition-"));
  const basePreparer=async()=>({
    instructionText:"text",sources:[],cleanup:async()=>{}
  });
  try {
    const disabled=await createPublicVideoProductionComposition({
      bilibiliEnabled:false,douyinEnabled:false,
      basePreparer,stateRoot:root
    });
    assert.equal(disabled.prepareTurnSources,basePreparer);
    assert.equal(disabled.publicVideoReader,null);
    assert.equal(disabled.sourceReader,null);

    const enabled=await createPublicVideoProductionComposition({
      bilibiliEnabled:true,douyinEnabled:true,
      basePreparer,stateRoot:root
    });
    assert.notEqual(enabled.prepareTurnSources,basePreparer);
    assert.equal(
      typeof enabled.publicVideoReader.prepare,
      "function"
    );
    assert.equal(typeof enabled.sourceReader.read,"function");
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test("personal-assistant failures use the existing bounded analyze log",async()=>{
  const {createPersonalAssistantFailureLogger}=await import("../src/main.mjs");
  const lines=[];
  const logger=createPersonalAssistantFailureLogger(
    value=>lines.push(value)
  );
  logger("assistant_model_failed");
  assert.equal(lines.length,1);
  const parsed=JSON.parse(lines[0]);
  assert.equal(parsed.stage,"analyze");
  assert.equal(parsed.code,"assistant_model_failed");
  assert.deepEqual(
    Object.keys(parsed).sort(),
    ["code","correlation","stage","time"].sort()
  );
});

test("main validates one protected PDFium runtime before state and injects one bounded Source Intake",async () => {
  const source=await readFile(fileURLToPath(new URL("../src/main.mjs",import.meta.url)),"utf8");
  assert.match(source,/import \{loadConfig\} from "\.\/config\.mjs"/);
  assert.equal(source.includes("validatePdfiumRuntime"),true);
  assert.equal(source.includes("createAssistantSourcePreparer"),true);
  assert.ok(source.indexOf("await validatePdfiumRuntime(invoiceConfig.pdfProcessorPath)") < source.indexOf("StateStore.open"));
  for (const field of [
    "maxSourcesPerTurn","maxSourceFileBytes","maxTurnSourceBytes"
  ]) {
    assert.match(source,new RegExp(`config\\.personalAssistant\\.${field}`));
  }
  for (const legacy of ["pdfInfoPath","pdfToTextPath","pdfToPpmPath","validatePdfTools"]) assert.equal(source.includes(legacy),false);
});

test("requires configured Skill roots to match the validated private catalog",async()=>{
  const {selectPrivateSkillRoot}=await import("../src/main.mjs");
  const outer=await mkdtemp(join(tmpdir(),"llw-main-private-root-"));
  const skillRoot=join(outer,"skill");
  const otherRoot=join(outer,"other");
  try {
    await mkdir(skillRoot,{mode:0o700});
    await mkdir(otherRoot,{mode:0o700});
    const catalog={skills:[{name:"synthetic",root:await realpath(skillRoot)}]};
    assert.equal(await selectPrivateSkillRoot(catalog,"synthetic",skillRoot),await realpath(skillRoot));
    await assert.rejects(
      ()=>selectPrivateSkillRoot(catalog,"synthetic",otherRoot),
      {message:"private_skill_manifest_invalid"}
    );
    await assert.rejects(
      ()=>selectPrivateSkillRoot(catalog,"missing"),
      {message:"private_skill_manifest_invalid"}
    );
  } finally { await rm(outer,{recursive:true,force:true}); }
});

test("keeps every WeChat read and network call at zero when the switch is false",async () => {
  const {startChatEntries}=await import("../src/main.mjs");
  const calls={feishu:0,state:0,keychain:0,fetch:0,media:0};
  const lark={done:new Promise(()=>{}),stop:async()=>{}};
  const result=await startChatEntries({
    wechatEnabled:false,
    startFeishu:async()=>{calls.feishu++;return lark;},
    startWechat:async()=>{
      calls.state++;calls.keychain++;calls.fetch++;calls.media++;
      throw new Error("must_not_start");
    },
    feishuOptions:{},
    wechatOptions:{},
    onWechatLog:()=>{}
  });
  assert.equal(result.larkListener,lark);
  assert.equal(result.wechatListener,null);
  assert.deepEqual(calls,{feishu:1,state:0,keychain:0,fetch:0,media:0});
});

test("starts Feishu first and contains WeChat initialization or listener failure",async () => {
  const {startChatEntries}=await import("../src/main.mjs");
  for (const mode of ["start","done"]) {
    const order=[],handled=[],logs=[];
    let feishuOptions;
    const lark={done:new Promise(()=>{}),stop:async()=>{}};
    const result=await startChatEntries({
      wechatEnabled:true,
      startFeishu:async options=>{order.push("feishu");feishuOptions=options;return lark;},
      startWechat:async()=>{
        order.push("wechat");
        if (mode==="start") throw new Error("wechat secret");
        return {stop:()=>{},done:Promise.reject(new Error("listener secret"))};
      },
      feishuOptions:{onEvent:event=>handled.push(event)},
      wechatOptions:{},
      onWechatLog:code=>logs.push(code)
    });
    await feishuOptions.onEvent({message_id:`${mode}-m1`});
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(order,["feishu","wechat"]);
    assert.deepEqual(handled,[{message_id:`${mode}-m1`}]);
    assert.equal(result.larkListener,lark);
    assert.deepEqual(logs,[mode==="start"?"wechat_start_failed":"wechat_listener_stopped"]);
  }
});
