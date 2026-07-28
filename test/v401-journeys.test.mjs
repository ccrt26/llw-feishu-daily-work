import test from "node:test";
import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {
  chmod,copyFile,mkdir,mkdtemp,readFile,rm,writeFile
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname,join} from "node:path";
import {promisify} from "node:util";
import {
  createFeishuIncomingMessage,createWechatIncomingMessage
} from "../src/core/incoming-message.mjs";
import {
  prepareKnowledgeFile,prepareKnowledgeText
} from "../src/capabilities/knowledge-ingest/source-preparer.mjs";
import {
  prepareKnowledgeOfficeFile
} from "../src/capabilities/knowledge-ingest/office-source-preparer.mjs";
import {
  KnowledgeWriter
} from "../src/capabilities/knowledge-ingest/knowledge-writer.mjs";
import {
  InvoiceArchiveWriter
} from "../src/capabilities/invoice/archive-writer.mjs";
import {createSourceEvidence} from "../src/personal-assistant/source-evidence.mjs";
import {PersonalAssistantClient} from "../src/personal-assistant/client.mjs";
import {PersonalAssistantCoordinator} from "../src/personal-assistant/coordinator.mjs";
import {PersonalAssistantDispatcher} from "../src/personal-assistant/dispatcher.mjs";
import {
  createAssistantSourcePreparer
} from "../src/personal-assistant/source-preparer.mjs";
import {StateStore} from "../src/state-store.mjs";
import {FileOutputWorkspace} from "../src/workspace/file-output-workspace.mjs";
import {
  createPersonalAssistantModelSelector
} from "../src/main.mjs";

const run=promisify(execFile);
const KNOWLEDGE_SECTIONS={
  keyFacts:["文档要求先确认交流目标。"],
  structureAndMainContent:"文档包含交流目标和准备动作。",
  reusableContent:["交流前确认目标。"],
  sourceNotes:"根据完整 DOCX 文字来源忠实整理。",
  contentIndex:"来源共一段。"
};

test("Feishu text travels through real preparation, one assistant, tool, Writer, Outcome and Reply",async() => {
  const order=[];
  let assistantCalls=0,writerCalls=0;
  const toolArguments={
    libraryKey:"personal-knowledge",folderSegments:["学习资料"],
    title:"交流准备",summary:"交流前的准备资料。",tags:["交流"],
    sourceIds:[],
    knowledgeSections:{
      keyFacts:["先确认交流目标。"],
      structureAndMainContent:"资料说明目标、对象和后续动作。",
      reusableContent:["交流前确认目标。"],
      sourceNotes:"根据完整文字来源忠实整理。",
      contentIndex:"来源共一段。"
    }
  };
  const assistant=new PersonalAssistantClient({
    codex:async context=>{
      assistantCalls+=1;
      order.push("assistant");
      assert.deepEqual(context.sources,[]);
      assert.equal(context.instructionText.includes("保存到日常生活"),true);
      return {type:"tool_call",toolName:"save_knowledge",arguments:toolArguments};
    },
    deepseek:async()=>{ throw new Error("unexpected"); }
  });
  const saved=[],outcomes=new Map();
  const sent=[];
  const state={
    hasOutcome:key=>outcomes.has(key),
    getOutcome:key=>outcomes.get(key)??null,
    async saveOutcome(key,outcome){
      outcomes.set(key,{...structuredClone(outcome),replied:false});
    },
    async markReplied(key){
      outcomes.get(key).replied=true;
    }
  };
  const coordinator=new PersonalAssistantCoordinator({
    prepareSource:async message=>{
      order.push("prepare");
      return {
        workspaceDir:"/private/tmp/llw-turn-text",
        sources:[],cleanup:async()=>{}
      };
    },
    assistant,
    writer:{
      async commit(input) {
        writerCalls+=1;
        order.push("writer");
        assert.deepEqual(input.sources,[]);
        assert.match(input.sourceSetDigest,/^[a-f0-9]{64}$/u);
        return {
          status:"created",knowledgeId:"k1",libraryKey:"personal-knowledge",
          relativePath:"日常生活/学习资料/交流准备",
          files:["日常生活/学习资料/交流准备/knowledge.md"]
        };
      }
    },
    outcomeStore:{
      get:key=>state.getOutcome(key),
      async save(outcome,key) {
        order.push("outcome");
        saved.push(outcome);
        await state.saveOutcome(key,outcome);
      },
      markReplied:key=>state.markReplied(key)
    },
    messenger:{
      async send(target,reply) { order.push("reply"); sent.push({target,reply}); }
    },
    personalRules:[],
    selectModel:createPersonalAssistantModelSelector({
      modelMode:{async read(){return "codex";}},
      deepseekEnabled:true
    }),
    model:"codex",
    skillVersion:"4.0.1"
  });
  const dispatcher=new PersonalAssistantDispatcher({
    binding:{senderId:"owner",chatId:"private-chat"},
    bindings:{
      feishu:{userId:"owner",conversationId:"private-chat"}
    },
    state,coordinator,
    modelMode:{async read(){return "codex";}},
    deepseekEnabled:true,
    messenger:{async send(){}}
  });
  const message=createFeishuIncomingMessage({
    messageId:"m-v401",senderId:"owner",chatId:"private-chat",
    messageType:"text",
    content:"把交流目标、对象和后续动作保存到日常生活/学习资料",
    createTimeMs:1785196800000
  });
  const handled=await dispatcher.handleIncomingMessage(message);
  const outcome=state.getOutcome("feishu:m-v401");
  assert.deepEqual(order,["prepare","assistant","writer","outcome","reply"]);
  assert.deepEqual(handled,{handled:true,status:"committed"});
  assert.equal(assistantCalls,1);
  assert.equal(writerCalls,1);
  assert.equal(saved.length,1);
  assert.equal(sent.length,1);
  assert.equal(outcome.status,"committed");
});

