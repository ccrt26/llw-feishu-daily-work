import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state-store.mjs";

async function fresh() {
  const dir = await mkdtemp(join(tmpdir(), "llw-state-"));
  return {dir, file: join(dir, "state.json")};
}

function conversation() {
  return {
    id: "c1",
    status: "open",
    turns: [
      {role: "user", text: "我补充一下……", createTime: 1784445972514},
      {role: "assistant", text: "补充哪一场会议？"}
    ],
    candidateIds: ["90f29b02eb9ec9bb"],
    model:"codex"
  };
}

const taskSessionPolicy=[{capability:"assistant-work",models:["codex"]}];

function taskSession(overrides={}) {
  return {
    version:1,
    session_id:"123e4567-e89b-42d3-a456-426614174000",
    capability:"assistant-work",
    status:"open",
    model:"codex",
    grounding_mode:"hybrid",
    goal:"整理项目验收说明",
    task_summary:"",
    confirmed_requirements:["保留来源"],
    rejected_directions:[],
    source_paths:["projects/acceptance.md"],
    current_draft_version:0,
    recent_turns:[{role:"user",text:"先整理一个提纲"}],
    started_at:"2026-07-26T05:00:00.000Z",
    updated_at:"2026-07-26T05:00:00.000Z",
    ...overrides
  };
}

test("persists one shared Task Session in state version 4 and restores it after restart",async()=>{
  const {file}=await fresh();
  const store=await StateStore.open(file,{taskSessionPolicy});
  assert.deepEqual(store.getCapabilityState("task-session"),{session:null});
  await store.saveTaskSession(taskSession(),{
    verifiedSourcePaths:["projects/acceptance.md"]
  });
  const reopened=await StateStore.open(file,{taskSessionPolicy});
  assert.equal(reopened.version(),4);
  assert.deepEqual(reopened.getTaskSession(),taskSession());
  assert.deepEqual(
    reopened.getCapabilityState("task-session"),
    {session:taskSession()}
  );
  const persisted=JSON.parse(await readFile(file,"utf8"));
  assert.equal(persisted.version,4);
  assert.deepEqual(Object.keys(persisted.capabilityState["task-session"]),["session"]);
  assert.equal((await stat(file)).mode&0o777,0o600);
});

test("persists one bounded personal-assistant conversation per entry",async()=>{
  const {file}=await fresh();
  const store=await StateStore.open(file);
  const conversation={
    waitingType:"waiting_file",
    question:"请发送要保存的文件。",
    instructionText:"把我接下来发的文件保存到日常生活",
    preparedTool:"save_knowledge",
    confirmed:{libraryKey:"personal-knowledge"},
    turns:[],
    model:"codex",
    startedAt:"2026-07-28T00:00:00.000Z",
    updatedAt:"2026-07-28T00:00:00.000Z"
  };
  await store.setPersonalAssistantConversation("wechat",conversation);
  assert.equal(
    (await store.getPersonalAssistantConversation(
      "feishu","2026-07-28T01:00:00.000Z"
    )),
    null
  );
  assert.deepEqual(
    await store.getPersonalAssistantConversation(
      "wechat","2026-07-28T01:00:00.000Z"
    ),
    conversation
  );
  const reopened=await StateStore.open(file);
  assert.deepEqual(
    await reopened.getPersonalAssistantConversation(
      "wechat","2026-07-28T02:00:00.000Z"
    ),
    conversation
  );
  assert.equal(JSON.stringify(
    reopened.getCapabilityState("personal-assistant")
  ).includes("/Users/"),false);
  await reopened.clearPersonalAssistantConversation("wechat");
  assert.equal(
    await reopened.getPersonalAssistantConversation(
      "wechat","2026-07-28T02:00:00.000Z"
    ),
    null
  );
});

