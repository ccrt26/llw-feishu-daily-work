import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {
  access,chmod,mkdir,mkdtemp,readFile,readdir,rm,writeFile
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import {
  createFeishuIncomingMessage
} from "../src/core/incoming-message.mjs";
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
  PersonalAssistantTaskSessionManager
} from "../src/personal-assistant/task-session-manager.mjs";
import {
  TaskSourceWorkspace
} from "../src/personal-assistant/task-source-workspace.mjs";
import {
  TaskDocxReader
} from "../src/personal-assistant/task-docx-reader.mjs";
import {StateStore} from "../src/state-store.mjs";

const run=promisify(execFile);
const TASK_ID="F".repeat(43);
const DOCUMENT_URL=
  "https://example.feishu.cn/docx/v444_synthetic_document";
const RELATIONSHIPS_NAMESPACE=
  "http://schemas.openxmlformats.org/package/2006/relationships";
const HYPERLINK_TYPE=
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";
const IMAGE_TYPE=
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
const BINDINGS={
  feishu:{userId:"owner",conversationId:"private-chat"},
  wechat:{userId:"wx-owner",conversationId:"wx-private"}
};

test("a safe Feishu cloud document reaches one knowledge write and one durable reply",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v444-cloud-success-"));
  try {
    const runtime=await createJourney({root,mixedExternal:false});
    const result=await runtime.dispatcher.handleTaskIncomingMessage(
      incoming("v444-cloud-success")
    );

    assert.equal(result.status,"committed");
    assert.deepEqual(runtime.counts,{exports:1,assistant:1,writer:1});
    assert.deepEqual(runtime.order,["assistant","writer","reply"]);
    assert.deepEqual(runtime.failures,[]);
    assert.equal(runtime.sent.length,1);
    assert.match(runtime.sent[0].text,/知识资料已保存/u);

    const session=runtime.taskManager.current("feishu");
    assert.equal(session.taskId,TASK_ID);
    assert.deepEqual(session.sourceIds,["source-001"]);
    const retained=await runtime.taskWorkspace.load({
      taskId:TASK_ID,expectedSourceIds:["source-001"]
    });
    assert.equal(retained.sources.length,1);
    assert.equal(retained.sources[0].handle.sha256,runtime.snapshotSha());
    assert.equal(
      sha(await readFile(retained.sources[0].absolutePath)),
      runtime.snapshotSha()
    );

    const outcome=runtime.state.getOutcome(
      "feishu:v444-cloud-success"
    );
    assert.equal(outcome.status,"committed");
    assert.equal(outcome.replied,true);
    assert.equal(outcome.artifacts.length,2);
    assert.equal(
      JSON.stringify({
        instruction:runtime.contexts[0].instructionText,
        outcome,sent:runtime.sent,failures:runtime.failures
      }).includes(DOCUMENT_URL),
      false
    );
    assert.equal(
      runtime.contexts[0].instructionText,
      "阅读、总结并入库 [飞书文档快照]"
    );

    const knowledgeDirectory=join(
      runtime.libraryRoot,"合成云文档安全摘要"
    );
    assert.deepEqual(
      (await readdir(knowledgeDirectory)).sort(),
      ["knowledge.md","source-001.docx"]
    );
    assert.equal(
      sha(await readFile(join(knowledgeDirectory,"source-001.docx"))),
      runtime.snapshotSha()
    );
    assert.deepEqual(await readdir(runtime.exportRoot),[]);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test("a mixed safe hyperlink and external image stops before AI and Writer",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v444-cloud-reject-"));
  try {
    const runtime=await createJourney({root,mixedExternal:true});
    const result=await runtime.dispatcher.handleTaskIncomingMessage(
      incoming("v444-cloud-rejected")
    );

    assert.equal(result.status,"failed");
    assert.deepEqual(runtime.counts,{exports:1,assistant:0,writer:0});
    assert.deepEqual(runtime.order,["reply"]);
    assert.deepEqual(runtime.failures,["source_security_rejected"]);
    const outcome=runtime.state.getOutcome(
      "feishu:v444-cloud-rejected"
    );
    assert.equal(outcome.status,"failed");
    assert.equal(outcome.reasonCode,"source_security_rejected");
    assert.equal(outcome.replied,true);
    assert.deepEqual(outcome.artifacts,[]);
    assert.equal(runtime.sent.length,1);
    assert.match(runtime.sent[0].text,/没有调用 AI，也没有写入/u);
    assert.deepEqual(await readdir(runtime.exportRoot),[]);
    assert.deepEqual(await taskSourceDirectories(root),[]);
    assert.deepEqual(await readdir(runtime.libraryRoot),[]);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

async function createJourney({root,mixedExternal}) {
  await chmod(root,0o700);
  const vaultRoot=join(root,"vault");
  const libraryRoot=join(vaultRoot,"work-library");
  await mkdir(join(vaultRoot,".obsidian"),{
    recursive:true,mode:0o700
  });
  await mkdir(join(vaultRoot,".llw-system"),{
    recursive:true,mode:0o700
  });
  await mkdir(libraryRoot,{recursive:true,mode:0o700});
  await writeFile(
    join(vaultRoot,".llw-system","SYSTEM_MAP.md"),
    "# synthetic vault\n",{mode:0o600}
  );

  const state=await StateStore.open(join(root,"state.json"));
  const nowMs=Date.parse("2026-08-02T00:30:00.000Z");
  const taskManager=new PersonalAssistantTaskSessionManager({
    state,bindings:BINDINGS,selectModel:async()=>"codex",
    createId:()=>TASK_ID,now:()=>nowMs
  });
  const counts={exports:0,assistant:0,writer:0};
  let snapshotSha="";
  const exportRoot=join(root,"exports");
  await mkdir(exportRoot,{mode:0o700});
  const prepareTurnSources=createAssistantSourcePreparer({
    tempRoot:join(root,"turn-intake"),
    download:async()=>{throw new Error("unexpected_download");},
    exportFeishuDocument:async({url})=>{
      counts.exports+=1;
      assert.equal(url,DOCUMENT_URL);
      const tempDir=join(exportRoot,`job-${counts.exports}`);
      await mkdir(tempDir,{mode:0o700});
      const file=await createDocx(tempDir,{mixedExternal});
      snapshotSha=sha(await readFile(file));
      return {
        tempDir,file,extension:"docx",
        displayName:"合成云文档.docx",
        safeSourceReference:`feishu:${"a".repeat(64)}`
      };
    }
  });
  const taskWorkspace=new TaskSourceWorkspace({
    root:join(root,"task-sources"),prepareTurnSources,now:()=>nowMs
  });
  const docxReader=new TaskDocxReader({
    helperPath:fileURLToPath(new URL(
      "../src/personal-assistant/docx-evidence-helper.mjs",import.meta.url
    )),
    tempRoot:join(root,"docx-evidence-jobs"),timeoutMs:2_000
  });
  const realWriter=new KnowledgeWriter({
    vaultRoot,
    libraries:[{
      libraryKey:"work-knowledge",displayName:"Synthetic work",
      aliases:[],root:libraryRoot
    }]
  });
  const contexts=[],sent=[],order=[],failures=[];
  const assistant=new PersonalAssistantClient({
    codex:async(context,options)=>{
      counts.assistant+=1;
      order.push("assistant");
      contexts.push(structuredClone(context));
      assert.equal(context.entry,"feishu");
      assert.equal(context.sources.length,1);
      assert.equal(context.sources[0].sourceId,"source-001");
      assert.equal(
        sha(await readFile(join(options.workspaceDir,"source-001.docx"))),
        snapshotSha
      );
      return {
        type:"tool_call",toolName:"save_knowledge",
        arguments:{
          libraryKey:"work-knowledge",folderSegments:[],
          title:"合成云文档安全摘要",
          summary:"合成文档已通过安全关系检查并完成摘要。",
          tags:["云文档"],sourceIds:["source-001"],
          knowledgeSections:{
            keyFacts:["普通网页超链接仅作为文档内容保留。"],
            structureAndMainContent:"合成文档包含正文和惰性网页超链接。",
            reusableContent:["只允许标准 HTTP/HTTPS hyperlink。"],
            sourceNotes:"来源为本测试生成的飞书形态 DOCX 快照。",
            contentIndex:"一份 DOCX 原始来源。"
          }
        }
      };
    },
    deepseek:async()=>{throw new Error("unexpected_model");}
  });
  const messenger={
    async send(value) {
      const key=value.idempotencyKey.slice("reply:".length);
      const persisted=state.getOutcome(key);
      assert.ok(persisted,"Outcome must exist before Messenger");
      assert.notEqual(persisted.replied,true);
      order.push("reply");
      sent.push(structuredClone(value));
    }
  };
  const coordinator=new PersonalAssistantCoordinator({
    prepareSource:prepareTurnSources,assistant,
    writer:{
      async commit(input) {
        counts.writer+=1;
        order.push("writer");
        return realWriter.commit(input);
      }
    },
    dailyWriter:{},invoiceWriter:{},
    outcomeStore:{
      get:key=>state.getOutcome(key),
      markReplied:key=>state.markReplied(key)
    },
    messenger,personalRules:[],model:"codex",skillVersion:"4.4.0",
    taskManager,taskWorkspace,docxReader
  });
  const dispatcher=new PersonalAssistantDispatcher({
    binding:{senderId:"owner",chatId:"private-chat"},
    bindings:BINDINGS,state,coordinator,
    modelMode:{async read(){return "codex";}},
    deepseekEnabled:false,messenger,taskManager,taskWorkspace,
    onFailure:code=>failures.push(code),now:()=>nowMs
  });
  return {
    state,taskManager,taskWorkspace,dispatcher,
    counts,contexts,sent,order,failures,libraryRoot,exportRoot,
    snapshotSha:()=>snapshotSha
  };
}

function incoming(messageId) {
  return createFeishuIncomingMessage({
    messageId,senderId:"owner",chatId:"private-chat",
    messageType:"text",
    content:`阅读、总结并入库 ${DOCUMENT_URL}`,
    createTimeMs:Date.parse("2026-08-02T00:30:00.000Z")
  });
}

async function createDocx(root,{mixedExternal}) {
  const packageRoot=join(root,"package");
  const externalImage=mixedExternal
    ?`<Relationship Id="rId2" Type="${IMAGE_TYPE}" `+
      `Target="https://example.invalid/image.png" TargetMode="External"/>`
    :"";
  const parts={
    "[Content_Types].xml":
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "word/document.xml":
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>SYNTHETIC CLOUD DOCUMENT BODY</w:t></w:r></w:p></w:body></w:document>',
    "word/_rels/document.xml.rels":
      `<?xml version="1.0" encoding="UTF-8"?>`+
      `<Relationships xmlns="${RELATIONSHIPS_NAMESPACE}">`+
      `<Relationship Id="rId1" Type="${HYPERLINK_TYPE}" `+
      `Target="https://example.invalid/reference" TargetMode="External"/>`+
      `${externalImage}</Relationships>`
  };
  for (const [relative,content] of Object.entries(parts)) {
    const target=join(packageRoot,relative);
    await mkdir(dirname(target),{recursive:true,mode:0o700});
    await writeFile(target,content,{mode:0o600});
  }
  const output=join(root,"snapshot.docx");
  await run("/usr/bin/zip",["-q","-r",output,"."],{
    cwd:packageRoot
  });
  await chmod(output,0o600);
  return output;
}

async function taskSourceDirectories(root) {
  const directory=join(root,"task-sources");
  try {
    await access(directory);
    return (await readdir(directory)).sort();
  } catch (error) {
    if (error?.code==="ENOENT") return [];
    throw error;
  }
}

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}
