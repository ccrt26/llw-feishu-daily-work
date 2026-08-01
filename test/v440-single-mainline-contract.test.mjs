import test from "node:test";
import assert from "node:assert/strict";
import {access,readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";

const sourceFile=relative=>fileURLToPath(
  new URL(`../src/${relative}`,import.meta.url)
);

test("production entry accepts only V7 and has no dynamic legacy fallback",async()=>{
  const main=await readFile(sourceFile("main.mjs"),"utf8");
  assert.doesNotMatch(main,/legacy-main/u);
  assert.doesNotMatch(main,/runLegacyMain/u);
  assert.match(
    main,
    /if \(config\.version!==7\) \{\s*throw new Error\("config_migration_required"\);\s*\}\s*await runPersonalAssistantMain\(config\);/u
  );
});

test("retired runtime entry modules are absent",async()=>{
  const retired=[
    "legacy-main.mjs",
    "service.mjs",
    "codex-client.mjs",
    "ai/ai-input-guard.mjs",
    "ai/deepseek-client.mjs",
    "core/dispatcher.mjs",
    "core/intent-router-client.mjs",
    "core/semantic-tasks.mjs",
    "personal-assistant/conversation.mjs",
    "personal-assistant/source-job-store.mjs",
    "personal-assistant/source-job-worker.mjs"
  ];
  for (const relative of retired) {
    await assert.rejects(
      access(sourceFile(relative)),
      error=>error?.code==="ENOENT",
      relative
    );
  }
});

test("Coordinator and Dispatcher expose only the Task Session loop",async()=>{
  const coordinator=await readFile(
    sourceFile("personal-assistant/coordinator.mjs"),"utf8"
  );
  const dispatcher=await readFile(
    sourceFile("personal-assistant/dispatcher.mjs"),"utf8"
  );
  assert.match(coordinator,/async handleTask\(snapshot\)/u);
  assert.doesNotMatch(coordinator,/async handle\(message\)/u);
  assert.doesNotMatch(coordinator,/conversationStore|prepareSource/u);
  assert.match(dispatcher,/async acceptIncomingMessage\(message\)/u);
  assert.doesNotMatch(
    dispatcher,
    /processIncomingMessage|scheduleAccepted|processRawEvent/u
  );
  assert.doesNotMatch(dispatcher,/this\.taskManager\s*\?/u);
  assert.match(
    dispatcher,
    /onReady:\(\{message\}\)=>this\.scheduleTask\(message\.source\)/u
  );
});

test("active shared helpers no longer depend on retired implementation modules",async()=>{
  const invoker=await readFile(
    sourceFile("personal-assistant/invoke-personal-assistant.mjs"),"utf8"
  );
  const state=await readFile(sourceFile("state-store.mjs"),"utf8");
  assert.match(
    invoker,
    /from "\.\.\/core\/keychain-password-reader\.mjs"/u
  );
  assert.doesNotMatch(invoker,/ai\/deepseek-client/u);
  assert.match(
    state,
    /from "\.\/personal-assistant\/legacy-conversation-state\.mjs"/u
  );
  assert.doesNotMatch(
    state,
    /getPersonalAssistantConversation|setPersonalAssistantConversation|clearPersonalAssistantConversation/u
  );
});

test("real SourceReader and task debounce remain first-class components",async()=>{
  const main=await readFile(sourceFile("main.mjs"),"utf8");
  const dispatcher=await readFile(
    sourceFile("personal-assistant/dispatcher.mjs"),"utf8"
  );
  await access(sourceFile("personal-assistant/source-reader.mjs"));
  await access(sourceFile("personal-assistant/source-burst-collector.mjs"));
  assert.match(main,/new SourceReader\(/u);
  assert.match(dispatcher,/new SourceBurstCollector\(/u);
});