test("migrates a live V4.0.1 waiting conversation into one channel Task Session",async()=>{
  const {file}=await fresh();
  const legacy={
    waitingType:"waiting_answer",
    question:"你希望重点整理哪些内容？",
    instructionText:"整理这次讨论，并突出后续行动。",
    preparedTool:null,
    confirmed:{},
    turns:[
      {role:"user",text:"整理这次讨论，并突出后续行动。"},
      {role:"assistant",text:"你希望重点整理哪些内容？"}
    ],
    model:"codex",
    startedAt:"2026-07-29T03:00:00.000Z",
    updatedAt:"2026-07-29T04:00:00.000Z"
  };
  await writeFile(file,JSON.stringify({
    version:4,
    capabilityState:{
      "daily-work":{conversation:null},
      invoice:{},
      router:{conversation:null},
      "task-session":{session:null},
      "personal-assistant":{
        conversations:{feishu:null,wechat:legacy}
      }
    },
    outcomes:{}
  }));

  const store=await StateStore.open(file,{
    migratePersonalAssistantConversations:true
  });
  const slot=store.getCapabilityState("personal-assistant");
  assert.equal(slot.conversations.wechat,null);
  assert.equal(slot.sessions.feishu,null);
  assert.match(slot.sessions.wechat.taskId,/^[A-Za-z0-9_-]{43}$/u);
  assert.deepEqual(slot.sessions.wechat,{
    version:1,
    taskId:slot.sessions.wechat.taskId,
    source:"wechat",
    status:"active",
    revision:1,
    resolvedRevision:1,
    model:"codex",
    goal:"整理这次讨论，并突出后续行动。",
    workingSummary:"",
    confirmedRequirements:[],
    rejectedDirections:[],
    recentTurns:legacy.turns,
    sourceIds:[],
    pendingInputs:[],
    waiting:{
      type:"waiting_answer",
      question:"你希望重点整理哪些内容？",
      preparedTool:null,
      confirmed:{}
    },
    writerCheckpoint:null,
    startedAt:"2026-07-29T03:00:00.000Z",
    updatedAt:"2026-07-29T04:00:00.000Z",
    expiresAt:"2026-07-30T04:00:00.000Z"
  });
  assert.deepEqual(
    JSON.parse(await readFile(file,"utf8"))
      .capabilityState["personal-assistant"],
    slot
  );
});

test("persists only an opaque prepared source id in a WeChat conversation",async()=>{
  const {file}=await fresh();
  const store=await StateStore.open(file);
  const preparedSourceSetId="C".repeat(43);
  const conversation={
    waitingType:"waiting_answer",
    question:"要重点总结哪一部分？",
    instructionText:"总结这个视频",
    preparedTool:null,confirmed:{},turns:[],model:"codex",
    preparedSourceSetId,
    startedAt:"2026-07-29T00:00:00.000Z",
    updatedAt:"2026-07-29T00:00:00.000Z"
  };
  await store.setPersonalAssistantConversation("wechat",conversation);
  const reopened=await StateStore.open(file);
  assert.deepEqual(
    await reopened.getPersonalAssistantConversation(
      "wechat","2026-07-29T01:00:00.000Z"
    ),
    conversation
  );
  const persisted=await readFile(file,"utf8");
  assert.equal(persisted.includes(preparedSourceSetId),true);
  assert.equal(persisted.includes("/private/"),false);
  assert.equal(
    await reopened.getPersonalAssistantConversation(
      "feishu","2026-07-29T01:00:00.000Z"
    ),
    null
  );
});

test("fails closed instead of guessing how to migrate a retained legacy source",async()=>{
  const {file}=await fresh();
  const preparedSourceSetId="C".repeat(43);
  await writeFile(file,JSON.stringify({
    version:4,
    capabilityState:{
      "daily-work":{conversation:null},
      invoice:{},
      router:{conversation:null},
      "task-session":{session:null},
      "personal-assistant":{
        conversations:{
          feishu:null,
          wechat:{
            waitingType:"waiting_answer",
            question:"要重点总结哪一部分？",
            instructionText:"总结这个视频",
            preparedTool:null,
            confirmed:{},
            turns:[],
            model:"codex",
            preparedSourceSetId,
            startedAt:"2026-07-29T00:00:00.000Z",
            updatedAt:"2026-07-29T00:00:00.000Z"
          }
        }
      }
    },
    outcomes:{}
  }));
  const before=await readFile(file);
  await assert.rejects(
    StateStore.open(file,{
      migratePersonalAssistantConversations:true
    }),
    /legacy_personal_assistant_source_migration_required/
  );
  assert.deepEqual(await readFile(file),before);
});

