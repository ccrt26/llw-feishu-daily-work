import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {
  chmod,mkdir,mkdtemp,readFile,readdir,rm,writeFile
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {
  createFeishuIncomingMessage
} from "../src/core/incoming-message.mjs";
import {
  createFeishuDocumentExporter
} from "../src/capabilities/knowledge-ingest/feishu-document-exporter.mjs";
import {
  KnowledgeWriter
} from "../src/capabilities/knowledge-ingest/knowledge-writer.mjs";
import {
  PersonalAssistantClient
} from "../src/personal-assistant/client.mjs";
import {
  PersonalAssistantCoordinator
} from "../src/personal-assistant/coordinator.mjs";
import {
  PersonalAssistantDispatcher
} from "../src/personal-assistant/dispatcher.mjs";
import {
  createAssistantSourcePreparer
} from "../src/personal-assistant/source-preparer.mjs";
import {
  TaskDocxReader
} from "../src/personal-assistant/task-docx-reader.mjs";
import {
  PersonalAssistantTaskSessionManager
} from "../src/personal-assistant/task-session-manager.mjs";
import {
  TaskSourceWorkspace
} from "../src/personal-assistant/task-source-workspace.mjs";
import {StateStore} from "../src/state-store.mjs";
import {
  PNG_1X1,REL_BASE,buildDocxFixture,imageParagraph,paragraph,wordDocument
} from "./fixtures/docx-evidence-fixture.mjs";

const NOW="2026-08-02T02:00:00.000Z";
const TASK_ID="E".repeat(43);
const DOCUMENT_URL="https://example.feishu.cn/docx/v445_synthetic";
const HELPER=fileURLToPath(new URL(
  "../src/personal-assistant/docx-evidence-helper.mjs",import.meta.url
));
const BINDINGS={
  feishu:{userId:"owner",conversationId:"private-chat"},
  wechat:{userId:"wx-owner",conversationId:"wx-private"}
};

test("Feishu DOCX evidence reaches one Writer, durable Outcome and final reply",async()=>{
  const runtime=await createJourney({providerMode:"save"});
  try {
    const running=runtime.dispatcher.handleTaskIncomingMessage(
      incoming("v445-docx-success")
    );
    await runtime.providerStarted.promise;
    assert.equal(runtime.timer.delay,300_000);
    await runtime.timer.callback();
    await runtime.timer.callback();
    runtime.releaseProvider.resolve();
    const result=await running;

    assert.equal(
      result.status,"committed",
      JSON.stringify(runtime.state.getOutcome("feishu:v445-docx-success"))
    );
    assert.deepEqual(runtime.counts,{
      inspections:1,exports:1,evidence:1,assistant:1,writer:1
    });
    assert.deepEqual(runtime.order,[
      "assistant","progress","writer","reply"
    ]);
    assert.equal(runtime.sent.filter(item=>
      item.idempotencyKey.startsWith("docx-progress:")
    ).length,1);
    assert.equal(runtime.sent.filter(item=>
      item.idempotencyKey.startsWith("reply:")
    ).length,1);

    const retained=await runtime.retained();
    const handle=retained.sources[0].handle;
    const index=JSON.parse(await readFile(
      join(retained.workspaceDir,"source-001.docx-index.json"),"utf8"
    ));
    assert.equal(index.originalSha256,handle.sha256);
    assert.equal(index.coverage.status,"complete");
    assert.deepEqual(index.coverage.limitations,[]);
    assert.equal(index.images.length,1);
    assert.equal(
      sha(await readFile(join(
        retained.workspaceDir,index.images[0].relativePath
      ))),
      index.images[0].sha256
    );
    assert.equal(runtime.providerOptions.timeoutMs,600_000);
    assert.equal(runtime.providerOptions.allowSourceRead,false);
    assert.equal(runtime.providerOptions.modelImageFiles.length,1);
    const observation=JSON.parse(
      runtime.providerContext.sourceObservations[0].content
    );
    assert.equal(observation.coverageStatus,"complete");
    assert.equal(
      observation.observations.some(item=>item.text==="核心正文"),true
    );

    const outcome=runtime.state.getOutcome("feishu:v445-docx-success");
    assert.equal(outcome.status,"committed");
    assert.equal(outcome.replied,true);
    assert.match(outcome.reply,/知识资料已保存/u);
    assert.deepEqual(
      (await readdir(join(runtime.libraryRoot,"合成 DOCX 摘要"))).sort(),
      ["knowledge.md","source-001.docx"]
    );
    assert.deepEqual(await readdir(runtime.exportRoot),[]);
    assert.deepEqual(await readdir(runtime.docxTempRoot),[]);
  } finally {
    runtime.releaseProvider.resolve();
    await rm(runtime.root,{recursive:true,force:true});
  }
});

test("selected partial DOCX evidence blocks Writer but keeps a truthful reply",async()=>{
  const runtime=await createJourney({fixtureMode:"partial",providerMode:"save"});
  try {
    runtime.releaseProvider.resolve();
    const result=await runtime.dispatcher.handleTaskIncomingMessage(
      incoming("v445-docx-partial")
    );
    assert.equal(result.status,"committed");
    assert.equal(runtime.counts.writer,0);
    assert.equal(runtime.counts.assistant,1);
    const outcome=runtime.state.getOutcome("feishu:v445-docx-partial");
    assert.match(outcome.reply,/未完整表示/u);
    assert.match(outcome.reply,/没有调用 Writer/u);
    assert.deepEqual(outcome.artifacts,[]);
    assert.equal((await runtime.retained()).sources.length,1);
    assert.deepEqual(await readdir(runtime.libraryRoot),[]);
  } finally { await rm(runtime.root,{recursive:true,force:true}); }
});

test("DOCX preparation failure retains the source and stops before AI or Writer",async()=>{
  const runtime=await createJourney({readerMode:"fail",providerMode:"save"});
  try {
    runtime.releaseProvider.resolve();
    const result=await runtime.dispatcher.handleTaskIncomingMessage(
      incoming("v445-docx-prepare-failure")
    );
    assert.equal(result.status,"failed");
    assert.deepEqual(runtime.counts,{
      inspections:1,exports:1,evidence:1,assistant:0,writer:0
    });
    const outcome=runtime.state.getOutcome(
      "feishu:v445-docx-prepare-failure"
    );
    assert.equal(outcome.reasonCode,"docx_prepare_failed");
    assert.match(outcome.reply,/可以直接重试/u);
    const retained=await runtime.retained();
    assert.deepEqual(
      (await readdir(retained.workspaceDir)).sort(),
      ["source-001.docx","task-sources.json"]
    );
    assert.deepEqual(await readdir(runtime.libraryRoot),[]);
  } finally { await rm(runtime.root,{recursive:true,force:true}); }
});

for (const [providerMode,reasonCode] of [
  ["timeout","assistant_timeout"],
  ["source_read","assistant_model_failed"]
]) {
  test(`${providerMode} DOCX result is one AI call and zero writes`,async()=>{
    const runtime=await createJourney({providerMode});
    try {
      runtime.releaseProvider.resolve();
      const result=await runtime.dispatcher.handleTaskIncomingMessage(
        incoming(`v445-docx-${providerMode}`)
      );
      assert.equal(result.status,"failed");
      assert.equal(runtime.counts.assistant,1);
      assert.equal(runtime.counts.writer,0);
      const outcome=runtime.state.getOutcome(
        `feishu:v445-docx-${providerMode}`
      );
      assert.equal(outcome.reasonCode,reasonCode);
      assert.deepEqual(outcome.artifacts,[]);
      assert.equal((await runtime.retained()).sources.length,1);
      assert.deepEqual(await readdir(runtime.libraryRoot),[]);
    } finally { await rm(runtime.root,{recursive:true,force:true}); }
  });
}

async function createJourney({
  fixtureMode="complete",readerMode="normal",providerMode
}) {
  const root=await mkdtemp(join(tmpdir(),"llw-v445-docx-journey-"));
  await chmod(root,0o700);
  const vaultRoot=join(root,"vault");
  const libraryRoot=join(vaultRoot,"work-library");
  await mkdir(join(vaultRoot,".obsidian"),{recursive:true,mode:0o700});
  await mkdir(join(vaultRoot,".llw-system"),{recursive:true,mode:0o700});
  await mkdir(libraryRoot,{recursive:true,mode:0o700});
  await writeFile(
    join(vaultRoot,".llw-system","SYSTEM_MAP.md"),
    "# synthetic vault\n",{mode:0o600}
  );
  const state=await StateStore.open(join(root,"state.json"));
  const taskManager=new PersonalAssistantTaskSessionManager({
    state,bindings:BINDINGS,selectModel:async()=>"codex",
    createId:()=>TASK_ID,now:()=>Date.parse(NOW)
  });
  const counts={
    inspections:0,exports:0,evidence:0,assistant:0,writer:0
  };
  const exportRoot=join(root,"exports");
  const exporter=createFeishuDocumentExporter({
    cliPath:"/synthetic/lark-cli",profile:"synthetic",
    tempRoot:exportRoot,timeoutMs:120_000,
    execute:async({args,cwd,timeoutMs})=>{
      assert.equal(timeoutMs,120_000);
      assert.equal(args.includes("--as"),true);
      assert.equal(args[args.indexOf("--as")+1],"user");
      if (args.includes("+inspect")) {
        counts.inspections+=1;
        return {
          ok:true,identity:"user",
          data:{type:"docx",token:"synthetic_token",title:"合成 DOCX"}
        };
      }
      counts.exports+=1;
      const unsupported=fixtureMode==="partial"
        ?'<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"/>'
        :"";
      await buildDocxFixture(cwd,{
        name:"snapshot.docx",
        documentXml:wordDocument(
          paragraph("核心正文")+imageParagraph("rIdImage")+unsupported
        ),
        extraParts:{"word/media/body.png":PNG_1X1},
        relationsByOwner:{"word/document.xml":[
          {id:"rIdLink",type:`${REL_BASE}/hyperlink`,
            target:"https://example.invalid/reference",mode:"External"},
          {id:"rIdImage",type:`${REL_BASE}/image`,target:"media/body.png"}
        ]}
      });
      await rm(join(cwd,"snapshot.docx-package"),{
        recursive:true,force:true
      });
      return {ok:true,identity:"user",data:{ready:true}};
    }
  });
  const prepareTurnSources=createAssistantSourcePreparer({
    tempRoot:join(root,"turn-intake"),
    download:async()=>{throw new Error("unexpected_download");},
    exportFeishuDocument:exporter.exportSnapshot
  });
  const taskWorkspace=new TaskSourceWorkspace({
    root:join(root,"task-sources"),prepareTurnSources,
    now:()=>Date.parse(NOW)
  });
  const docxTempRoot=join(root,"docx-evidence-jobs");
  const realDocxReader=new TaskDocxReader({
    helperPath:HELPER,tempRoot:docxTempRoot,timeoutMs:2_000
  });
  const docxReader={
    async prepare(input) {
      counts.evidence+=1;
      if (readerMode==="fail") throw new Error("docx_prepare_failed");
      return realDocxReader.prepare(input);
    }
  };
  const providerStarted=deferred();
  const releaseProvider=deferred();
  let providerOptions=null,providerContext=null;
  const assistant=new PersonalAssistantClient({
    codex:async(context,options)=>{
      counts.assistant+=1;
      providerContext=structuredClone(context);
      providerOptions=structuredClone(options);
      assert.equal(options.timeoutMs,600_000);
      assert.equal(options.allowSourceRead,false);
      providerStarted.resolve();
      await releaseProvider.promise;
      if (providerMode==="timeout") throw new Error("assistant_timeout");
      if (providerMode==="source_read") return {
        type:"source_read_request",
        requests:[{
          sourceId:"source-001",view:"inspect_time_range",
          startMs:0,endMs:1_000
        }]
      };
      return saveKnowledgeDecision();
    },
    deepseek:async()=>{throw new Error("unexpected_model");}
  });
  const realWriter=new KnowledgeWriter({
    vaultRoot,libraries:[{
      libraryKey:"work-knowledge",displayName:"Synthetic work",
      aliases:[],root:libraryRoot
    }]
  });
  const sent=[],order=[];
  let timer=null;
  const messenger={
    async send(value) {
      if (value.idempotencyKey.startsWith("docx-progress:")) {
        order.push("progress");
      } else {
        const key=value.idempotencyKey.slice("reply:".length);
        const outcome=state.getOutcome(key);
        assert.ok(outcome,"Outcome must be durable before the final reply");
        assert.notEqual(outcome.replied,true);
        order.push("reply");
      }
      sent.push(structuredClone(value));
    }
  };
  const coordinator=new PersonalAssistantCoordinator({
    assistant,
    writer:{async commit(input){
      counts.writer+=1;order.push("writer");
      return realWriter.commit(input);
    }},
    dailyWriter:{},invoiceWriter:{},
    outcomeStore:{
      get:key=>state.getOutcome(key),markReplied:key=>state.markReplied(key)
    },
    messenger,personalRules:[],skillVersion:"4.4.0",
    taskManager,taskWorkspace,docxReader,
    docxAiTimeoutMs:600_000,docxProgressMs:300_000,
    setTimer(callback,delay){timer={callback,delay};return "docx-timer";},
    clearTimer(id){assert.equal(id,"docx-timer");}
  });
  const originalDecide=assistant.decide.bind(assistant);
  assistant.decide=async(...args)=>{
    order.push("assistant");
    return originalDecide(...args);
  };
  const dispatcher=new PersonalAssistantDispatcher({
    binding:{senderId:"owner",chatId:"private-chat"},
    bindings:BINDINGS,state,coordinator,
    modelMode:{async read(){return "codex";}},
    deepseekEnabled:false,messenger,taskManager,taskWorkspace,
    now:()=>Date.parse(NOW)
  });
  return {
    root,state,taskManager,taskWorkspace,dispatcher,counts,sent,order,
    libraryRoot,exportRoot,docxTempRoot,providerStarted,releaseProvider,
    get timer(){return timer;},
    get providerOptions(){return providerOptions;},
    get providerContext(){return providerContext;},
    retained:()=>taskWorkspace.load({
      taskId:TASK_ID,expectedSourceIds:["source-001"]
    })
  };
}

function saveKnowledgeDecision() {
  return {
    type:"tool_call",toolName:"save_knowledge",
    arguments:{
      libraryKey:"work-knowledge",folderSegments:[],
      title:"合成 DOCX 摘要",summary:"合成 Word 文档摘要。",
      tags:["DOCX"],sourceIds:["source-001"],
      knowledgeSections:{
        keyFacts:["正文与图片证据均由程序确定性提取。"],
        structureAndMainContent:"一段正文与一张图片。",
        reusableContent:["网页超链接只作为文字内容，不主动访问。"],
        sourceNotes:"合成飞书 DOCX 快照。",
        contentIndex:"正文、图片与来源原件。"
      }
    }
  };
}

function incoming(messageId) {
  return createFeishuIncomingMessage({
    messageId,senderId:"owner",chatId:"private-chat",
    messageType:"text",content:`阅读、总结并入库 ${DOCUMENT_URL}`,
    createTimeMs:Date.parse(NOW)
  });
}

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deferred() {
  let resolve;
  const promise=new Promise(done=>{resolve=done;});
  return {promise,resolve};
}
