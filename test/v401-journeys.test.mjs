import test from "node:test";
import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {chmod,mkdir,mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
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
  const saved=[];
  const sent=[];
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
      async get() { return null; },
      async save(outcome) { order.push("outcome"); saved.push(outcome); }
    },
    messenger:{
      async send(target,reply) { order.push("reply"); sent.push({target,reply}); }
    },
    personalRules:[],
    model:"codex",
    skillVersion:"4.0.1"
  });
  const message=createFeishuIncomingMessage({
    messageId:"m-v401",senderId:"owner",chatId:"private-chat",
    messageType:"text",
    content:"把交流目标、对象和后续动作保存到日常生活/学习资料",
    createTimeMs:1785196800000
  });
  const outcome=await coordinator.handle(message);
  assert.deepEqual(order,["prepare","assistant","writer","outcome","reply"]);
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

test("WeChat waiting_file DOCX travels through real preparation, State, Writer, Outcome and Reply",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v401-wechat-docx-"));
  try {
    const sourceFile=await createDocx(root,"交流方案正文：先确认交流目标。");
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
          sourceIds:["source-001"],
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
            ["source-001"]
          );
          assert.equal("content" in context.sources[0],false);
        }
        return decisions.shift();
      },
      deepseek:async()=>{throw new Error("unexpected");}
    });
    const prepareSource=createAssistantSourcePreparer({
      tempRoot:join(root,"intake"),
      download:async()=>({file:sourceFile,tempDir:root}),
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
      messageId:"wx-file-2",userId:"owner",conversationId:"owner",
      createTimeMs:1785196860000,type:"file",contextToken:"ctx",
      attachment:{
        type:"file",sourceAttachmentId:"wxr_1",
        displayName:"交流方案.docx",extension:"docx"
      }
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
      /llw_schema: "knowledge-item\/v2"[\s\S]*source-001\.docx/u
    );
    assert.ok(state.getOutcome("wechat:wx-file-2"));
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
        assert.equal(context.sourceEvidence.kind,"image");
        return {
          type:"tool_call",toolName:"archive_dining_invoice",
          arguments:{extraction}
        };
      },
      deepseek:async()=>{throw new Error("unexpected");}
    });
    const prepareSource=createAssistantSourcePreparer({
      download:async()=>({file:image,tempDir:root}),
      inspect:async()=>({
        kind:"supported_image",format:"png",extension:"png"
      }),
      preparePdf:async()=>{throw new Error("unexpected");},
      prepareOffice:async()=>{throw new Error("unexpected");},
      prepareTextFile:async()=>{throw new Error("unexpected");},
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

test("split same-turn Feishu PDF request is coalesced before preparation and reaches one Reply with zero Writers",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v401-pdf-journey-"));
  try {
    const pdf=join(root,"source.pdf");
    await writeFile(pdf,Buffer.from("%PDF-1.7\nsynthetic"),{mode:0o600});
    let writerCalls=0;
    const sent=[],outcomes=new Map();
    const coordinator=new PersonalAssistantCoordinator({
      prepareSource:createAssistantSourcePreparer({
        download:async()=>({file:pdf,tempDir:root}),
        inspect:async()=>({kind:"pdf",format:"pdf",extension:"pdf"}),
        preparePdf:async()=>({
          originalFile:pdf,detectedFormat:"pdf",archiveExtension:"pdf",
          pageImages:[join(root,"page-1.png")],
          extractedText:"这是一份合成验收 PDF。",
          documentFacts:{pageCount:1,textAvailable:true}
        }),
        prepareOffice:async()=>{throw new Error("unexpected");},
        prepareTextFile:async()=>{throw new Error("unexpected");},
        cleanup:async()=>{}
      }),
      assistant:new PersonalAssistantClient({
        codex:async context=>{
          assert.equal(context.instructionText,"总结，不保存");
          assert.equal(context.sourceEvidence.kind,"pdf");
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
      content:'<file key="file_synthetic" name="材料.pdf"/>',
      createTimeMs:1785196800000
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
      outcomes.get("feishu:pdf-text-2").reasonCode,
      "coalesced_into_attachment"
    );
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

async function createDocx(root,text) {
  const packageRoot=join(root,"docx-package");
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
  const output=join(root,"source.docx");
  await run("/usr/bin/zip",["-q","-r",output,"."],{cwd:packageRoot});
  await chmod(output,0o600);
  return output;
}