test("updates only the same open Task Session without identity, model, time or draft rollback",async()=>{
  const {file}=await fresh();
  const store=await StateStore.open(file,{taskSessionPolicy});
  await store.saveTaskSession(taskSession(),{
    verifiedSourcePaths:["projects/acceptance.md"]
  });
  const before=await readFile(file);
  const invalidUpdates=[
    taskSession({session_id:"223e4567-e89b-42d3-a456-426614174000"}),
    taskSession({capability:"other-work"}),
    taskSession({model:"deepseek"}),
    taskSession({started_at:"2026-07-26T05:00:01.000Z"}),
    taskSession({current_draft_version:-1}),
    taskSession({updated_at:"2026-07-26T04:59:59.999Z"}),
    taskSession({status:"completed"})
  ];
  for (const value of invalidUpdates) {
    await assert.rejects(
      ()=>store.saveTaskSession(value,{
        verifiedSourcePaths:["projects/acceptance.md"]
      }),
      /invalid_task_session|invalid_task_session_transition/
    );
    assert.deepEqual(await readFile(file),before);
  }
  await assert.rejects(
    ()=>store.saveTaskSession(taskSession(),{verifiedSourcePaths:[]}),
    /invalid_task_session/
  );
  assert.deepEqual(await readFile(file),before);

  const updated=taskSession({
    task_summary:"已确定提纲结构",
    current_draft_version:1,
    recent_turns:[
      {role:"user",text:"先整理一个提纲"},
      {role:"assistant",text:"已形成三段提纲"}
    ],
    updated_at:"2026-07-26T05:10:00.000Z"
  });
  await store.saveTaskSession(updated,{
    verifiedSourcePaths:["projects/acceptance.md"]
  });
  assert.deepEqual(store.getTaskSession(),updated);
  const afterUpdate=await readFile(file);
  await assert.rejects(
    ()=>store.saveTaskSession(taskSession({
      current_draft_version:0,
      updated_at:"2026-07-26T05:11:00.000Z"
    }),{verifiedSourcePaths:["projects/acceptance.md"]}),
    /invalid_task_session_transition/
  );
  assert.deepEqual(await readFile(file),afterUpdate);
});

test("fixes model and capability even when a later policy would allow both values",async()=>{
  const {file}=await fresh();
  const broadPolicy=[
    {capability:"assistant-work",models:["codex","deepseek"]},
    {capability:"other-work",models:["codex"]}
  ];
  const store=await StateStore.open(file,{taskSessionPolicy:broadPolicy});
  await store.saveTaskSession(taskSession(),{
    verifiedSourcePaths:["projects/acceptance.md"]
  });
  const before=await readFile(file);
  for (const value of [
    taskSession({model:"deepseek"}),
    taskSession({capability:"other-work"})
  ]) {
    await assert.rejects(
      ()=>store.saveTaskSession(value,{
        verifiedSourcePaths:["projects/acceptance.md"]
      }),
      /invalid_task_session_transition/
    );
    assert.deepEqual(await readFile(file),before);
  }
});

