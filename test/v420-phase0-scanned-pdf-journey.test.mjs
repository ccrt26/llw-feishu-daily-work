import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {
  access,chmod,mkdtemp,mkdir,readFile,rm,writeFile
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {
  createWechatIncomingMessage
} from "../src/core/incoming-message.mjs";
import {prepareInvoicePdf} from "../src/capabilities/invoice/pdf-preparer.mjs";
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
  TaskPdfReader
} from "../src/personal-assistant/task-pdf-reader.mjs";
import {StateStore} from "../src/state-store.mjs";

const fakePdfium=fileURLToPath(
  new URL("./fixtures/fake-pdfium-processor.mjs",import.meta.url)
);
const BINDINGS={
  feishu:{userId:"owner",conversationId:"private-chat"},
  wechat:{userId:"wx-owner",conversationId:"wx-owner"}
};

test("WeChat PDF-only question then late read-only request sends ordered scanned pages to one assistant",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v420-pdf-journey-"));
  const firstTime=Date.parse("2026-07-30T01:00:00.000Z");
  let nowMs=firstTime;
  try {
    await chmod(fakePdfium,0o700);
    const originalBytes=Buffer.from("%PDF-1.7\nscan-only-fixture");
    const originalFile=join(root,"wechat-scan.pdf");
    const originalSha=createHash("sha256")
      .update(originalBytes).digest("hex");
    await writeFile(originalFile,originalBytes,{mode:0o600});
    const processorCount=join(root,"pdfium-count");
    const state=await StateStore.open(join(root,"state.json"));
    const taskManager=new PersonalAssistantTaskSessionManager({
      state,bindings:BINDINGS,selectModel:async()=>"codex",
      createId:()=>"P".repeat(43),now:()=>nowMs
    });
    let downloads=0,writerCalls=0;
    const prepareTurnSources=createAssistantSourcePreparer({
      tempRoot:join(root,"intake"),
      download:async()=>{
        downloads+=1;
        return {file:originalFile,tempDir:root};
      },
      cleanup:async()=>{}
    });
    const taskWorkspace=new TaskSourceWorkspace({
      root:join(root,"task-sources"),
      prepareTurnSources,now:()=>nowMs
    });
    const pdfReader=new TaskPdfReader({
      pdfProcessorPath:fakePdfium,
      preparePdf:options=>prepareInvoicePdf({
        ...options,
        environment:{
          ...process.env,
          FAKE_PDFIUM_MODE:"ok",
          FAKE_PDFIUM_PAGES:"2",
          FAKE_PDFIUM_TEXT:"",
          FAKE_PDFIUM_COUNT:processorCount
        }
      }),
      tempRoot:join(root,"pdf-jobs"),
      maxPages:10,maxTextBytes:262_144,
      maxRenderBytes:100*1024*1024,
      maxDimension:3508,timeoutMs:2_000
    });
    const decisions=[],imageCalls=[];
    const assistant=new PersonalAssistantClient({
      codex:async(context,options)=>{
        decisions.push(structuredClone(context));
        imageCalls.push(structuredClone(options.modelImageFiles));
        if (decisions.length===1) {
          assert.equal(context.instructionText,"");
          assert.equal(context.sourceObservations.length,1);
          assert.deepEqual(
            options.modelImageFiles.map(item=>item.pageNumber),
            [1,2]
          );
          return {
            type:"ask",
            question:"你希望我如何处理这份 PDF？",
            waitingType:"waiting_answer",
            preparedTool:null
          };
        }
        assert.equal(context.instructionText,"先总结，不保存");
        assert.equal(context.sourceObservations.length,1);
        assert.equal(
          JSON.parse(context.sourceObservations[0].content).textAvailable,
          false
        );
        assert.deepEqual(
          options.modelImageFiles.map(item=>item.pageNumber),
          [1,2]
        );
        for (const item of options.modelImageFiles) {
          const bytes=await readFile(
            join(options.workspaceDir,item.relativePath)
          );
          assert.equal(
            createHash("sha256").update(bytes).digest("hex"),
            item.sha256
          );
        }
        return {
          type:"reply",
          text:"已依据两页扫描内容完成总结；没有执行保存。"
        };
      },
      deepseek:async()=>{throw new Error("unexpected_model");}
    });
    const sent=[];
    const messenger={
      async send(value){sent.push(structuredClone(value));}
    };
    const coordinator=new PersonalAssistantCoordinator({
      prepareSource:prepareTurnSources,
      assistant,
      writer:{async commit(){writerCalls+=1;}},
      dailyWriter:{async write(){writerCalls+=1;}},
      invoiceWriter:{async commit(){writerCalls+=1;}},
      outcomeStore:{
        get:key=>state.getOutcome(key),
        markReplied:key=>state.markReplied(key)
      },
      messenger,personalRules:[],model:"codex",
      skillVersion:"4.1.0",
      taskManager,taskWorkspace,pdfReader
    });
    const dispatcher=new PersonalAssistantDispatcher({
      binding:{senderId:"owner",chatId:"private-chat"},
      bindings:BINDINGS,state,coordinator,
      modelMode:{async read(){return "codex";}},
      deepseekEnabled:false,messenger,
      taskManager,taskWorkspace,now:()=>nowMs
    });

    const first=await dispatcher.handleTaskIncomingMessage(
      createWechatIncomingMessage({
        messageId:"wechat-pdf",
        userId:"wx-owner",
        conversationId:"wx-owner",
        createTimeMs:firstTime,
        type:"file",
        contextToken:"ctx-pdf",
        instructionText:"",
        attachment:{
          type:"file",
          sourceAttachmentId:"wxr-pdf",
          displayName:"扫描材料.pdf",
          extension:"pdf"
        }
      })
    );
    assert.equal(first.status,"awaiting_clarification");
    assert.equal(downloads,1);
    assert.equal(await readFile(processorCount,"utf8"),"1");
    const taskId=taskManager.current("wechat").taskId;
    const retained=await taskWorkspace.load({
      taskId,expectedSourceIds:["source-001"]
    });
    assert.equal(retained.sources[0].handle.sha256,originalSha);

    nowMs=firstTime+20_000;
    const second=await dispatcher.handleTaskIncomingMessage(
      createWechatIncomingMessage({
        messageId:"wechat-instruction",
        userId:"wx-owner",
        conversationId:"wx-owner",
        createTimeMs:nowMs,
        type:"text",
        contextToken:"ctx-text",
        text:"先总结，不保存"
      })
    );
    assert.equal(second.status,"committed");
    assert.equal(taskManager.current("wechat").taskId,taskId);
    assert.equal(downloads,1);
    assert.equal(await readFile(processorCount,"utf8"),"1");
    assert.equal(writerCalls,0);
    assert.equal(decisions.length,2);
    assert.deepEqual(
      imageCalls[0].map(item=>item.relativePath),
      [
        "source-001.page-001.png",
        "source-001.page-002.png"
      ]
    );
    assert.deepEqual(
      imageCalls[1].map(item=>item.relativePath),
      [
        "source-001.page-001.png",
        "source-001.page-002.png"
      ]
    );
    assert.equal(sent.length,2);
    assert.match(sent[1].text,/没有执行保存/u);
    await access(join(
      taskWorkspace.workspace(taskId),"source-001.page-001.png"
    ));
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test("a WeChat AI timeout retries the same durable PDF without download, PDFium or Writer repetition",async()=>{
  let calls=0;
  const harness=await journeyHarness({
    codex:async(context,options)=>{
      calls+=1;
      assert.equal(context.sources[0].sourceId,"source-001");
      assert.deepEqual(
        options.modelImageFiles.map(item=>item.pageNumber),
        [1,2]
      );
      if (calls===1) throw new Error("assistant_timeout");
      return {
        type:"reply",
        text:"已从同一份扫描 PDF 重试成功；没有执行保存。"
      };
    }
  });
  try {
    const failed=await harness.dispatcher.handleTaskIncomingMessage(
      harness.fileMessage({
        id:"timeout-pdf",
        resource:"wxr-pdf",
        displayName:"扫描材料.pdf",
        extension:"pdf",
        instructionText:"先总结，不保存"
      })
    );
    assert.equal(failed.status,"failed");
    assert.equal(
      harness.state.getOutcome("wechat:timeout-pdf").reasonCode,
      "assistant_timeout"
    );
    assert.equal(harness.downloads(),1);
    assert.equal(await readFile(harness.processorCount,"utf8"),"1");
    assert.equal(harness.writerCalls(),0);

    harness.advance(20_000);
    const retried=await harness.dispatcher.handleTaskIncomingMessage(
      harness.textMessage({id:"retry-pdf",text:"直接重试"})
    );
    assert.equal(retried.status,"committed");
    assert.equal(harness.downloads(),1);
    assert.equal(await readFile(harness.processorCount,"utf8"),"1");
    assert.equal(harness.writerCalls(),0);
    assert.equal(calls,2);
  } finally {
    await rm(harness.root,{recursive:true,force:true});
  }
});

test("an old TXT and a newly specified PDF coexist while only PDF pages enter model images",async()=>{
  const calls=[];
  const harness=await journeyHarness({
    codex:async(context,options)=>{
      calls.push({
        sources:context.sources.map(source=>source.sourceId),
        images:options.modelImageFiles.map(item=>item.sourceId),
        instruction:context.instructionText
      });
      return {
        type:"reply",
        text:calls.length===1
          ?"旧文字来源已保留。"
          :"已总结新 PDF；没有执行保存。"
      };
    }
  });
  try {
    const first=await harness.dispatcher.handleTaskIncomingMessage(
      harness.fileMessage({
        id:"old-txt",
        resource:"wxr-txt",
        displayName:"旧资料.txt",
        extension:"txt",
        instructionText:"先读这份旧资料，不保存"
      })
    );
    assert.equal(first.status,"committed");
    harness.advance(20_000);
    const second=await harness.dispatcher.handleTaskIncomingMessage(
      harness.fileMessage({
        id:"new-pdf",
        resource:"wxr-pdf",
        displayName:"新扫描材料.pdf",
        extension:"pdf",
        instructionText:"总结这个 PDF，不保存"
      })
    );
    assert.equal(second.status,"committed");
    assert.deepEqual(calls,[
      {
        sources:["source-001"],
        images:[],
        instruction:"先读这份旧资料，不保存"
      },
      {
        sources:["source-001","source-002"],
        images:["source-002","source-002"],
        instruction:"总结这个 PDF，不保存"
      }
    ]);
    assert.equal(harness.downloads(),2);
    assert.equal(await readFile(harness.processorCount,"utf8"),"1");
    const current=harness.taskManager.current("wechat");
    assert.deepEqual(current.sourceIds,["source-001","source-002"]);
    const retained=await harness.taskWorkspace.load({
      taskId:current.taskId,
      expectedSourceIds:current.sourceIds
    });
    assert.deepEqual(
      retained.sources.map(source=>source.handle.format),
      ["txt","pdf"]
    );
    assert.equal(harness.writerCalls(),0);
  } finally {
    await rm(harness.root,{recursive:true,force:true});
  }
});

test("two ten-page WeChat PDFs ask for batching without a second AI call",async()=>{
  let assistantCalls=0;
  const harness=await journeyHarness({
    pdfPages:10,
    codex:async()=>{
      assistantCalls+=1;
      return {
        type:"reply",
        text:"第一份材料已只读分析，没有保存。"
      };
    }
  });
  try {
    assert.equal((await harness.dispatcher.handleTaskIncomingMessage(
      harness.fileMessage({
        id:"pdf-a",resource:"wxr-pdf-a",
        displayName:"扫描材料A.pdf",extension:"pdf",
        instructionText:"总结这份材料，不保存"
      })
    )).status,"committed");
    harness.advance(20_000);
    const second=await harness.dispatcher.handleTaskIncomingMessage(
      harness.fileMessage({
        id:"pdf-b",resource:"wxr-pdf-b",
        displayName:"扫描材料B.pdf",extension:"pdf",
        instructionText:"把两份材料一起总结，不保存"
      })
    );
    assert.equal(second.status,"rejected");
    assert.equal(assistantCalls,1);
    assert.equal(harness.writerCalls(),0);
    assert.match(harness.sent.at(-1).text,/开始新任务/u);
  } finally {
    await rm(harness.root,{recursive:true,force:true});
  }
});

test("cancelling during PDF preparation aborts the task before AI or Writer",async()=>{
  const started=deferred();
  const release=deferred();
  let observedSignal=null,assistantCalls=0;
  const harness=await journeyHarness({
    codex:async()=>{
      assistantCalls+=1;
      return {type:"reply",text:"must not run"};
    },
    pdfReader:{
      async prepare({signal}) {
        observedSignal=signal;
        started.resolve();
        await release.promise;
        signal.throwIfAborted();
        return {observations:[],modelImageFiles:[]};
      }
    }
  });
  try {
    assert.deepEqual(
      await harness.dispatcher.acceptIncomingMessage(
        harness.fileMessage({
          id:"cancel-pdf",
          resource:"wxr-pdf",
          displayName:"待取消.pdf",
          extension:"pdf",
          instructionText:"总结这个 PDF"
        })
      ),
      {handled:true,status:"accepted"}
    );
    await started.promise;
    const taskId=harness.taskManager.current("wechat").taskId;
    const cancelled=await harness.dispatcher.acceptIncomingMessage(
      harness.textMessage({id:"cancel-command",text:"取消"})
    );
    assert.equal(cancelled.status,"committed");
    assert.equal(observedSignal.aborted,true);
    release.resolve();
    await harness.dispatcher.flushAcceptedMessages();
    assert.equal(assistantCalls,0);
    assert.equal(harness.writerCalls(),0);
    assert.equal(harness.taskManager.current("wechat"),null);
    await assert.rejects(
      access(harness.taskWorkspace.workspace(taskId)),
      {code:"ENOENT"}
    );
  } finally {
    release.resolve();
    await rm(harness.root,{recursive:true,force:true});
  }
});

async function journeyHarness({
  codex,pdfReader=null,pdfPages=2
}) {
  const root=await mkdtemp(join(tmpdir(),"llw-v420-journey-harness-"));
  await chmod(fakePdfium,0o700);
  const files=new Map();
  const pdfBytes=Buffer.from("%PDF-1.7\nscan-only-harness");
  const pdf=join(root,"source.pdf");
  const txt=join(root,"source.txt");
  await writeFile(pdf,pdfBytes,{mode:0o600});
  await writeFile(txt,"OLD-SYNTHETIC-TEXT",{mode:0o600});
  files.set("wxr-pdf",pdf);
  files.set("wxr-pdf-a",pdf);
  files.set("wxr-pdf-b",pdf);
  files.set("wxr-txt",txt);
  const processorCount=join(root,"pdfium-count");
  const state=await StateStore.open(join(root,"state.json"));
  let nowMs=Date.parse("2026-07-30T02:00:00.000Z");
  const taskManager=new PersonalAssistantTaskSessionManager({
    state,bindings:BINDINGS,selectModel:async()=>"codex",
    createId:()=>"H".repeat(43),now:()=>nowMs
  });
  let downloads=0,writerCalls=0;
  const prepareTurnSources=createAssistantSourcePreparer({
    tempRoot:join(root,"intake"),
    download:async({attachment})=>{
      downloads+=1;
      return {file:files.get(attachment.sourceAttachmentId),tempDir:root};
    },
    cleanup:async()=>{}
  });
  const taskWorkspace=new TaskSourceWorkspace({
    root:join(root,"task-sources"),
    prepareTurnSources,now:()=>nowMs
  });
  const activePdfReader=pdfReader??new TaskPdfReader({
    pdfProcessorPath:fakePdfium,
    preparePdf:options=>prepareInvoicePdf({
      ...options,
      environment:{
        ...process.env,
        FAKE_PDFIUM_MODE:"ok",
        FAKE_PDFIUM_PAGES:String(pdfPages),
        FAKE_PDFIUM_TEXT:"",
        FAKE_PDFIUM_COUNT:processorCount
      }
    }),
    tempRoot:join(root,"pdf-jobs"),
    maxPages:10,maxTextBytes:262_144,
    maxRenderBytes:100*1024*1024,
    maxDimension:3508,timeoutMs:2_000
  });
  const assistant=new PersonalAssistantClient({
    codex,
    deepseek:async()=>{throw new Error("unexpected_model");}
  });
  const sent=[];
  const messenger={
    async send(value){sent.push(structuredClone(value));}
  };
  const coordinator=new PersonalAssistantCoordinator({
    prepareSource:prepareTurnSources,
    assistant,
    writer:{async commit(){writerCalls+=1;}},
    dailyWriter:{async write(){writerCalls+=1;}},
    invoiceWriter:{async commit(){writerCalls+=1;}},
    outcomeStore:{
      get:key=>state.getOutcome(key),
      markReplied:key=>state.markReplied(key)
    },
    messenger,personalRules:[],model:"codex",
    skillVersion:"4.1.0",
    taskManager,taskWorkspace,pdfReader:activePdfReader
  });
  const dispatcher=new PersonalAssistantDispatcher({
    binding:{senderId:"owner",chatId:"private-chat"},
    bindings:BINDINGS,state,coordinator,
    modelMode:{async read(){return "codex";}},
    deepseekEnabled:false,messenger,
    taskManager,taskWorkspace,
    cancelTaskWork:value=>coordinator.cancelTaskWork(value),
    now:()=>nowMs
  });
  return {
    root,state,taskManager,taskWorkspace,dispatcher,processorCount,sent,
    downloads:()=>downloads,
    writerCalls:()=>writerCalls,
    advance:value=>{nowMs+=value;},
    fileMessage({
      id,resource,displayName,extension,instructionText
    }) {
      return createWechatIncomingMessage({
        messageId:id,userId:"wx-owner",conversationId:"wx-owner",
        createTimeMs:nowMs,type:"file",contextToken:`ctx-${id}`,
        instructionText,
        attachment:{
          type:"file",sourceAttachmentId:resource,
          displayName,extension
        }
      });
    },
    textMessage({id,text}) {
      return createWechatIncomingMessage({
        messageId:id,userId:"wx-owner",conversationId:"wx-owner",
        createTimeMs:nowMs,type:"text",
        contextToken:`ctx-${id}`,text
      });
    }
  };
}

function deferred() {
  let resolve;
  const promise=new Promise(done=>{resolve=done;});
  return {promise,resolve};
}
