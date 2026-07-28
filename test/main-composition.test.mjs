import test from "node:test";
import assert from "node:assert/strict";
import {mkdir,mkdtemp,readFile,realpath,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

test("version 6 production entry does not statically load legacy routing layers",async()=>{
  const main=await readFile(
    fileURLToPath(new URL("../src/main.mjs",import.meta.url)),"utf8"
  );
  const legacy=await readFile(
    fileURLToPath(new URL("../src/legacy-main.mjs",import.meta.url)),"utf8"
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
    /if \(config\.version!==6\) \{\s*const \{runLegacyMain\}=await import\("\.\/legacy-main\.mjs"\)/
  );
  assert.match(legacy,/feishu-intent-router/);
  assert.match(legacy,/buildCapabilityRegistry/);
  assert.match(legacy,/createRouterTextTask/);
});

test("version 6 enters one personal-assistant composition before legacy routing",async()=>{
  const source=await readFile(
    fileURLToPath(new URL("../src/main.mjs",import.meta.url)),"utf8"
  );
  assert.match(
    source,
    /if \(config\.version!==6\) \{[\s\S]*?runLegacyMain\(configFile\);[\s\S]*?return;[\s\S]*?\}\s*await runPersonalAssistantMain\(config\);/
  );
  for (const expected of [
    "PersonalAssistantClient","createAssistantSourcePreparer",
    "PersonalAssistantCoordinator","PersonalAssistantDispatcher",
    "invokePersonalAssistantCodex","invokePersonalAssistantDeepSeek",
    "PersonalRulesStore"
  ]) assert.equal(source.includes(expected),true);
  assert.match(
    source,
    /config\.personalAssistant\.personalRulesFile\s*\?\s*await PersonalRulesStore\.open/
  );
  assert.match(source,/personalRulesStore,\s*\n\s*selectModel:/);
  for (const expected of [
    "const prepareTurnSources=createAssistantSourcePreparer({",
    "maxSourcesPerTurn:config.personalAssistant.maxSourcesPerTurn",
    "maxTurnSourceBytes:config.personalAssistant.maxTurnSourceBytes",
    "const feishuDocumentExporter=createFeishuDocumentExporter({",
    "exportFeishuDocument:feishuDocumentExporter.exportSnapshot",
    "workspaceDir",
    "sourceBurstQuietMs:config.personalAssistant.sourceBurstQuietMs",
    "sourceBurstMaxMs:config.personalAssistant.sourceBurstMaxMs",
    "sourceBurstAttachmentQuietMs:config.personalAssistant.sourceBurstMaxMs"
  ]) assert.equal(source.includes(expected),true);
  const v6Start=source.indexOf("async function runPersonalAssistantMain");
  const v6=source.slice(
    v6Start,source.indexOf("\nexport async function startChatEntries",v6Start)
  );
  assert.equal(v6.includes("prepareKnowledgeOfficeFile"),false);
  assert.equal(v6.includes("createSourceEvidence"),false);
  assert.equal(v6.includes("knowledge_source_incomplete"),false);
  assert.equal(v6.includes("workspaceRoot:config.vaultRoot"),false);
  const {V6_PRIVATE_SKILL_ALLOWLIST}=await import("../src/main.mjs");
  assert.deepEqual(V6_PRIVATE_SKILL_ALLOWLIST,[{
    name:"llw-personal-assistant",
    capability:"personal-assistant",
    versions:["4.0.1"],
    semanticTasks:["personal-assistant.turn"],
    modelSupport:["codex","deepseek"],
    enabled:true
  }]);
});

test("production model selection executes the real V6 wiring",async()=>{
  const {createPersonalAssistantModelSelector}=await import("../src/main.mjs");
  let reads=0;
  const selectModel=createPersonalAssistantModelSelector({
    modelMode:{async read(){reads+=1;return "codex";}},
    deepseekEnabled:true
  });
  assert.equal(await selectModel(),"codex");
  assert.equal(reads,1);
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

test("legacy rollback module retains its routing contracts without entering the V6 composition",async () => {
  const source=await readFile(fileURLToPath(new URL("../src/legacy-main.mjs",import.meta.url)),"utf8");
  assert.match(source,/import \{loadPrivateSkillManifest\} from "\.\/core\/private-skill-manifest\.mjs"/);
  assert.match(source,/import \{loadRoutingContract\} from "\.\/core\/routing-contract\.mjs"/);
  assert.match(source,/import \{validateIntentRouterSkill\} from "\.\/core\/intent-router-client\.mjs"/);
  assert.match(source,/createAssistantWorkTask/);
  assert.match(source,/import \{createPreparedVisualRunner\} from "\.\/core\/prepared-visual\.mjs"/);
  assert.match(source,/import \{parseInvoiceResource\} from "\.\/capabilities\/invoice\/resource-marker\.mjs"/);
  assert.match(source,/import \{ModelMode\} from "\.\/core\/model-mode\.mjs"/);
  assert.match(source,/deepseekModel:config\.deepseekModel/);
  assert.match(source,/deepseekKeychainService:config\.deepseekKeychainService/);
  assert.match(source,/deepseekKeychainAccount:config\.deepseekKeychainAccount/);
  assert.match(source,/deepseekEnabled:config\.deepseekEnabled/);
  for (const name of [
    "feishu-intent-router","feishu-daily-work","filing-invoices",
    "llw-knowledge-ingest","llw-assistant-work"
  ]) assert.match(source,new RegExp(name));
  assert.match(source,/name:"feishu-intent-router",capability:"router",versions:\["1\.2\.0"\]/);
  assert.match(source,/name:"llw-knowledge-ingest",capability:"knowledge-ingest",versions:\["1\.3\.0"\][\s\S]*?enabled:true/);
  assert.match(source,/name:"llw-assistant-work",capability:"assistant-work",versions:\["1\.1\.0"\][\s\S]*?enabled:true/);
  assert.ok(source.indexOf("await loadPrivateSkillManifest")<source.indexOf("StateStore.open"));
  const legacyRouterValidation=source.indexOf(
    "await validateIntentRouterSkill(routerSkillRoot)"
  );
  assert.ok(
    legacyRouterValidation<
      source.indexOf("StateStore.open",legacyRouterValidation)
  );
  assert.match(source,/loadRoutingContract\(dailySkillRoot,"daily-work"\)/);
  assert.match(source,/loadRoutingContract\(invoiceSkillRoot,"invoice"\)/);
  assert.equal(source.includes('join(config.vaultRoot,".agents","skills","feishu-intent-router")'),false);
  assert.match(source,/createDailyWorkInterpretTask\(\{[\s\S]*?skillRoot:dailySkillRoot/);
  assert.match(source,/createInvoiceVisualTask\(\{[\s\S]*?skillRoot:invoiceSkillRoot/);
  assert.match(source,/knowledgeIngest:knowledgeCapability/);
  assert.match(source,/assistantWork:assistantCapability/);
  assert.match(source,/taskSessionManager/);
  assert.match(source,/const routerText=createRouterTextTask\(\{/);
  assert.match(source,/const routerVisual=createRouterVisualTask\(\{/);
  assert.match(source,/const dailyWorkInterpret=createDailyWorkInterpretTask\(\{/);
  assert.match(source,/const invoiceVisual=createInvoiceVisualTask\(\{/);
  assert.match(source,/decide:dailyWorkInterpret/);
  assert.match(source,/decide:invoiceVisual/);
  assert.match(source,/const withPreparedVisual=createPreparedVisualRunner\(\{/);
  assert.match(source,/preparePdf\n\}\)/);
  assert.match(source,/const intentRouter=\{decide:routerText,decideVisual:routerVisual\}/);
});

test("allows assistant work statically but requires the protected configuration gate",async()=>{
  const source=await readFile(fileURLToPath(new URL("../src/legacy-main.mjs",import.meta.url)),"utf8");
  for (const expected of [
    "createAssistantWorkCapability","createAssistantWorkTask","TaskSessionManager",
    "TaskWorkspace","searchKnowledge","loadKnowledgeSources"
  ]) assert.equal(source.includes(expected),true);
  assert.match(source,/const assistantEnabled=assistantCandidateEnabled\(\{/);
  assert.match(source,/allowlistEnabled:assistantPolicy\.enabled/);
  assert.match(source,/configurationEnabled:assistantConfig\?\.enabled/);
  assert.match(source,/"assistant-work":assistantEnabled/);
  const {
    PRIVATE_SKILL_ALLOWLIST,assistantCandidateEnabled
  }=await import("../src/legacy-main.mjs");
  const policy=PRIVATE_SKILL_ALLOWLIST.find(item=>item.name==="llw-assistant-work");
  assert.equal(policy.enabled,true);
  assert.equal(assistantCandidateEnabled({
    allowlistEnabled:policy.enabled,configurationEnabled:false
  }),false);
  assert.equal(assistantCandidateEnabled({
    allowlistEnabled:true,configurationEnabled:false
  }),false);
  assert.equal(assistantCandidateEnabled({
    allowlistEnabled:false,configurationEnabled:true
  }),false);
  assert.equal(assistantCandidateEnabled({
    allowlistEnabled:true,configurationEnabled:true
  }),true);
});

test("allows knowledge ingest statically but requires the protected configuration gate",async()=>{
  const source=await readFile(fileURLToPath(new URL("../src/legacy-main.mjs",import.meta.url)),"utf8");
  for (const expected of [
    'createKnowledgeIngestCapability',
    'createKnowledgeIngestTask',
    'createKnowledgeLibraryCatalog',
    'prepareKnowledgeText',
    'prepareKnowledgeFile',
    'KnowledgeWriter',
    'prepareKnowledgeOfficeFile',
    'createFeishuDocumentExporter'
  ]) assert.equal(source.includes(expected),true);
  assert.match(source,/const knowledgeEnabled=knowledgeCandidateEnabled\(\{/);
  assert.match(source,/allowlistEnabled:knowledgePolicy\.enabled/);
  assert.match(source,/configurationEnabled:knowledgeConfig\?\.enabled/);
  assert.match(source,/if \(knowledgeEnabled\) \{/);
  assert.match(source,/knowledgeIngest:knowledgeCapability/);
  assert.match(source,/"knowledge-ingest":knowledgeEnabled/);
  assert.match(source,/allowedFileExtensions:\["txt","md","docx","pptx","xlsx"\]/);
  assert.match(source,/documentExporter:feishuDocumentExporter\.exportSnapshot/);
  assert.match(source,/onFailureStage:\(\{code,stderrBytes,retryCount\}\)=>/);
  assert.match(source,/safeLog\(\{stage:"analyze",code,stderrBytes,retryCount\}\)/);
  assert.equal(source.includes("console.log(knowledge"),false);
  const {
    PRIVATE_SKILL_ALLOWLIST,knowledgeCandidateEnabled
  }=await import("../src/legacy-main.mjs");
  const policy=PRIVATE_SKILL_ALLOWLIST.find(item=>item.name==="llw-knowledge-ingest");
  assert.equal(policy.enabled,true);
  assert.equal(knowledgeCandidateEnabled({
    allowlistEnabled:policy.enabled,configurationEnabled:false
  }),false);
  assert.equal(knowledgeCandidateEnabled({
    allowlistEnabled:true,configurationEnabled:false
  }),false);
  assert.equal(knowledgeCandidateEnabled({
    allowlistEnabled:false,configurationEnabled:true
  }),false);
  assert.equal(knowledgeCandidateEnabled({
    allowlistEnabled:true,configurationEnabled:true
  }),true);
});

test("requires configured legacy Skill roots to match the validated private catalog",async()=>{
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