test("restores and explicitly changes grounding mode while keeping the model fixed",async()=>{
  const {file}=await fresh();
  const store=await StateStore.open(file,{taskSessionPolicy});
  await store.saveTaskSession(taskSession(),{
    verifiedSourcePaths:["projects/acceptance.md"]
  });
  const changed=taskSession({
    grounding_mode:"source_strict",
    updated_at:"2026-07-26T05:10:00.000Z"
  });
  await store.saveTaskSession(changed,{
    verifiedSourcePaths:["projects/acceptance.md"]
  });
  assert.equal(store.getTaskSession().grounding_mode,"source_strict");
  const reopened=await StateStore.open(file,{taskSessionPolicy});
  assert.equal(reopened.getTaskSession().grounding_mode,"source_strict");
  assert.equal(reopened.getTaskSession().model,"codex");
  await assert.rejects(
    ()=>reopened.saveTaskSession({
      ...changed,
      grounding_mode:"automatic",
      updated_at:"2026-07-26T05:11:00.000Z"
    },{verifiedSourcePaths:["projects/acceptance.md"]}),
    /invalid_task_session/
  );
});

test("closes an open Task Session once and permits only a new ID afterwards",async()=>{
  for (const status of ["completed","cancelled","expired"]) {
    const {file}=await fresh();
    const store=await StateStore.open(file,{taskSessionPolicy});
    await store.saveTaskSession(taskSession(),{
      verifiedSourcePaths:["projects/acceptance.md"]
    });
    const closed=await store.closeTaskSession(status,"2026-07-26T06:00:00.000Z");
    assert.equal(closed.status,status);
    assert.equal(closed.updated_at,"2026-07-26T06:00:00.000Z");
    assert.equal(store.getTaskSession(),null);
    assert.equal(
      (await StateStore.open(file,{taskSessionPolicy}))
        .getCapabilityState("task-session").session.status,
      status
    );
    const before=await readFile(file);
    await assert.rejects(
      ()=>store.closeTaskSession(status,"2026-07-26T06:01:00.000Z"),
      /invalid_task_session_transition/
    );
    await assert.rejects(
      ()=>store.saveTaskSession(taskSession(),{
        verifiedSourcePaths:["projects/acceptance.md"]
      }),
      /invalid_task_session_transition/
    );
    assert.deepEqual(await readFile(file),before);

    const replacement=taskSession({
      session_id:"223e4567-e89b-42d3-a456-426614174000",
      goal:"整理另一份项目材料",
      source_paths:[],
      confirmed_requirements:[],
      recent_turns:[{role:"user",text:"开始另一项整理任务"}],
      started_at:"2026-07-26T07:00:00.000Z",
      updated_at:"2026-07-26T07:00:00.000Z"
    });
    await store.saveTaskSession(replacement,{verifiedSourcePaths:[]});
    assert.deepEqual(store.getTaskSession(),replacement);
  }
});

test("fails closed when restored Task Session policy does not match",async()=>{
  const {file}=await fresh();
  const store=await StateStore.open(file,{taskSessionPolicy});
  await store.saveTaskSession(taskSession(),{
    verifiedSourcePaths:["projects/acceptance.md"]
  });
  const before=await readFile(file);
  await assert.rejects(
    ()=>StateStore.open(file,{
      taskSessionPolicy:[{capability:"other-work",models:["codex"]}]
    }),
    /invalid_task_session/
  );
  assert.deepEqual(await readFile(file),before);
});

test("persists a version-4 activity conversation with mode 0600", async () => {
  const {file} = await fresh();
  const store = await StateStore.open(file);
  await store.setConversation(conversation());
  const reopened = await StateStore.open(file);
  assert.equal(reopened.version(), 4);
  assert.deepEqual(reopened.getConversation(), conversation());
  assert.deepEqual(reopened.getCapabilityState("daily-work"), {conversation: conversation()});
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(file, "utf8")).version, 4);
});

test("migrates version-1 pending data without preserving forceDaily semantics", async () => {
  const {file} = await fresh();
  await writeFile(file, JSON.stringify({
    version: 1,
    pending: {messageId: "m1", text: "这个后面再说", createTime: 1784426400000, question: "要记录什么事项？", forceDaily: true},
    outcomes: {old: {status: "ignored", reply: "未入库", recordIds: [], replied: true}}
  }));
  const store = await StateStore.open(file);
  assert.deepEqual(store.getConversation(), {
    id: "legacy-m1",
    status: "open",
    turns: [
      {role: "user", text: "这个后面再说", createTime: 1784426400000},
      {role: "assistant", text: "要记录什么事项？"}
    ],
    candidateIds: [],
    model:"codex"
  });
  const persisted = JSON.parse(await readFile(file, "utf8"));
  assert.equal(persisted.version, 4);
  assert.equal(JSON.stringify(persisted).includes("forceDaily"), false);
  assert.equal(store.hasOutcome("old"), true);
});

