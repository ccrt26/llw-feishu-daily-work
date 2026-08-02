import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {
  access,chmod,copyFile,mkdir,mkdtemp,readFile,readdir,rm,writeFile
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import {
  createFeishuIncomingMessage,createWechatIncomingMessage
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
import {
  FileOutputWorkspace
} from "../src/workspace/file-output-workspace.mjs";

const run=promisify(execFile);
const BINDINGS={
  feishu:{userId:"owner",conversationId:"private-chat"},
  wechat:{userId:"wx-owner",conversationId:"wx-private"}
};

const KNOWLEDGE_SECTIONS={
  keyFacts:["材料说明终端安全能力建设的主要内容。"],
  structureAndMainContent:"材料按能力范围、工作机制和实施重点组织。",
  reusableContent:["先明确能力范围，再整理实施重点。"],
  sourceNotes:"根据当前任务保留的完整 PDF 来源忠实整理。",
  contentIndex:"来源为一份合成 PDF。"
};

test("file-only question then a late instruction reuses the same task and real PDF in one knowledge write",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v410-root-journey-"));
  try {
    const firstTime=Date.parse("2026-07-29T00:00:00.000Z");
    let nowMs=firstTime;
    const sourcePdf=join(root,"synthetic-security-centre.pdf");
    const sourceBytes=Buffer.from(
      "%PDF-1.7\nSynthetic terminal security centre capability."
    );
    await writeFile(sourcePdf,sourceBytes,{mode:0o600});
    const expectedSha=createHash("sha256")
      .update(sourceBytes).digest("hex");

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
    const taskManager=new PersonalAssistantTaskSessionManager({
      state,bindings:BINDINGS,selectModel:async()=>"codex",
      createId:()=>"t".repeat(43),now:()=>nowMs
    });
    let downloads=0,writerCalls=0;
    const prepareTurnSources=createAssistantSourcePreparer({
      tempRoot:join(root,"intake"),
      download:async()=>{
        downloads+=1;
        return {file:sourcePdf,tempDir:root};
      },
      cleanup:async()=>{}
    });
    const taskWorkspace=new TaskSourceWorkspace({
      root:join(root,"task-sources"),
      prepareTurnSources,now:()=>nowMs
    });
    const realWriter=new KnowledgeWriter({
      vaultRoot,
      libraries:[{
        libraryKey:"work-knowledge",displayName:"Synthetic work",
        aliases:[],root:libraryRoot
      }]
    });
    const contexts=[],sent=[],order=[];
    const assistant=new PersonalAssistantClient({
      codex:async context=>{
        contexts.push(structuredClone(context));
        if (contexts.length===1) {
          return {
            type:"ask",
            question:"你希望我总结、分析，还是整理后保存？",
            waitingType:"waiting_answer",
            preparedTool:"save_knowledge",
            taskUpdate:{
              workingSummary:"用户提供了一份终端安全能力材料，等待明确处理目标。",
              confirmedRequirements:[],
              rejectedDirections:[]
            }
          };
        }
        return {
          type:"tool_call",toolName:"save_knowledge",
          arguments:{
            libraryKey:"work-knowledge",
            folderSegments:["安全资料"],
            title:"终端安全能力中心介绍",
            summary:"终端安全能力建设的主要内容。",
            tags:["终端安全"],
            sourceIds:["source-001"],
            knowledgeSections:KNOWLEDGE_SECTIONS
          },
          taskUpdate:{
            workingSummary:"已按用户要求整理主要内容并保存到工作知识库。",
            confirmedRequirements:["整理主要内容","保存到工作知识库"],
            rejectedDirections:[]
          }
        };
      },
      deepseek:async()=>{throw new Error("unexpected_model");}
    });
    const outcomeStore={
      get:key=>state.getOutcome(key),
      markReplied:key=>state.markReplied(key)
    };
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
      prepareSource:prepareTurnSources,
      assistant,
      writer:{
        async commit(input) {
          writerCalls+=1;
          order.push("writer");
          return realWriter.commit(input);
        }
      },
      dailyWriter:{},invoiceWriter:{},
      outcomeStore,messenger,
      personalRules:[],model:"codex",skillVersion:"4.1.0",
      taskManager,taskWorkspace
    });
    const dispatcher=new PersonalAssistantDispatcher({
      binding:{senderId:"owner",chatId:"private-chat"},
      bindings:BINDINGS,state,coordinator,
      modelMode:{async read(){return "codex";}},
      deepseekEnabled:false,messenger,
      taskManager,taskWorkspace,now:()=>nowMs
    });

    const first=await dispatcher.handleTaskIncomingMessage(
      createFeishuIncomingMessage({
        messageId:"pdf-only",senderId:"owner",
        chatId:"private-chat",messageType:"file",
        content:'<file key="file_synthetic_pdf" name="能力介绍.pdf"/>',
        createTimeMs:firstTime
      })
    );
    assert.equal(first.status,"awaiting_clarification");
    const afterQuestion=taskManager.current("feishu");
    assert.equal(afterQuestion.revision,1);
    assert.equal(afterQuestion.resolvedRevision,1);
    assert.deepEqual(afterQuestion.sourceIds,["source-001"]);
    const taskId=afterQuestion.taskId;
    const retained=await taskWorkspace.load({
      taskId,expectedSourceIds:["source-001"]
    });
    assert.equal(retained.sources[0].handle.sha256,expectedSha);
    assert.equal(
      createHash("sha256")
        .update(await readFile(retained.sources[0].absolutePath))
        .digest("hex"),
      expectedSha
    );

    nowMs=firstTime+20_000;
    const second=await dispatcher.handleTaskIncomingMessage(
      createFeishuIncomingMessage({
        messageId:"late-instruction",senderId:"owner",
        chatId:"private-chat",messageType:"text",
        content:"整理主要内容并保存到亚信工作知识库",
        createTimeMs:nowMs
      })
    );
    assert.equal(
      second.status,"committed",
      JSON.stringify(state.getOutcome("feishu:late-instruction"))
    );
    const finalSession=taskManager.current("feishu");
    assert.equal(finalSession.taskId,taskId);
    assert.equal(finalSession.revision,2);
    assert.equal(finalSession.resolvedRevision,2);
    assert.deepEqual(finalSession.sourceIds,["source-001"]);
    assert.equal(contexts.length,2);
    assert.equal(contexts[1].task.taskId,taskId);
    assert.equal(contexts[1].task.revision,2);
    assert.deepEqual(contexts[1].task.sourceIds,["source-001"]);
    assert.equal(contexts[1].sources[0].sha256,expectedSha);
    assert.equal(
      contexts[1].instructionText,
      "整理主要内容并保存到亚信工作知识库"
    );
    assert.equal(downloads,1);
    assert.equal(writerCalls,1);
    assert.deepEqual(order,["reply","writer","reply"]);
    assert.equal(sent.length,2);
    assert.equal(sent[0].text,"你希望我总结、分析，还是整理后保存？");
    assert.match(sent[1].text,/知识资料已保存/u);
    assert.equal(
      sent[1].replyTarget.sourceMessageId,
      "late-instruction"
    );
    const categoryDirectories=(await readdir(libraryRoot,{
      withFileTypes:true
    })).filter(entry=>entry.isDirectory());
    assert.deepEqual(
      categoryDirectories.map(entry=>entry.name),
      ["安全资料"]
    );
    const categoryRoot=join(
      libraryRoot,categoryDirectories[0].name
    );
    const knowledgeItems=(await readdir(categoryRoot,{
      withFileTypes:true
    })).filter(entry=>entry.isDirectory());
    assert.equal(knowledgeItems.length,1);
    const itemFiles=await readdir(
      join(categoryRoot,knowledgeItems[0].name)
    );
    assert.deepEqual(
      itemFiles.sort(),
      ["knowledge.md","source-001.pdf"]
    );
    assert.equal(
      createHash("sha256")
        .update(await readFile(join(
          categoryRoot,knowledgeItems[0].name,"source-001.pdf"
        )))
        .digest("hex"),
      expectedSha
    );
    assert.equal(
      state.getOutcome("feishu:late-instruction").replied,
      true
    );
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test("a supplement accepted during analysis blocks the stale document tool and only revision 2 publishes",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v410-revision-journey-"));
  try {
    const firstTime=Date.parse("2026-07-29T01:00:00.000Z");
    let nowMs=firstTime;
    const state=await StateStore.open(join(root,"state.json"));
    const taskManager=new PersonalAssistantTaskSessionManager({
      state,bindings:BINDINGS,selectModel:async()=>"codex",
      createId:()=>"r".repeat(43),now:()=>nowMs
    });
    const taskWorkspace=new TaskSourceWorkspace({
      root:join(root,"task-sources"),
      prepareTurnSources:createAssistantSourcePreparer({
        tempRoot:join(root,"intake"),
        download:async()=>{throw new Error("unexpected_download");}
      }),
      now:()=>nowMs
    });
    const outputWorkspace=new FileOutputWorkspace({
      tempRoot:join(root,"document-jobs"),
      outputRoot:join(root,"document-output"),
      maxOutputBytes:20*1024*1024,outputRetentionDays:7
    });
    const generatedDocx=await createDocx(
      root,"最终版本突出风险，不包含预算。","revision-two"
    );
    let releaseFirst;
    const firstDeferred=new Promise(resolve=>{releaseFirst=resolve;});
    let announceFirst;
    const firstStarted=new Promise(resolve=>{announceFirst=resolve;});
    const contexts=[];
    const assistant=new PersonalAssistantClient({
      codex:async context=>{
        contexts.push(structuredClone(context));
        if (contexts.length===1) {
          announceFirst();
          await firstDeferred;
          return {
            type:"tool_call",toolName:"create_document",
            arguments:{
              sourceIds:[],format:"docx",title:"旧版方案",
              content:"# 旧版方案\n\n包含预算。"
            }
          };
        }
        return {
          type:"tool_call",toolName:"create_document",
          arguments:{
            sourceIds:[],format:"docx",title:"风险方案",
            content:"# 风险方案\n\n重点突出风险，不写预算。"
          }
        };
      },
      deepseek:async()=>{throw new Error("unexpected_model");}
    });
    let generatorCalls=0;
    const sent=[];
    const messenger={
      async send(value){sent.push(structuredClone(value));}
    };
    const coordinator=new PersonalAssistantCoordinator({
      prepareSource:taskWorkspace.prepareTurnSources,
      assistant,writer:{},dailyWriter:{},invoiceWriter:{},
      documentWorkspace:outputWorkspace,
      artifactGenerator:async({outputFile,draftVersion})=>{
        generatorCalls+=1;
        assert.equal(draftVersion,2);
        await copyFile(generatedDocx,outputFile);
      },
      outcomeStore:{
        get:key=>state.getOutcome(key),
        markReplied:key=>state.markReplied(key)
      },
      messenger,personalRules:[],model:"codex",
      skillVersion:"4.1.0",taskManager,taskWorkspace
    });
    const dispatcher=new PersonalAssistantDispatcher({
      binding:{senderId:"owner",chatId:"private-chat"},
      bindings:BINDINGS,state,coordinator,
      modelMode:{async read(){return "codex";}},
      deepseekEnabled:false,messenger,
      taskManager,taskWorkspace,now:()=>nowMs
    });

    assert.deepEqual(
      await dispatcher.acceptIncomingMessage(
        createFeishuIncomingMessage({
          messageId:"draft-v1",senderId:"owner",
          chatId:"private-chat",messageType:"text",
          content:"根据现有想法生成方案 Word",
          createTimeMs:firstTime
        })
      ),
      {handled:true,status:"accepted"}
    );
    await firstStarted;
    nowMs=firstTime+1_000;
    assert.deepEqual(
      await dispatcher.acceptIncomingMessage(
        createFeishuIncomingMessage({
          messageId:"supplement-v2",senderId:"owner",
          chatId:"private-chat",messageType:"text",
          content:"重点突出风险，不要写预算",
          createTimeMs:nowMs
        })
      ),
      {handled:true,status:"accepted"}
    );
    assert.equal(taskManager.current("feishu").revision,2);
    assert.equal(generatorCalls,0);
    assert.equal(state.getOutcome("feishu:draft-v1"),null);
    assert.deepEqual(sent,[]);

    releaseFirst();
    await dispatcher.flushAcceptedMessages();

    assert.equal(contexts.length,2);
    assert.equal(contexts[0].task.revision,1);
    assert.equal(contexts[1].task.revision,2);
    assert.equal(
      contexts[1].instructionText,
      "根据现有想法生成方案 Word\n重点突出风险，不要写预算"
    );
    assert.equal(generatorCalls,1);
    assert.equal(
      state.getOutcome("feishu:draft-v1").reasonCode,
      "absorbed_into_task_revision"
    );
    const finalOutcome=state.getOutcome("feishu:supplement-v2");
    assert.equal(finalOutcome.status,"committed");
    assert.equal(finalOutcome.replyFiles.length,1);
    assert.equal(
      await outputWorkspace.verifyPublished(
        finalOutcome.replyFiles[0]
      ),
      true
    );
    assert.equal(sent.length,1);
    assert.equal(
      sent[0].replyTarget.sourceMessageId,
      "supplement-v2"
    );
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test("Feishu and WeChat keep isolated active tasks, source workspaces and reply targets",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v410-channel-journey-"));
  try {
    const firstTime=Date.parse("2026-07-29T02:00:00.000Z");
    let nowMs=firstTime,idIndex=0;
    const feishuPdf=join(root,"feishu-source.pdf");
    await writeFile(
      feishuPdf,Buffer.from("%PDF-1.7\nFeishu synthetic source."),
      {mode:0o600}
    );
    const wechatDocx=await createDocx(
      root,"WeChat synthetic source.","wechat-source"
    );
    const sourceFiles=new Map([
      ["file_feishu_pdf",feishuPdf],
      ["wx_docx",wechatDocx]
    ]);
    const state=await StateStore.open(join(root,"state.json"));
    const taskManager=new PersonalAssistantTaskSessionManager({
      state,bindings:BINDINGS,selectModel:async()=>"codex",
      createId:()=>{
        idIndex+=1;
        return (idIndex===1?"f":"w").repeat(43);
      },
      now:()=>nowMs
    });
    const prepareTurnSources=createAssistantSourcePreparer({
      tempRoot:join(root,"intake"),
      download:async({attachment})=>({
        file:sourceFiles.get(attachment.sourceAttachmentId),
        tempDir:root
      }),
      cleanup:async()=>{}
    });
    const taskWorkspace=new TaskSourceWorkspace({
      root:join(root,"task-sources"),
      prepareTurnSources,now:()=>nowMs
    });
    const docxReader=new TaskDocxReader({
      helperPath:fileURLToPath(new URL(
        "../src/personal-assistant/docx-evidence-helper.mjs",import.meta.url
      )),
      tempRoot:join(root,"docx-evidence-jobs"),timeoutMs:2_000
    });
    const contexts=[],sent=[];
    const assistant=new PersonalAssistantClient({
      codex:async context=>{
        contexts.push(structuredClone(context));
        return {
          type:"reply",
          text:context.entry==="feishu"
            ?"飞书 PDF 已保留在当前任务。"
            :"微信 DOCX 已保留在当前任务。"
        };
      },
      deepseek:async()=>{throw new Error("unexpected_model");}
    });
    const messenger={
      async send(value){sent.push(structuredClone(value));}
    };
    const coordinator=new PersonalAssistantCoordinator({
      prepareSource:prepareTurnSources,assistant,
      writer:{},dailyWriter:{},invoiceWriter:{},
      outcomeStore:{
        get:key=>state.getOutcome(key),
        markReplied:key=>state.markReplied(key)
      },
      messenger,personalRules:[],model:"codex",
      skillVersion:"4.1.0",taskManager,taskWorkspace,docxReader
    });
    const dispatcher=new PersonalAssistantDispatcher({
      binding:{senderId:"owner",chatId:"private-chat"},
      bindings:BINDINGS,state,coordinator,
      modelMode:{async read(){return "codex";}},
      deepseekEnabled:false,messenger,
      taskManager,taskWorkspace,now:()=>nowMs
    });

    await dispatcher.handleTaskIncomingMessage(
      createFeishuIncomingMessage({
        messageId:"feishu-file",senderId:"owner",
        chatId:"private-chat",messageType:"file",
        content:'<file key="file_feishu_pdf" name="飞书材料.pdf"/>',
        createTimeMs:firstTime
      })
    );
    nowMs=firstTime+1_000;
    await dispatcher.handleTaskIncomingMessage(
      createWechatIncomingMessage({
        messageId:"wechat-file",userId:"wx-owner",
        conversationId:"wx-private",createTimeMs:nowMs,
        type:"file",contextToken:"wx-context",
        attachment:{
          type:"file",sourceAttachmentId:"wx_docx",
          displayName:"微信材料.docx",extension:"docx"
        }
      })
    );
    const feishuSession=taskManager.current("feishu");
    const wechatSession=taskManager.current("wechat");
    assert.notEqual(feishuSession.taskId,wechatSession.taskId);
    assert.deepEqual(feishuSession.sourceIds,["source-001"]);
    assert.deepEqual(wechatSession.sourceIds,["source-001"]);
    assert.notEqual(
      taskWorkspace.workspace(feishuSession.taskId),
      taskWorkspace.workspace(wechatSession.taskId)
    );
    assert.equal(contexts.length,2);
    const feishuContext=contexts.find(item=>item.entry==="feishu");
    const wechatContext=contexts.find(item=>item.entry==="wechat");
    assert.deepEqual(
      feishuContext.sources.map(item=>item.displayName),
      ["飞书材料.pdf"]
    );
    assert.deepEqual(
      wechatContext.sources.map(item=>item.displayName),
      ["微信材料.docx"]
    );
    assert.deepEqual(sent[0].replyTarget,{
      source:"feishu",sourceMessageId:"feishu-file",
      conversationId:"private-chat"
    });
    assert.deepEqual(sent[1].replyTarget,{
      source:"wechat",sourceMessageId:"wechat-file",
      conversationId:"wx-private",contextToken:"wx-context"
    });

    const wechatBeforeEnd=structuredClone(wechatSession);
    nowMs=firstTime+2_000;
    await dispatcher.handleTaskIncomingMessage(
      createFeishuIncomingMessage({
        messageId:"feishu-end",senderId:"owner",
        chatId:"private-chat",messageType:"text",
        content:"结束当前任务",createTimeMs:nowMs
      })
    );
    assert.equal(taskManager.current("feishu"),null);
    assert.deepEqual(
      taskManager.current("wechat"),wechatBeforeEnd
    );
    await assert.rejects(
      access(taskWorkspace.workspace(feishuSession.taskId)),
      {code:"ENOENT"}
    );
    await access(taskWorkspace.workspace(wechatSession.taskId));
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test("process restart preserves the asked task and reuses its retained PDF without redownload",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v410-restart-journey-"));
  try {
    const firstTime=Date.parse("2026-07-29T03:00:00.000Z");
    let nowMs=firstTime;
    const sourcePdf=join(root,"restart-source.pdf");
    await writeFile(
      sourcePdf,Buffer.from("%PDF-1.7\nRestart-safe synthetic source."),
      {mode:0o600}
    );
    const counters={downloads:0};
    const sourceFiles=new Map([["file_restart_pdf",sourcePdf]]);
    const firstRuntime=await createTaskRuntime({
      root,now:()=>nowMs,sourceFiles,counters,
      createId:()=>"a".repeat(43),
      codex:async()=>({
        type:"ask",question:"这份材料准备怎么处理？",
        waitingType:"waiting_answer",preparedTool:null
      })
    });
    await firstRuntime.dispatcher.handleTaskIncomingMessage(
      createFeishuIncomingMessage({
        messageId:"restart-file",senderId:"owner",
        chatId:"private-chat",messageType:"file",
        content:'<file key="file_restart_pdf" name="重启材料.pdf"/>',
        createTimeMs:firstTime
      })
    );
    const beforeRestart=firstRuntime.taskManager.current("feishu");
    const retainedBefore=await firstRuntime.taskWorkspace.load({
      taskId:beforeRestart.taskId,expectedSourceIds:["source-001"]
    });
    const retainedHash=retainedBefore.sources[0].handle.sha256;

    nowMs=firstTime+60_000;
    const afterContexts=[];
    const secondRuntime=await createTaskRuntime({
      root,now:()=>nowMs,sourceFiles,counters,
      createId:()=>"b".repeat(43),
      sent:firstRuntime.sent,
      codex:async context=>{
        afterContexts.push(structuredClone(context));
        return {type:"reply",text:"已继续使用重启前保留的材料。"};
      }
    });
    await secondRuntime.dispatcher.handleTaskIncomingMessage(
      createFeishuIncomingMessage({
        messageId:"restart-answer",senderId:"owner",
        chatId:"private-chat",messageType:"text",
        content:"总结主要风险，不保存",createTimeMs:nowMs
      })
    );
    const afterRestart=secondRuntime.taskManager.current("feishu");
    assert.equal(afterRestart.taskId,beforeRestart.taskId);
    assert.equal(afterRestart.revision,2);
    assert.equal(counters.downloads,1);
    assert.equal(afterContexts.length,1);
    assert.equal(
      afterContexts[0].sources[0].sha256,retainedHash
    );
    assert.equal(
      afterContexts[0].task.waiting.question,
      "这份材料准备怎么处理？"
    );
    assert.equal(firstRuntime.sent.length,2);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test("AI failure can be retried in the same task with the retained source and no resend",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v410-ai-retry-journey-"));
  try {
    const firstTime=Date.parse("2026-07-29T04:00:00.000Z");
    let nowMs=firstTime,assistantCalls=0;
    const sourcePdf=join(root,"retry-source.pdf");
    await writeFile(
      sourcePdf,Buffer.from("%PDF-1.7\nRetry synthetic source."),
      {mode:0o600}
    );
    const counters={downloads:0};
    const retryContexts=[];
    const runtime=await createTaskRuntime({
      root,now:()=>nowMs,
      sourceFiles:new Map([["file_retry_pdf",sourcePdf]]),
      counters,createId:()=>"e".repeat(43),
      codex:async context=>{
        assistantCalls+=1;
        if (assistantCalls===1) {
          throw new Error("synthetic_provider_failure");
        }
        retryContexts.push(structuredClone(context));
        return {type:"reply",text:"重试成功，原文件仍在当前任务中。"};
      }
    });
    const first=await runtime.dispatcher.handleTaskIncomingMessage(
      createFeishuIncomingMessage({
        messageId:"retry-file",senderId:"owner",
        chatId:"private-chat",messageType:"file",
        content:'<file key="file_retry_pdf" name="重试材料.pdf"/>',
        createTimeMs:firstTime
      })
    );
    assert.equal(first.status,"failed");
    const taskId=runtime.taskManager.current("feishu").taskId;
    assert.equal(
      runtime.state.getOutcome("feishu:retry-file").reasonCode,
      "assistant_model_failed"
    );

    nowMs=firstTime+5_000;
    const second=await runtime.dispatcher.handleTaskIncomingMessage(
      createFeishuIncomingMessage({
        messageId:"retry-text",senderId:"owner",
        chatId:"private-chat",messageType:"text",
        content:"重试",createTimeMs:nowMs
      })
    );
    assert.equal(second.status,"committed");
    assert.equal(runtime.taskManager.current("feishu").taskId,taskId);
    assert.equal(assistantCalls,2);
    assert.equal(counters.downloads,1);
    assert.equal(retryContexts[0].sources.length,1);
    assert.equal(retryContexts[0].task.recentTurns.length,2);
    assert.match(
      retryContexts[0].task.recentTurns[1].text,
      /AI 本次未能完成分析/u
    );
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test("Writer failure produces one truthful failure outcome without a second AI call",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v410-writer-failure-"));
  try {
    const firstTime=Date.parse("2026-07-29T05:00:00.000Z");
    const sourcePdf=join(root,"writer-source.pdf");
    await writeFile(
      sourcePdf,Buffer.from("%PDF-1.7\nWriter failure source."),
      {mode:0o600}
    );
    let assistantCalls=0,writerCalls=0;
    const runtime=await createTaskRuntime({
      root,now:()=>firstTime,
      sourceFiles:new Map([["file_writer_pdf",sourcePdf]]),
      counters:{downloads:0},
      createId:()=>"k".repeat(43),
      writer:{
        async commit(){
          writerCalls+=1;
          throw new Error("synthetic_writer_failure");
        }
      },
      codex:async()=>{
        assistantCalls+=1;
        return {
          type:"tool_call",toolName:"save_knowledge",
          arguments:{
            libraryKey:"work-knowledge",folderSegments:[],
            title:"失败测试",summary:"合成失败测试。",
            tags:["测试"],sourceIds:["source-001"],
            knowledgeSections:KNOWLEDGE_SECTIONS
          }
        };
      }
    });
    const result=await runtime.dispatcher.handleTaskIncomingMessage(
      createFeishuIncomingMessage({
        messageId:"writer-file",senderId:"owner",
        chatId:"private-chat",messageType:"file",
        content:'<file key="file_writer_pdf" name="写入失败.pdf"/>',
        createTimeMs:firstTime
      })
    );
    assert.equal(result.status,"failed");
    assert.equal(assistantCalls,1);
    assert.equal(writerCalls,1);
    const outcome=runtime.state.getOutcome("feishu:writer-file");
    assert.equal(outcome.reasonCode,"knowledge_writer_failed");
    assert.equal(outcome.artifacts.length,0);
    assert.doesNotMatch(outcome.reply,/已保存/u);
    assert.equal(runtime.sent.length,1);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test("reply failure leaves the committed Outcome durable and restart resends it without AI or Writer",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v410-reply-recovery-"));
  try {
    const firstTime=Date.parse("2026-07-29T06:00:00.000Z");
    let nowMs=firstTime,assistantCalls=0,writerCalls=0;
    const firstRuntime=await createTaskRuntime({
      root,now:()=>nowMs,createId:()=>"y".repeat(43),
      counters:{downloads:0},
      codex:async()=>{
        assistantCalls+=1;
        return {type:"reply",text:"这是已经确认的阶段结果。"};
      },
      writer:{async commit(){writerCalls+=1;}},
      messenger:{
        async send(){throw new Error("synthetic_reply_failure");}
      }
    });
    await firstRuntime.dispatcher.handleTaskIncomingMessage(
      createFeishuIncomingMessage({
        messageId:"reply-failure",senderId:"owner",
        chatId:"private-chat",messageType:"text",
        content:"给我一个阶段结果",createTimeMs:firstTime
      })
    );
    const durable=firstRuntime.state.getOutcome(
      "feishu:reply-failure"
    );
    assert.equal(durable.status,"committed");
    assert.notEqual(durable.replied,true);

    nowMs=firstTime+2_000;
    const recoveredSent=[];
    const secondRuntime=await createTaskRuntime({
      root,now:()=>nowMs,createId:()=>"z".repeat(43),
      counters:{downloads:0},sent:recoveredSent,
      codex:async()=>{
        assistantCalls+=1;
        throw new Error("must_not_call_ai");
      },
      writer:{async commit(){writerCalls+=1;}}
    });
    await secondRuntime.dispatcher.resumeReplies();
    assert.equal(assistantCalls,1);
    assert.equal(writerCalls,0);
    assert.equal(recoveredSent.length,1);
    assert.equal(
      recoveredSent[0].idempotencyKey,
      "reply:feishu:reply-failure"
    );
    assert.equal(
      secondRuntime.state.getOutcome(
        "feishu:reply-failure"
      ).replied,
      true
    );
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test("cancel during AI makes the old result stale and performs zero Writer calls",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v410-cancel-journey-"));
  try {
    const firstTime=Date.parse("2026-07-29T07:00:00.000Z");
    let nowMs=firstTime,releaseAssistant,announceAssistant;
    const started=new Promise(resolve=>{announceAssistant=resolve;});
    const release=new Promise(resolve=>{releaseAssistant=resolve;});
    let writerCalls=0;
    const runtime=await createTaskRuntime({
      root,now:()=>nowMs,createId:()=>"c".repeat(43),
      counters:{downloads:0},
      writer:{async commit(){writerCalls+=1;}},
      codex:async()=>{
        announceAssistant();
        await release;
        return {
          type:"tool_call",toolName:"save_knowledge",
          arguments:{
            libraryKey:"work-knowledge",folderSegments:[],
            title:"不应写入",summary:"不应写入。",
            tags:[],sourceIds:[],
            knowledgeSections:KNOWLEDGE_SECTIONS
          }
        };
      }
    });
    await runtime.dispatcher.acceptIncomingMessage(
      createFeishuIncomingMessage({
        messageId:"cancel-running",senderId:"owner",
        chatId:"private-chat",messageType:"text",
        content:"整理并保存这段要求",createTimeMs:firstTime
      })
    );
    await started;
    const taskId=runtime.taskManager.current("feishu").taskId;
    await access(runtime.taskWorkspace.workspace(taskId));
    nowMs=firstTime+1_000;
    await runtime.dispatcher.handleTaskIncomingMessage(
      createFeishuIncomingMessage({
        messageId:"cancel-control",senderId:"owner",
        chatId:"private-chat",messageType:"text",
        content:"取消当前任务",createTimeMs:nowMs
      })
    );
    releaseAssistant();
    await runtime.dispatcher.flushAcceptedMessages();
    assert.equal(writerCalls,0);
    assert.equal(runtime.taskManager.current("feishu"),null);
    await assert.rejects(
      access(runtime.taskWorkspace.workspace(taskId)),
      {code:"ENOENT"}
    );
    assert.equal(
      runtime.state.getOutcome(
        "feishu:cancel-running"
      ).reasonCode,
      "cancelled"
    );
    assert.equal(
      runtime.state.getOutcome("feishu:cancel-control").status,
      "committed"
    );
    assert.deepEqual(
      runtime.sent.map(item=>item.text),
      ["已取消，当前任务不会继续处理或保存。"]
    );
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test("cancel after Writer reservation reports the point of no return and preserves the real outcome",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v410-writer-cancel-"));
  try {
    const firstTime=Date.parse("2026-07-29T07:30:00.000Z");
    let nowMs=firstTime,announceWriter,releaseWriter;
    const writerStarted=new Promise(resolve=>{announceWriter=resolve;});
    const writerRelease=new Promise(resolve=>{releaseWriter=resolve;});
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
    const realWriter=new KnowledgeWriter({
      vaultRoot,
      libraries:[{
        libraryKey:"work-knowledge",displayName:"Synthetic",
        aliases:[],root:libraryRoot
      }]
    });
    let writerCalls=0;
    const runtime=await createTaskRuntime({
      root,now:()=>nowMs,createId:()=>"j".repeat(43),
      counters:{downloads:0},
      writer:{
        async commit(input){
          writerCalls+=1;
          announceWriter();
          await writerRelease;
          return realWriter.commit(input);
        }
      },
      codex:async()=>({
        type:"tool_call",toolName:"save_knowledge",
        arguments:{
          libraryKey:"work-knowledge",folderSegments:[],
          title:"不可撤回写入",summary:"用于验证 Writer 提交点。",
          tags:["测试"],sourceIds:[],
          knowledgeSections:KNOWLEDGE_SECTIONS
        }
      })
    });
    await runtime.dispatcher.acceptIncomingMessage(
      createFeishuIncomingMessage({
        messageId:"writer-running",senderId:"owner",
        chatId:"private-chat",messageType:"text",
        content:"整理这段文字并保存",createTimeMs:firstTime
      })
    );
    await writerStarted;
    assert.equal(
      runtime.taskManager.current("feishu")
        .writerCheckpoint.status,
      "reserved"
    );

    nowMs=firstTime+1_000;
    await runtime.dispatcher.handleTaskIncomingMessage(
      createFeishuIncomingMessage({
        messageId:"cancel-after-writer",senderId:"owner",
        chatId:"private-chat",messageType:"text",
        content:"取消",createTimeMs:nowMs
      })
    );
    await waitFor(()=>runtime.sent.length===1);
    assert.match(runtime.sent[0].text,/写入已经开始/u);
    assert.doesNotMatch(runtime.sent[0].text,/不会继续处理或保存/u);

    releaseWriter();
    await runtime.dispatcher.flushAcceptedMessages();
    assert.equal(writerCalls,1);
    assert.equal(runtime.taskManager.current("feishu"),null);
    assert.equal(
      runtime.state.getOutcome("feishu:writer-running").status,
      "committed"
    );
    assert.equal(
      runtime.state.getOutcome(
        "feishu:cancel-after-writer"
      ).status,
      "committed"
    );
    assert.equal(runtime.sent.length,2);
    assert.match(runtime.sent[1].text,/知识资料已保存/u);
    assert.equal(
      (await readdir(libraryRoot,{
        withFileTypes:true
      })).filter(entry=>entry.isDirectory()).length,
      1
    );
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test("24-hour expiration removes the old workspace and gives the next input a new task",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v410-expiry-journey-"));
  try {
    const firstTime=Date.parse("2026-07-29T08:00:00.000Z");
    let nowMs=firstTime,idIndex=0;
    const runtime=await createTaskRuntime({
      root,now:()=>nowMs,
      createId:()=>{
        idIndex+=1;
        return (idIndex===1?"o":"n").repeat(43);
      },
      counters:{downloads:0},
      codex:async()=>({type:"reply",text:"阶段结果已返回。"})
    });
    await runtime.dispatcher.handleTaskIncomingMessage(
      createFeishuIncomingMessage({
        messageId:"before-expiry",senderId:"owner",
        chatId:"private-chat",messageType:"text",
        content:"先分析这个问题",createTimeMs:firstTime
      })
    );
    const oldTaskId=runtime.taskManager.current("feishu").taskId;
    await access(runtime.taskWorkspace.workspace(oldTaskId));

    nowMs=firstTime+24*60*60*1000+1;
    await runtime.dispatcher.handleTaskIncomingMessage(
      createFeishuIncomingMessage({
        messageId:"after-expiry",senderId:"owner",
        chatId:"private-chat",messageType:"text",
        content:"这是到期后的新要求",createTimeMs:nowMs
      })
    );
    const newTaskId=runtime.taskManager.current("feishu").taskId;
    assert.notEqual(newTaskId,oldTaskId);
    await assert.rejects(
      access(runtime.taskWorkspace.workspace(oldTaskId)),
      {code:"ENOENT"}
    );
    await access(runtime.taskWorkspace.workspace(newTaskId));
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test("pause resumes the same task, while ordinary input and explicit new-task controls replace and clean it",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v410-boundary-journey-"));
  try {
    const firstTime=Date.parse("2026-07-29T09:00:00.000Z");
    let nowMs=firstTime,idIndex=0;
    const ids=["p","q","r"].map(letter=>letter.repeat(43));
    const contexts=[];
    const runtime=await createTaskRuntime({
      root,now:()=>nowMs,
      createId:()=>ids[idIndex++],
      counters:{downloads:0},
      codex:async context=>{
        contexts.push(structuredClone(context));
        return {type:"reply",text:"当前要求已处理。"};
      }
    });
    await runtime.dispatcher.handleTaskIncomingMessage(
      createFeishuIncomingMessage({
        messageId:"boundary-first",senderId:"owner",
        chatId:"private-chat",messageType:"text",
        content:"准备第一份方案",createTimeMs:firstTime
      })
    );
    const firstTaskId=runtime.taskManager.current("feishu").taskId;

    nowMs+=1_000;
    await runtime.dispatcher.handleTaskIncomingMessage(
      createFeishuIncomingMessage({
        messageId:"pause-one",senderId:"owner",
        chatId:"private-chat",messageType:"text",
        content:"暂停",createTimeMs:nowMs
      })
    );
    await runtime.dispatcher.flushAcceptedMessages();
    assert.equal(
      runtime.taskManager.current("feishu").status,"paused"
    );
    nowMs+=1_000;
    await runtime.dispatcher.handleTaskIncomingMessage(
      createFeishuIncomingMessage({
        messageId:"resume-one",senderId:"owner",
        chatId:"private-chat",messageType:"text",
        content:"继续刚才的",createTimeMs:nowMs
      })
    );
    await runtime.dispatcher.flushAcceptedMessages();
    assert.equal(
      runtime.taskManager.current("feishu").taskId,firstTaskId
    );
    assert.equal(
      runtime.taskManager.current("feishu").status,"active"
    );

    nowMs+=1_000;
    await runtime.dispatcher.handleTaskIncomingMessage(
      createFeishuIncomingMessage({
        messageId:"pause-two",senderId:"owner",
        chatId:"private-chat",messageType:"text",
        content:"先暂停",createTimeMs:nowMs
      })
    );
    await runtime.dispatcher.flushAcceptedMessages();
    nowMs+=1_000;
    await runtime.dispatcher.handleTaskIncomingMessage(
      createFeishuIncomingMessage({
        messageId:"ordinary-after-pause",senderId:"owner",
        chatId:"private-chat",messageType:"text",
        content:"改为准备第二份方案",createTimeMs:nowMs
      })
    );
    const secondTaskId=runtime.taskManager.current("feishu").taskId;
    assert.notEqual(secondTaskId,firstTaskId);
    await assert.rejects(
      access(runtime.taskWorkspace.workspace(firstTaskId)),
      {code:"ENOENT"}
    );

    nowMs+=1_000;
    await runtime.dispatcher.handleTaskIncomingMessage(
      createFeishuIncomingMessage({
        messageId:"explicit-new",senderId:"owner",
        chatId:"private-chat",messageType:"text",
        content:"开始新任务：准备会议摘要",createTimeMs:nowMs
      })
    );
    await runtime.dispatcher.flushAcceptedMessages();
    const thirdTaskId=runtime.taskManager.current("feishu").taskId;
    assert.notEqual(thirdTaskId,secondTaskId);
    await assert.rejects(
      access(runtime.taskWorkspace.workspace(secondTaskId)),
      {code:"ENOENT"}
    );
    assert.equal(
      contexts.at(-1).instructionText,
      "准备会议摘要"
    );
    assert.equal(contexts.at(-1).task.goal,"准备会议摘要");
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

async function createTaskRuntime({
  root,now,codex,sourceFiles=new Map(),counters={downloads:0},
  createId,writer={},messenger=null,sent=[]
}) {
  const state=await StateStore.open(join(root,"state.json"));
  const taskManager=new PersonalAssistantTaskSessionManager({
    state,bindings:BINDINGS,selectModel:async()=>"codex",
    createId,now
  });
  const prepareTurnSources=createAssistantSourcePreparer({
    tempRoot:join(root,"intake"),
    download:async({attachment})=>{
      counters.downloads+=1;
      const file=sourceFiles.get(attachment.sourceAttachmentId);
      if (!file) throw new Error("synthetic_source_missing");
      return {file,tempDir:root};
    },
    cleanup:async()=>{}
  });
  const taskWorkspace=new TaskSourceWorkspace({
    root:join(root,"task-sources"),
    prepareTurnSources,now
  });
  const actualMessenger=messenger??{
    async send(value){sent.push(structuredClone(value));}
  };
  const assistant=new PersonalAssistantClient({
    codex,
    deepseek:async()=>{throw new Error("unexpected_model");}
  });
  const coordinator=new PersonalAssistantCoordinator({
    prepareSource:prepareTurnSources,assistant,
    writer,dailyWriter:{},invoiceWriter:{},
    outcomeStore:{
      get:key=>state.getOutcome(key),
      markReplied:key=>state.markReplied(key)
    },
    messenger:actualMessenger,
    personalRules:[],model:"codex",skillVersion:"4.1.0",
    taskManager,taskWorkspace
  });
  const dispatcher=new PersonalAssistantDispatcher({
    binding:{senderId:"owner",chatId:"private-chat"},
    bindings:BINDINGS,state,coordinator,
    modelMode:{async read(){return "codex";}},
    deepseekEnabled:false,messenger:actualMessenger,
    taskManager,taskWorkspace,now
  });
  return {
    state,taskManager,taskWorkspace,coordinator,dispatcher,
    messenger:actualMessenger,sent,counters
  };
}

async function waitFor(predicate,{attempts=200}={}) {
  for (let attempt=0;attempt<attempts;attempt+=1) {
    if (predicate()) return;
    await new Promise(resolve=>setTimeout(resolve,1));
  }
  throw new Error("journey_wait_timeout");
}

async function createDocx(root,text,name) {
  const packageRoot=join(root,`${name}-package`);
  const parts={
    "[Content_Types].xml":
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "word/document.xml":
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`
  };
  for (const [relative,content] of Object.entries(parts)) {
    const target=join(packageRoot,relative);
    await mkdir(dirname(target),{recursive:true,mode:0o700});
    await writeFile(target,content,{mode:0o600});
  }
  const output=join(root,`${name}.docx`);
  await run("/usr/bin/zip",["-q","-r",output,"."],{
    cwd:packageRoot
  });
  await chmod(output,0o600);
  return output;
}