test("reply recovery reuses Outcome without rerunning assistant or Writer",async() => {
  let assistantCalls=0,writerCalls=0;
  const existing={
    status:"committed",reply:"知识资料已保存。",artifacts:["x/knowledge.md"],
    replyTarget:{source:"feishu",sourceMessageId:"m1",conversationId:"c1"}
  };
  const sent=[];
  const coordinator=new PersonalAssistantCoordinator({
    prepareSource:async()=>{ throw new Error("must_not_prepare"); },
    assistant:{async decide(){ assistantCalls+=1; }},
    writer:{async commit(){ writerCalls+=1; }},
    outcomeStore:{async get(){ return existing; },async save(){ throw new Error("must_not_save"); }},
    messenger:{async send(target,reply){ sent.push({target,reply}); }},
    personalRules:[],model:"codex",skillVersion:"4.0.1"
  });
  await coordinator.handle({
    source:"feishu",sourceMessageId:"m1",receivedAt:"2026-07-28T00:00:00.000Z",
    instructionText:"重复",attachments:[],
    replyTarget:{source:"feishu",sourceMessageId:"m1",conversationId:"c1"}
  });
  assert.equal(assistantCalls,0);
  assert.equal(writerCalls,0);
  assert.equal(sent.length,1);
});

test("WeChat waiting_file gathers two DOCX and one PDF through real preparation, Writer, Outcome and Reply",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v401-wechat-docx-"));
  try {
    const sourceFiles=new Map([
      ["wxr_1",await createDocx(root,"交流方案正文：先确认交流目标。","source-a")],
      ["wxr_2",await createDocx(root,"补充材料：明确对象和后续动作。","source-b")],
      ["wxr_3",join(root,"source-c.pdf")]
    ]);
    await writeFile(
      sourceFiles.get("wxr_3"),
      Buffer.from("%PDF-1.7\n合成补充材料"),
      {mode:0o600}
    );
    const vaultRoot=join(root,"vault");
    const libraryRoot=join(vaultRoot,"personal-library");
    await mkdir(join(vaultRoot,".obsidian"),{recursive:true,mode:0o700});
    await mkdir(join(vaultRoot,".llw-system"),{recursive:true,mode:0o700});
    await mkdir(libraryRoot,{recursive:true,mode:0o700});
    await writeFile(
      join(vaultRoot,".llw-system","SYSTEM_MAP.md"),
      "# synthetic\n",{mode:0o600}
    );
    const state=await StateStore.open(join(root,"state.json"));
    const sent=[];
    const decisions=[
      {
        type:"ask",question:"请发送要保存的 DOCX 文件。",
        waitingType:"waiting_file",preparedTool:"save_knowledge"
      },
      {
        type:"tool_call",toolName:"save_knowledge",
        arguments:{
          libraryKey:"personal-knowledge",folderSegments:["测试资料"],
          title:"交流方案",summary:"交流准备资料。",tags:["测试"],
          sourceIds:["source-001","source-002","source-003"],
          knowledgeSections:KNOWLEDGE_SECTIONS
        }
      }
    ];
    const assistant=new PersonalAssistantClient({
      codex:async context=>{
        if (decisions.length===1) {
          assert.equal(context.instructionText,
            "把我接下来发的文件整理后保存到日常生活");
          assert.deepEqual(
            context.sources.map(source=>source.sourceId),
            ["source-001","source-002","source-003"]
          );
          assert.equal(context.sources.every(source=>!("content" in source)),true);
        }
        return decisions.shift();
      },
      deepseek:async()=>{throw new Error("unexpected");}
    });
    const prepareSource=createAssistantSourcePreparer({
      tempRoot:join(root,"intake"),
      download:async({attachment})=>({
        file:sourceFiles.get(attachment.sourceAttachmentId),tempDir:root
      }),
      cleanup:async()=>{}
    });
    const coordinator=new PersonalAssistantCoordinator({
      prepareSource,assistant,
      writer:new KnowledgeWriter({
        vaultRoot,
        libraries:[{
          libraryKey:"personal-knowledge",displayName:"Synthetic",
          aliases:[],root:libraryRoot
        }]
      }),
      outcomeStore:{
        get:key=>state.getOutcome(key),
        save:(outcome,key)=>state.saveOutcome(key,outcome),
        markReplied:key=>state.markReplied(key)
      },
      messenger:{
        async send(value){sent.push(structuredClone(value));}
      },
      conversationStore:{
        get:(source,now)=>state.getPersonalAssistantConversation(source,now),
        set:(source,value)=>state.setPersonalAssistantConversation(source,value),
        clear:source=>state.clearPersonalAssistantConversation(source)
      },
      personalRules:[],model:"codex",skillVersion:"4.0.1"
    });
    const first=await coordinator.handle(createWechatIncomingMessage({
      messageId:"wx-text-1",userId:"owner",conversationId:"owner",
      createTimeMs:1785196800000,type:"text",contextToken:"ctx",
      text:"把我接下来发的文件整理后保存到日常生活"
    }));
    assert.equal(first.status,"awaiting_clarification");
    assert.equal(
      (await state.getPersonalAssistantConversation(
        "wechat","2026-07-28T00:01:00.000Z"
      )).waitingType,
      "waiting_file"
    );
    const second=await coordinator.handle(createWechatIncomingMessage({
      messageId:"wx-files-2",userId:"owner",conversationId:"owner",
      createTimeMs:1785196860000,type:"files",contextToken:"ctx",
      attachments:[
        {
          type:"file",sourceAttachmentId:"wxr_1",
          displayName:"交流方案.docx",extension:"docx"
        },
        {
          type:"file",sourceAttachmentId:"wxr_2",
          displayName:"补充材料.docx",extension:"docx"
        },
        {
          type:"file",sourceAttachmentId:"wxr_3",
          displayName:"附录.pdf",extension:"pdf"
        }
      ]
    }));
    assert.equal(second.status,"committed");
    assert.equal(sent.length,2);
    assert.equal(
      await state.getPersonalAssistantConversation(
        "wechat","2026-07-28T00:02:00.000Z"
      ),
      null
    );
    assert.match(
      await readFile(join(vaultRoot,second.artifacts[0]),"utf8"),
      /llw_schema: "knowledge-item\/v2"[\s\S]*source-001\.docx[\s\S]*source-002\.docx[\s\S]*source-003\.pdf/u
    );
    assert.ok(state.getOutcome("wechat:wx-files-2"));
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test("no-text Feishu dining invoice reaches the real archive Writer and one reply",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v401-invoice-journey-"));
  try {
    const image=join(root,"source.png");
    await writeFile(image,Buffer.from([
      0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00
    ]),{mode:0o600});
    const vaultRoot=join(root,"vault");
    await mkdir(join(vaultRoot,".obsidian"),{recursive:true,mode:0o700});
    await mkdir(join(vaultRoot,".llw-system"),{recursive:true,mode:0o700});
    await mkdir(
      join(vaultRoot,"亚信工作","日常发票","餐饮发票"),
      {recursive:true,mode:0o700}
    );
    await writeFile(
      join(vaultRoot,".llw-system","SYSTEM_MAP.md"),
      "# synthetic\n",{mode:0o600}
    );
    const state=await StateStore.open(join(root,"state.json"));
    const extraction={
      invoice:{
        invoice_number:"SYNTHETIC-1",issue_date:"2026-07-28",
        buyer_name:"亚信科技（成都）有限公司",
        buyer_tax_id:"91510100732356360H",
        seller_name:"合成测试餐厅",item_name:"餐饮服务",
        total_with_tax:"100.00"
      },
      field_quality:{
        invoice_number:"clear",issue_date:"clear",buyer_name:"clear",
        buyer_tax_id:"clear",seller_name:"clear",item_name:"clear",
        total_with_tax:"clear"
      },
      category:"dining",document_verification:"single_invoice"
    };
    const assistant=new PersonalAssistantClient({
      codex:async context=>{
        assert.equal(context.instructionText,"");
        assert.equal(context.sources[0].mediaClass,"image");
        return {
          type:"tool_call",toolName:"archive_dining_invoice",
          arguments:{items:[{sourceId:"source-001",extraction}]}
        };
      },
      deepseek:async()=>{throw new Error("unexpected");}
    });
    const prepareSource=createAssistantSourcePreparer({
      tempRoot:join(root,"intake"),
      download:async()=>({file:image,tempDir:root}),
      cleanup:async()=>{}
    });
    const sent=[];
    const coordinator=new PersonalAssistantCoordinator({
      prepareSource,assistant,
      invoiceWriter:new InvoiceArchiveWriter({vaultRoot,state}),
      outcomeStore:{
        get:key=>state.getOutcome(key),
        save:(outcome,key)=>state.saveOutcome(key,outcome),
        markReplied:key=>state.markReplied(key)
      },
      messenger:{async send(value){sent.push(structuredClone(value));}},
      personalRules:["清晰且符合归档规则的餐饮发票默认归档。"],
      model:"codex",skillVersion:"4.0.1"
    });
    const outcome=await coordinator.handle(createFeishuIncomingMessage({
      messageId:"invoice-1",senderId:"owner",chatId:"private-chat",
      messageType:"image",content:"[Image: img_synthetic]",
      instructionText:"",createTimeMs:1785196800000
    }));
    assert.equal(outcome.status,"committed");
    assert.equal(outcome.artifacts.length,1);
    assert.equal(
      await readFile(join(vaultRoot,outcome.artifacts[0]),"hex"),
      await readFile(image,"hex")
    );
    assert.equal(sent.length,1);
    assert.equal(state.listInvoiceTransactions().at(-1).status,"published");
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test("same-event instruction plus three originals reaches one create_document job and verified reply file",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v401-document-journey-"));
  try {
    const files=new Map([
      ["wx-doc-a",await createDocx(root,"甲材料：交流目标。","document-a")],
      ["wx-doc-b",await createDocx(root,"乙材料：参与对象。","document-b")],
      ["wx-doc-c",join(root,"document-c.pdf")]
    ]);
    await writeFile(
      files.get("wx-doc-c"),Buffer.from("%PDF-1.7\n丙材料：后续动作。"),
      {mode:0o600}
    );
    const outcomes=new Map(),sent=[];
    let assistantCalls=0,generatorCalls=0;
    const workspace=new FileOutputWorkspace({
      tempRoot:join(root,"document-jobs"),
      outputRoot:join(root,"document-output"),
      maxOutputBytes:20*1024*1024,outputRetentionDays:7
    });
    const coordinator=new PersonalAssistantCoordinator({
      prepareSource:createAssistantSourcePreparer({
        tempRoot:join(root,"intake"),
        download:async({attachment})=>({
          file:files.get(attachment.sourceAttachmentId),tempDir:root
        }),
        cleanup:async()=>{}
      }),
      assistant:new PersonalAssistantClient({
        codex:async context=>{
          assistantCalls+=1;
          assert.equal(context.instructionText,
            "综合这三份材料，生成一份交流方案 Word");
          assert.deepEqual(
            context.sources.map(source=>source.sourceId),
            ["source-001","source-002","source-003"]
          );
          return {
            type:"tool_call",toolName:"create_document",
            arguments:{
              sourceIds:["source-001","source-002","source-003"],
              format:"docx",title:"综合交流方案",
              content:"# 综合交流方案\n\n目标、对象与后续动作。"
            }
          };
        },
        deepseek:async()=>{throw new Error("unexpected");}
      }),
      documentWorkspace:workspace,
      artifactGenerator:async({jobRoot,outputFile,sourceFiles})=>{
        generatorCalls+=1;
        assert.deepEqual(sourceFiles,[
          "sources/source-001.docx",
          "sources/source-002.docx",
          "sources/source-003.pdf"
        ]);
        await copyFile(join(jobRoot,sourceFiles[0]),outputFile);
      },
      outcomeStore:{
        async get(key){return outcomes.get(key)||null;},
        async save(outcome,key){outcomes.set(key,structuredClone(outcome));},
        async markReplied(){}
      },
      messenger:{async send(value){sent.push(structuredClone(value));}},
      personalRules:[],model:"codex",skillVersion:"4.0.1"
    });
    const outcome=await coordinator.handle(createWechatIncomingMessage({
      messageId:"wx-document-1",userId:"owner",conversationId:"owner",
      createTimeMs:1785196800000,type:"files",contextToken:"ctx",
      instructionText:"综合这三份材料，生成一份交流方案 Word",
      attachments:[
        {
          type:"file",sourceAttachmentId:"wx-doc-a",
          displayName:"甲.docx",extension:"docx"
        },
        {
          type:"file",sourceAttachmentId:"wx-doc-b",
          displayName:"乙.docx",extension:"docx"
        },
        {
          type:"file",sourceAttachmentId:"wx-doc-c",
          displayName:"丙.pdf",extension:"pdf"
        }
      ]
    }));
    assert.equal(outcome.status,"committed");
    assert.equal(assistantCalls,1);
    assert.equal(generatorCalls,1);
    assert.equal(outcome.replyFiles.length,1);
    assert.equal(await workspace.verifyPublished(outcome.replyFiles[0]),true);
    assert.equal(sent.length,1);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test("two same-turn dining invoices reach one batch tool and two real archive writes",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v401-invoice-batch-"));
  try {
    const files=new Map([
      ["wx-invoice-a",join(root,"invoice-a.png")],
      ["wx-invoice-b",join(root,"invoice-b.png")]
    ]);
    await writeFile(
      files.get("wx-invoice-a"),
      Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x01]),
      {mode:0o600}
    );
    await writeFile(
      files.get("wx-invoice-b"),
      Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x02]),
      {mode:0o600}
    );
    const vaultRoot=join(root,"vault");
    await mkdir(join(vaultRoot,".obsidian"),{recursive:true,mode:0o700});
    await mkdir(join(vaultRoot,".llw-system"),{recursive:true,mode:0o700});
    await mkdir(
      join(vaultRoot,"亚信工作","日常发票","餐饮发票"),
      {recursive:true,mode:0o700}
    );
    await writeFile(
      join(vaultRoot,".llw-system","SYSTEM_MAP.md"),
      "# synthetic\n",{mode:0o600}
    );
    const state=await StateStore.open(join(root,"state.json"));
    const extraction=invoiceNumber=>({
      invoice:{
        invoice_number:invoiceNumber,issue_date:"2026-07-28",
        buyer_name:"亚信科技（成都）有限公司",
        buyer_tax_id:"91510100732356360H",
        seller_name:"合成测试餐厅",item_name:"餐饮服务",
        total_with_tax:"100.00"
      },
      field_quality:{
        invoice_number:"clear",issue_date:"clear",buyer_name:"clear",
        buyer_tax_id:"clear",seller_name:"clear",item_name:"clear",
        total_with_tax:"clear"
      },
      category:"dining",document_verification:"single_invoice"
    });
    let assistantCalls=0;
    const sent=[];
    const coordinator=new PersonalAssistantCoordinator({
      prepareSource:createAssistantSourcePreparer({
        tempRoot:join(root,"intake"),
        download:async({attachment})=>({
          file:files.get(attachment.sourceAttachmentId),tempDir:root
        }),
        cleanup:async()=>{}
      }),
      assistant:new PersonalAssistantClient({
        codex:async context=>{
          assistantCalls+=1;
          assert.deepEqual(
            context.sources.map(source=>source.sourceId),
            ["source-001","source-002"]
          );
          return {
            type:"tool_call",toolName:"archive_dining_invoice",
            arguments:{items:[
              {sourceId:"source-001",extraction:extraction("SYNTHETIC-A")},
              {sourceId:"source-002",extraction:extraction("SYNTHETIC-B")}
            ]}
          };
        },
        deepseek:async()=>{throw new Error("unexpected");}
      }),
      invoiceWriter:new InvoiceArchiveWriter({vaultRoot,state}),
      outcomeStore:{
        get:key=>state.getOutcome(key),
        save:(outcome,key)=>state.saveOutcome(key,outcome),
        markReplied:key=>state.markReplied(key)
      },
      messenger:{async send(value){sent.push(structuredClone(value));}},
      personalRules:[],model:"codex",skillVersion:"4.0.1"
    });
    const outcome=await coordinator.handle(createWechatIncomingMessage({
      messageId:"wx-invoices-1",userId:"owner",conversationId:"owner",
      createTimeMs:1785196800000,type:"files",contextToken:"ctx",
      instructionText:"归档这两张餐饮发票",
      attachments:[
        {
          type:"image",sourceAttachmentId:"wx-invoice-a",
          displayName:"发票甲.png",extension:"png"
        },
        {
          type:"image",sourceAttachmentId:"wx-invoice-b",
          displayName:"发票乙.png",extension:"png"
        }
      ]
    }));
    assert.equal(outcome.status,"committed");
    assert.equal(assistantCalls,1);
    assert.equal(outcome.artifacts.length,2);
    assert.equal(
      state.listInvoiceTransactions()
        .filter(item=>item.status==="published").length,
      2
    );
    assert.equal(sent.length,1);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test("split same-turn Feishu two-PDF request is coalesced before preparation and reaches one Reply with zero Writers",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v401-pdf-journey-"));
  try {
    const pdf1=join(root,"source-1.pdf");
    const pdf2=join(root,"source-2.pdf");
    await writeFile(pdf1,Buffer.from("%PDF-1.7\nsynthetic one"),{mode:0o600});
    await writeFile(pdf2,Buffer.from("%PDF-1.7\nsynthetic two"),{mode:0o600});
    let writerCalls=0;
    const sent=[],outcomes=new Map();
    const coordinator=new PersonalAssistantCoordinator({
      prepareSource:createAssistantSourcePreparer({
        tempRoot:join(root,"intake"),
        download:async({attachment})=>({
          file:attachment.sourceAttachmentId==="file_pdf_1"?pdf1:pdf2,
          tempDir:root
        }),
        cleanup:async()=>{}
      }),
      assistant:new PersonalAssistantClient({
        codex:async context=>{
          assert.equal(context.instructionText,"总结，不保存");
          assert.deepEqual(
            context.sources.map(source=>source.format),
            ["pdf","pdf"]
          );
          return {type:"reply",text:"这是一份合成 PDF 摘要。"};
        },
        deepseek:async()=>{throw new Error("unexpected");}
      }),
      writer:{async commit(){writerCalls+=1;}},
      dailyWriter:{async commit(){writerCalls+=1;}},
      invoiceWriter:{async archive(){writerCalls+=1;}},
      artifactGenerator:async()=>{writerCalls+=1;},
      outcomeStore:{
        async get(key){return outcomes.get(key)||null;},
        async save(outcome,key){
          outcomes.set(key,structuredClone(outcome));
        },
        async markReplied(){}
      },
      messenger:{async send(value){sent.push(structuredClone(value));}},
      personalRules:["普通附件默认保存"],
      model:"codex",skillVersion:"4.0.1"
    });
    const dispatcher=new PersonalAssistantDispatcher({
      binding:{senderId:"owner",chatId:"private-chat"},
      bindings:{
        feishu:{userId:"owner",conversationId:"private-chat"}
      },
      state:{
        hasOutcome:key=>outcomes.has(key),
        async saveOutcome(key,outcome){
          outcomes.set(key,structuredClone(outcome));
        }
      },
      coordinator,modelMode:{},deepseekEnabled:false,
      messenger:{async send(){}},coalesceWindowMs:25
    });
    await dispatcher.acceptIncomingMessage(createFeishuIncomingMessage({
      messageId:"pdf-read-1",senderId:"owner",chatId:"private-chat",
      messageType:"file",
      content:'<file key="file_pdf_1" name="材料一.pdf"/>',
      createTimeMs:1785196800000
    }));
    await dispatcher.acceptIncomingMessage(createFeishuIncomingMessage({
      messageId:"pdf-read-2",senderId:"owner",chatId:"private-chat",
      messageType:"file",
      content:'<file key="file_pdf_2" name="材料二.pdf"/>',
      createTimeMs:1785196800500
    }));
    await dispatcher.acceptIncomingMessage(createFeishuIncomingMessage({
      messageId:"pdf-text-2",senderId:"owner",chatId:"private-chat",
      messageType:"text",content:"总结，不保存",
      createTimeMs:1785196801000
    }));
    await dispatcher.flushAcceptedMessages();
    const outcome=outcomes.get("feishu:pdf-read-1");
    assert.equal(outcome.status,"committed");
    assert.equal(writerCalls,0);
    assert.deepEqual(outcome.artifacts,[]);
    assert.equal(sent.length,1);
    assert.equal(
      outcomes.get("feishu:pdf-read-2").reasonCode,
      "coalesced_into_turn"
    );
    assert.equal(
      outcomes.get("feishu:pdf-text-2").reasonCode,
      "coalesced_into_turn"
    );
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

async function createDocx(root,text,name="source") {
  const packageRoot=join(root,`${name}-package`);
  const parts={
    "[Content_Types].xml":`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "word/document.xml":`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:sectPr><w:footerReference w:type="default" r:id="rIdFooter"/></w:sectPr></w:body></w:document>`,
    "word/_rels/document.xml.rels":`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>`,
    "word/footer1.xml":`<?xml version="1.0"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>第 1 页</w:t></w:r></w:p></w:ftr>`
  };
  for (const [name,content] of Object.entries(parts)) {
    const target=join(packageRoot,name);
    await mkdir(dirname(target),{recursive:true,mode:0o700});
    await writeFile(target,content,{mode:0o600});
  }
  const output=join(root,`${name}.docx`);
  await run("/usr/bin/zip",["-q","-r",output,"."],{cwd:packageRoot});
  await chmod(output,0o600);
  return output;
}