test("migrates version-2 conversation and outcomes without loss", async () => {
  const {file} = await fresh();
  await writeFile(file, JSON.stringify({
    version: 2,
    conversation: conversation(),
    outcomes: {m1: {status: "committed", reply: "已入库", recordIds: ["r1"], replied: true}}
  }));
  const store = await StateStore.open(file);
  assert.equal(store.version(), 4);
  assert.deepEqual(store.getConversation(), conversation());
  assert.equal(store.hasOutcome("m1"), true);
  const persisted = JSON.parse(await readFile(file, "utf8"));
  assert.equal(persisted.version, 4);
  assert.deepEqual(persisted.capabilityState["daily-work"], {conversation: conversation()});
});

test("clears conversation and retains bounded outcomes", async () => {
  const {file} = await fresh();
  const store = await StateStore.open(file, {maxOutcomes: 3});
  await store.setConversation(conversation());
  await store.clearConversation();
  await store.saveOutcome("m1", {status: "ignored", reply: "未入库", recordIds: []});
  await store.markReplied("m1");
  await store.saveOutcome("m2", {status: "ignored", reply: "未入库", recordIds: []});
  await store.saveOutcome("m3", {status: "ignored", reply: "未入库", recordIds: []});
  await store.saveOutcome("m4", {status: "ignored", reply: "未入库", recordIds: []});
  assert.equal(store.getConversation(), null);
  assert.equal(store.hasOutcome("m1"), false);
  assert.equal(store.hasOutcome("m2"), true);
  assert.equal(store.hasOutcome("m4"), true);
});

test("never evicts unreplied outcomes when the bound is exceeded", async () => {
  const {file} = await fresh();
  const store = await StateStore.open(file, {maxOutcomes: 2});
  await store.saveOutcome("m1", {status: "failed", reply: "失败1", recordIds: []});
  await store.saveOutcome("m2", {status: "failed", reply: "失败2", recordIds: []});
  await store.saveOutcome("m3", {status: "failed", reply: "失败3", recordIds: []});
  assert.equal(store.hasOutcome("m1"), true);
  assert.equal(store.hasOutcome("m2"), true);
  assert.equal(store.hasOutcome("m3"), true);
});

test("persists outcome before reply and exposes unreplied work", async () => {
  const {file} = await fresh();
  const store = await StateStore.open(file);
  await store.saveOutcome("m1", {status: "committed", reply: "已入库", recordIds: ["r1"]});
  assert.deepEqual(store.unreplied(), [{messageId: "m1", status: "committed", reply: "已入库", recordIds: ["r1"], replied: false}]);
  await store.markReplied("m1");
  assert.deepEqual((await StateStore.open(file)).unreplied(), []);
});

test("persists an optional minimal reply target without changing version 4",async () => {
  const {file}=await fresh();
  const store=await StateStore.open(file);
  const replyTarget={
    source:"wechat",sourceMessageId:"1001",conversationId:"wx-owner",contextToken:"test-context"
  };
  await store.saveOutcome("wechat:1001",{
    capability:"daily-work",status:"committed",reply:"已入库",artifacts:["p"],replyTarget
  });
  assert.deepEqual((await StateStore.open(file)).unreplied(),[{
    messageId:"wechat:1001",capability:"daily-work",status:"committed",reply:"已入库",
    artifacts:["p"],replyTarget,replied:false
  }]);
  assert.equal(JSON.parse(await readFile(file,"utf8")).version,4);
});

test("persists one minimal verified reply file without document contents",async()=>{
  const {file}=await fresh();
  const store=await StateStore.open(file);
  const replyFiles=[{
    kind:"docx",path:"/private/output/session/output.docx",
    displayName:"工作稿.docx",
    mime:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    sha256:"a".repeat(64),size:2048,
    idempotencyKey:"assistant-file:feishu:m1:aaaaaaaaaaaaaaaa"
  }];
  await store.saveOutcome("m1",{
    capability:"assistant-work",status:"committed",reply:"已生成",
    artifacts:["task-session/s/draft-v1/output.docx"],replyFiles
  });
  assert.deepEqual(store.unreplied()[0].replyFiles,replyFiles);
  assert.doesNotMatch(await readFile(file,"utf8"),/正文内容/u);
  await assert.rejects(()=>store.saveOutcome("m2",{
    capability:"assistant-work",status:"committed",reply:"已生成",
    artifacts:["p"],replyFiles:[...replyFiles,replyFiles[0]]
  }),/invalid_reply_files/);
});

test("retains unreplied files indefinitely and replied files for seven days",async()=>{
  const {file}=await fresh();
  const store=await StateStore.open(file);
  const replyFile={
    kind:"docx",path:"/private/output/session/output.docx",
    displayName:"工作稿.docx",
    mime:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    sha256:"a".repeat(64),size:2048,
    idempotencyKey:"assistant-file:feishu:m1:aaaaaaaaaaaaaaaa"
  };
  const sentAt="2026-07-10T00:00:00.000Z";
  await store.saveOutcome("m1",{
    capability:"assistant-work",status:"committed",reply:"已生成",
    artifacts:["p"],replyFiles:[replyFile]
  });
  assert.deepEqual(store.retainedReplyFilePaths({
    nowMs:Date.parse("2026-08-01T00:00:00.000Z"),retentionDays:7
  }),[replyFile.path]);
  await store.markReplied("m1",sentAt);
  assert.deepEqual(store.retainedReplyFilePaths({
    nowMs:Date.parse("2026-07-16T23:59:59.999Z"),retentionDays:7
  }),[replyFile.path]);
  assert.deepEqual(store.retainedReplyFilePaths({
    nowMs:Date.parse("2026-07-17T00:00:00.000Z"),retentionDays:7
  }),[]);
  const persisted=JSON.parse(await readFile(file,"utf8"));
  assert.equal(persisted.outcomes.m1.replyFilesSentAt,sentAt);
});

test("rejects non-minimal outcome reply targets before persistence",async () => {
  const {file}=await fresh();
  const store=await StateStore.open(file);
  await assert.rejects(()=>store.saveOutcome("wechat:1001",{
    status:"committed",reply:"已入库",artifacts:["p"],
    replyTarget:{
      source:"wechat",sourceMessageId:"1001",conversationId:"wx-owner",
      contextToken:"test-context",encrypt_query_param:"raw-cdn"
    }
  }),/invalid_reply_target/);
  assert.equal(store.hasOutcome("wechat:1001"),false);
});

test("migrates exact version 3 without losing daily-work, invoice or outcomes",async () => {
  const {file}=await fresh();
  const invoice={transactions:{tx:{transactionId:"tx",status:"published"}}};
  await writeFile(file,JSON.stringify({version:3,capabilityState:{"daily-work":{conversation:conversation()},invoice},outcomes:{m1:{status:"committed",reply:"已入库",artifacts:["p"],replied:true}}}));
  const store=await StateStore.open(file);
  assert.equal(store.version(),4);
  assert.deepEqual(store.getConversation(),conversation());
  assert.deepEqual(store.getCapabilityState("invoice"),invoice);
  assert.equal(store.hasOutcome("m1"),true);
  assert.deepEqual(store.getCapabilityState("router"),{conversation:null});
});

test("expires router conversations after 24 hours and preserves one attempt",async () => {
  const {file}=await fresh(); const store=await StateStore.open(file);
  const started="2026-07-18T12:00:00.000Z";
  await store.setRouterConversation({capability:"daily-work",question:"这是补充哪一场？",startedAt:started,attempts:1,status:"open"});
  assert.equal((await store.getRouterConversation(Date.parse(started)+23*60*60*1000)).capability,"daily-work");
  assert.equal(await store.getRouterConversation(Date.parse(started)+24*60*60*1000),null);
  assert.deepEqual((await StateStore.open(file)).getCapabilityState("router"),{conversation:null});
  await assert.rejects(()=>store.setRouterConversation({capability:null,question:"x",startedAt:started,attempts:2,status:"open"}),/invalid_router_conversation/);
});

test("persists task model snapshots while legacy version-4 conversations default to Codex",async () => {
  const {file}=await fresh(); const store=await StateStore.open(file);
  const started="2026-07-18T12:00:00.000Z";
  await store.setRouterConversation({capability:"daily-work",question:"这是补充哪一场？",startedAt:started,attempts:1,status:"open",model:"deepseek"});
  await store.setConversation({...conversation(),model:"deepseek"});
  const reopened=await StateStore.open(file);
  assert.equal((await reopened.getRouterConversation(Date.parse(started))).model,"deepseek");
  assert.equal(reopened.getConversation().model,"deepseek");
  const {model,...legacyConversation}=conversation();
  await writeFile(file,JSON.stringify({version:4,capabilityState:{"daily-work":{conversation:{...legacyConversation,model:"hybrid"}},invoice:{},router:{conversation:{capability:null,question:"要处理什么？",startedAt:started,attempts:1,status:"open",model:"hybrid"}}},outcomes:{}}));
  const legacy=await StateStore.open(file);
  assert.equal((await legacy.getRouterConversation(Date.parse(started))).model,"codex");
  assert.equal(legacy.getConversation().model,"codex");
});

test("silent outcomes are persisted but never resumed or sent",async () => {
  const {file}=await fresh(); const store=await StateStore.open(file);
  await store.saveOutcome("silent",{capability:"daily-work",status:"ignored",reply:null,artifacts:[],noReplyRequired:true});
  assert.deepEqual(store.unreplied(),[]);
  assert.equal(store.hasOutcome("silent"),true);
});

test("persists invoice archive transactions and terminal status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llw-state-"));
  const file = join(dir, "state.json");
  const store = await StateStore.open(file);
  await store.prepareInvoiceTransaction("tx-1", {targetRelativePath:"亚信工作/日常发票/餐饮发票/2026年07月/10.00.png",sourceHash:"a".repeat(64)});
  assert.equal(store.listInvoiceTransactions()[0].status,"prepared");
  await store.updateInvoiceTransaction("tx-1","published");
  const reopened = await StateStore.open(file);
  assert.deepEqual(reopened.listInvoiceTransactions(),[{transactionId:"tx-1",targetRelativePath:"亚信工作/日常发票/餐饮发票/2026年07月/10.00.png",sourceHash:"a".repeat(64),status:"published",createdAt:store.listInvoiceTransactions()[0].createdAt}]);
});

test("persists bounded knowledge targets separately for Feishu and WeChat",async()=>{
  const {file}=await fresh();
  const store=await StateStore.open(file);
  const pending={
    source:"feishu",
    startedAt:"2026-07-26T06:00:00.000Z",
    model:"codex",libraryKey:"work-knowledge",
    target:{scope:"library_root",segments:[],origin:"user_explicit"}
  };
  assert.deepEqual(store.getCapabilityState("knowledge-ingest"),{
    pendingBySource:{feishu:null,wechat:null}
  });
  await store.setKnowledgePending(pending);
  await store.setKnowledgePending({...pending,source:"wechat"});
  assert.deepEqual(
    await store.getKnowledgePending(
      "feishu",Date.parse("2026-07-27T05:59:59.999Z")
    ),
    pending
  );
  const persisted=JSON.parse(await readFile(file,"utf8"));
  assert.equal(persisted.version,4);
  assert.deepEqual(persisted.capabilityState["knowledge-ingest"],{
    pendingBySource:{feishu:pending,wechat:{...pending,source:"wechat"}}
  });
  assert.equal(JSON.stringify(persisted).includes("sourceAttachmentId"),false);
  assert.equal(JSON.stringify(persisted).includes("/private/tmp"),false);
  assert.equal(JSON.stringify(persisted).includes("把我接下来"),false);
});

test("expires, clears and never replaces one pending target per source",async()=>{
  const {file}=await fresh();
  const store=await StateStore.open(file);
  const pending={
    source:"feishu",
    startedAt:"2026-07-26T06:00:00.000Z",
    model:"codex",libraryKey:"work-knowledge",
    target:{scope:"library_root",segments:[],origin:"user_explicit"}
  };
  await store.setKnowledgePending(pending);
  await assert.rejects(
    store.setKnowledgePending({...pending,target:{
      scope:"new_folder",segments:["替换"],origin:"user_explicit"
    }}),
    /knowledge_pending_exists/
  );
  assert.equal(
    await store.getKnowledgePending(
      "feishu",Date.parse("2026-07-27T06:00:00.000Z")
    ),
    null
  );
  assert.deepEqual(store.getCapabilityState("knowledge-ingest"),{
    pendingBySource:{feishu:null,wechat:null}
  });
  await store.setKnowledgePending(pending);
  await store.clearKnowledgePending("feishu");
  await store.clearKnowledgePending("feishu");
  assert.equal(await store.getKnowledgePending("feishu"),null);
});

test("rejects knowledge pending fields, paths, identifiers, bytes and non-Codex models",async()=>{
  const {file}=await fresh();
  const store=await StateStore.open(file);
  const base={
    source:"feishu",
    startedAt:"2026-07-26T06:00:00.000Z",
    model:"codex",libraryKey:"work-knowledge",
    target:{scope:"library_root",segments:[],origin:"user_explicit"}
  };
  for (const value of [
    {...base,model:"deepseek"},
    {...base,source:"email"},
    {...base,sourceAttachmentId:"file_secret"},
    {...base,tempPath:"/private/tmp/job"},
    {...base,bytes:Buffer.from("secret").toString("base64")},
    {...base,libraryKey:"../../private"},
    {...base,target:{...base.target,segments:[".."]}},
    {...base,startedAt:"not-a-date"}
  ]) {
    await assert.rejects(
      store.setKnowledgePending(value),
      /invalid_knowledge_pending/
    );
  }
  assert.deepEqual(store.getCapabilityState("knowledge-ingest"),{
    pendingBySource:{feishu:null,wechat:null}
  });
});

test("adds the strict knowledge pending slot when loading an existing version-4 state",async()=>{
  const {file}=await fresh();
  await writeFile(file,JSON.stringify({
    version:4,
    capabilityState:{
      "daily-work":{conversation:null},invoice:{},router:{conversation:null},
      "task-session":{session:null}
    },
    outcomes:{}
  }));
  const store=await StateStore.open(file);
  assert.equal(store.version(),4);
  assert.deepEqual(store.getCapabilityState("knowledge-ingest"),{
    pendingBySource:{feishu:null,wechat:null}
  });
  assert.deepEqual(
    JSON.parse(await readFile(file,"utf8")).capabilityState["knowledge-ingest"],
    {pendingBySource:{feishu:null,wechat:null}}
  );
});

test("drops the old unbound knowledge request during safe state migration",async()=>{
  const {file}=await fresh();
  await writeFile(file,JSON.stringify({
    version:4,
    capabilityState:{
      "daily-work":{conversation:null},invoice:{},router:{conversation:null},
      "task-session":{session:null},
      "knowledge-ingest":{
        pending:{
          request:"旧的原始用户消息",startedAt:"2026-07-26T06:00:00.000Z",
          model:"codex"
        }
      }
    },
    outcomes:{}
  }));
  const store=await StateStore.open(file);
  assert.deepEqual(store.getCapabilityState("knowledge-ingest"),{
    pendingBySource:{feishu:null,wechat:null}
  });
  assert.equal((await readFile(file,"utf8")).includes("旧的原始用户消息"),false);
});
