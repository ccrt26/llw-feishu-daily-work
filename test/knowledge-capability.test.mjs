import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {createKnowledgeIngestCapability} from "../src/capabilities/knowledge-ingest/capability.mjs";

const libraries=[
  {
    libraryKey:"work-knowledge",displayName:"工作资料",
    aliases:["工作文档"],existingFolders:[["亚信工作","工作文档","交流方案"]]
  },
  {
    libraryKey:"personal-knowledge",displayName:"生活资料",
    aliases:["日常生活"],existingFolders:[]
  }
];

const baseDecision={
  action:"commit",reasonCode:"ready",question:"",
  libraryKey:"work-knowledge",
  target:{
    scope:"existing_folder",segments:["亚信工作","工作文档","交流方案"],
    origin:"skill_suggested"
  },
  title:"客户交流方案",summary:"一份经过来源约束的交流方案。",tags:["交流"],
  knowledgeSections:{
    keyFacts:["客户需要交流方案。"],
    structureAndMainContent:"资料说明了客户交流方案。",
    reusableContent:["交流前确认目标。"],
    sourceNotes:"根据完整来源整理。",
    contentIndex:"正文"
  },
  sourceIntegrity:"complete"
};

function prepared(text) {
  return {
    version:1,sourceKind:"text",detectedFormat:"text",displayName:"message.txt",
    sizeBytes:Buffer.byteLength(text),
    sha256:createHash("sha256").update(text).digest("hex"),
    jobSourceName:"source.txt",safeSourceReference:""
  };
}

function message(text="请把这段客户交流方案保存到工作资料") {
  return {
    source:"feishu",sourceMessageId:"m1",userId:"bound-user",
    conversationId:"bound-chat",receivedAt:"2026-07-26T06:00:00.000Z",
    text,attachments:[],
    replyTarget:{source:"feishu",sourceMessageId:"m1",conversationId:"bound-chat"}
  };
}

function stateHarness() {
  const pendingBySource={feishu:null,wechat:null};
  const calls=[];
  return {
    calls,
    get pending() { return pendingBySource.feishu; },
    state:{
      async setKnowledgePending(value) {
        calls.push(["set",structuredClone(value)]);
        pendingBySource[value.source]=structuredClone(value);
      },
      async clearKnowledgePending(source) {
        calls.push(["clear",source]); pendingBySource[source]=null;
      },
      async getKnowledgePending(source) { return pendingBySource[source]; }
    }
  };
}

function pendingTarget(source="feishu") {
  return {
    source,startedAt:"2026-07-26T05:00:00.000Z",model:"codex",
    libraryKey:"work-knowledge",
    target:{scope:"library_root",segments:[],origin:"user_explicit"}
  };
}

function harness({
  decision=baseDecision,decideError,writerResult,download,filePreparer,cleanup,
  documentExporter,catalogError,prepareError,writerError,onFailureStage
}={}) {
  const calls={
    catalog:0,prepare:[],decide:[],commit:[],create:[],download:[],filePrepare:[],
    documentExport:[],cleanup:[],failure:[]
  };
  const state=stateHarness();
  const writer={
    async commit(input) {
      calls.commit.push(structuredClone(input));
      if (writerError) throw writerError;
      return writerResult||{
        status:"created",knowledgeId:"k".repeat(64),libraryKey:"work-knowledge",
        relativePath:"工作资料/亚信工作/工作文档/交流方案/客户交流方案",
        files:["工作资料/亚信工作/工作文档/交流方案/客户交流方案/knowledge.md"]
      };
    },
    async createFolder(input) {
      calls.create.push(structuredClone(input));
      if (writerError) throw writerError;
      return writerResult||{
        status:"created",libraryKey:"work-knowledge",
        relativePath:"工作资料/亚信工作/工作文档/交流方案"
      };
    }
  };
  const capability=createKnowledgeIngestCapability({
    async decide(input) {
      calls.decide.push(structuredClone(input));
      if (decideError) throw decideError;
      return structuredClone(decision);
    },
    writer,
    async catalog() {
      calls.catalog+=1;
      if (catalogError) throw catalogError;
      return structuredClone(libraries);
    },
    sourcePreparer(input) {
      calls.prepare.push(structuredClone(input));
      if (prepareError) throw prepareError;
      return prepared(input.text);
    },
    async download(input) {
      calls.download.push(structuredClone(input));
      return download?download(input):{tempDir:"/tmp/synthetic-job",file:"/tmp/synthetic-job/attachment.txt"};
    },
    async filePreparer(input) {
      calls.filePrepare.push(structuredClone(input));
      if (filePreparer) return filePreparer(input);
      return {...prepared("synthetic file"),sourceKind:"file",detectedFormat:"txt",
        displayName:input.displayName,content:"synthetic file"};
    },
    async documentExporter(input) {
      calls.documentExport.push(structuredClone(input));
      if (documentExporter) return documentExporter(input);
      throw new Error("unexpected_document_export");
    },
    async cleanup(tempDir) {
      calls.cleanup.push(tempDir);
      if (cleanup) await cleanup(tempDir);
    },
    onFailureStage(details) {
      calls.failure.push(structuredClone(details));
      onFailureStage?.(details);
    },
    skillVersion:"1.3.0"
  });
  return {capability,calls,state};
}

test("commits one direct text source with AI-safe catalog context and fixed receipt",async()=>{
  const h=harness();
  const input=message();
  const result=await h.capability.handle(input,{state:h.state.state,model:"codex"});
  assert.deepEqual(result,{
    status:"committed",
    reply:"知识资料已入库。\n标题：客户交流方案\n资料库：工作资料\n位置：工作资料/亚信工作/工作文档/交流方案/客户交流方案",
    artifacts:["工作资料/亚信工作/工作文档/交流方案/客户交流方案/knowledge.md"]
  });
  assert.equal(h.calls.decide.length,1);
  assert.deepEqual(h.calls.decide[0],{
    model:"codex",request:input.text,source:prepared(input.text),sourceContent:input.text,
    allowedLibraries:libraries,taskSummary:null
  });
  const serialized=JSON.stringify(h.calls.decide[0]);
  for (const forbidden of ["bound-user","bound-chat","sourceMessageId","replyTarget","/Volumes/"]) {
    assert.equal(serialized.includes(forbidden),false);
  }
  assert.deepEqual(h.calls.commit[0],{
    libraryKey:"work-knowledge",
    folderSegments:["亚信工作","工作文档","交流方案"],
    title:"客户交流方案",summary:"一份经过来源约束的交流方案。",tags:["交流"],
    knowledgeSections:baseDecision.knowledgeSections,
    source:{...prepared(input.text),content:input.text},
    skillVersion:"1.3.0"
  });
  assert.deepEqual(h.state.calls,[["clear","feishu"]]);
});

test("reuses one bounded pending request for one TXT or Markdown download and cleans once",async()=>{
  for (const extension of ["txt","md"]) {
    const content=extension==="txt"?"TXT 内容。":"# Markdown 内容\n";
    const displayName=`source.${extension}`;
    const fileSource={
      ...prepared(content),sourceKind:"file",detectedFormat:extension,
      displayName,jobSourceName:`source.${extension}`,content
    };
    const h=harness({
      download:async()=>({
        tempDir:`/tmp/synthetic-${extension}`,file:`/tmp/synthetic-${extension}/attachment.${extension}`
      }),
      filePreparer:async()=>fileSource
    });
    await h.state.state.setKnowledgePending(pendingTarget());
    h.state.calls.length=0;
    const attachmentMessage={
      ...message(),text:undefined,
      attachments:[{
        type:"file",sourceAttachmentId:`file_${extension}`,
        displayName,extension
      }]
    };
    const result=await h.capability.handle(attachmentMessage,{
      state:h.state.state,model:"codex"
    });
    assert.equal(result.status,"committed");
    assert.equal(h.calls.download.length,1);
    const downloadContext=JSON.stringify(h.calls.download[0]);
    for (const forbidden of ["bound-user","bound-chat","replyTarget","contextToken"]) {
      assert.equal(downloadContext.includes(forbidden),false);
    }
    assert.deepEqual(h.calls.filePrepare,[{
      file:`/tmp/synthetic-${extension}/attachment.${extension}`,
      displayName,extension
    }]);
    assert.deepEqual(h.calls.decide[0],{
      model:"codex",request:"将当前附件导入已确认的知识库目标。",
      source:Object.fromEntries(Object.entries(fileSource).filter(([key])=>key!=="content")),
      sourceContent:content,allowedLibraries:libraries,taskSummary:null,
      confirmedTarget:{
        libraryKey:"work-knowledge",
        target:{scope:"library_root",segments:[],origin:"user_explicit"}
      }
    });
    assert.equal(h.calls.commit.length,1);
    assert.equal(h.calls.commit[0].source.content,content);
    assert.deepEqual(h.calls.cleanup,[`/tmp/synthetic-${extension}`]);
    assert.deepEqual(h.state.calls,[["clear","feishu"]]);
    assert.equal(h.state.pending,null);
  }
});

test("prepares each Office attachment once and keeps binary bytes out of the AI decision",async()=>{
  for (const extension of ["docx","pptx","xlsx"]) {
    const content=`# ${extension.toUpperCase()} 提取内容\n\n合成资料。`;
    const sourceBytes=Buffer.from([0x50,0x4b,0x03,0x04,extension.length,0xff]);
    const displayName=`source.${extension}`;
    const fileSource={
      version:1,sourceKind:"file",detectedFormat:extension,displayName,
      sizeBytes:sourceBytes.length,
      sha256:createHash("sha256").update(sourceBytes).digest("hex"),
      jobSourceName:`source.${extension}`,safeSourceReference:"",
      content,sourceBytes
    };
    const h=harness({
      download:async()=>({
        tempDir:`/tmp/synthetic-${extension}`,
        file:`/tmp/synthetic-${extension}/attachment.${extension}`
      }),
      filePreparer:async()=>fileSource
    });
    await h.state.state.setKnowledgePending(pendingTarget());
    h.state.calls.length=0;
    const result=await h.capability.handle({
      ...message(),text:undefined,attachments:[{
        type:"file",sourceAttachmentId:`file_${extension}`,
        displayName,extension
      }]
    },{state:h.state.state,model:"codex"});
    assert.equal(result.status,"committed");
    assert.equal(h.calls.download.length,1);
    assert.equal(h.calls.filePrepare.length,1);
    assert.equal(h.calls.decide.length,1);
    assert.deepEqual(h.calls.decide[0].source,{
      version:1,sourceKind:"file",detectedFormat:extension,displayName,
      sizeBytes:sourceBytes.length,sha256:fileSource.sha256,
      jobSourceName:`source.${extension}`,safeSourceReference:""
    });
    assert.equal(JSON.stringify(h.calls.decide[0]).includes("sourceBytes"),false);
    assert.equal(Buffer.compare(h.calls.commit[0].source.sourceBytes,sourceBytes),0);
    assert.deepEqual(h.calls.cleanup,[`/tmp/synthetic-${extension}`]);
  }
});

test("exports one explicit Feishu document link once and records only a hashed source reference",async()=>{
  const sourceBytes=Buffer.from([0x50,0x4b,0x03,0x04,0x01]);
  const content="# Word 文档\n\n飞书快照正文";
  const h=harness({
    documentExporter:async()=>({
      tempDir:"/tmp/synthetic-feishu-snapshot",
      file:"/tmp/synthetic-feishu-snapshot/snapshot.docx",
      extension:"docx",displayName:"交流方案.docx",
      safeSourceReference:`feishu:${"a".repeat(64)}`
    }),
    filePreparer:async input=>({
      version:1,sourceKind:"file",detectedFormat:"docx",
      displayName:input.displayName,sizeBytes:sourceBytes.length,
      sha256:createHash("sha256").update(sourceBytes).digest("hex"),
      jobSourceName:"source.docx",safeSourceReference:"",
      content,sourceBytes
    })
  });
  const request="把这个飞书文档导入工作资料：https://example.feishu.cn/docx/token_abc";
  const result=await h.capability.handle(message(request),{
    state:h.state.state,model:"codex"
  });
  assert.equal(result.status,"committed");
  assert.deepEqual(h.calls.documentExport,[{
    url:"https://example.feishu.cn/docx/token_abc"
  }]);
  assert.equal(h.calls.prepare.length,0);
  assert.equal(h.calls.filePrepare.length,1);
  assert.equal(h.calls.decide[0].source.sourceKind,"feishu_document");
  assert.equal(
    h.calls.decide[0].source.safeSourceReference,
    `feishu:${"a".repeat(64)}`
  );
  assert.equal(JSON.stringify(h.calls.decide[0]).includes("token_abc"),false);
  assert.equal(JSON.stringify(h.calls.decide[0]).includes("sourceBytes"),false);
  assert.equal(h.calls.commit[0].source.sourceKind,"feishu_document");
  assert.deepEqual(h.calls.cleanup,["/tmp/synthetic-feishu-snapshot"]);
});

test("does not download unsupported or unrequested attachments and always cleans failed prepared jobs",async()=>{
  const noPending=harness();
  const txt={...message(),text:undefined,attachments:[{
    type:"file",sourceAttachmentId:"file_txt",displayName:"note.txt",extension:"txt"
  }]};
  assert.equal((await noPending.capability.handle(txt,{
    state:noPending.state.state,model:"codex"
  })).status,"rejected");
  assert.equal(noPending.calls.download.length,0);

  const unsupported=harness();
  await unsupported.state.state.setKnowledgePending(pendingTarget());
  const pdf={...txt,attachments:[{...txt.attachments[0],displayName:"note.pdf",extension:"pdf"}]};
  assert.equal((await unsupported.capability.handle(pdf,{
    state:unsupported.state.state,model:"codex"
  })).status,"rejected");
  assert.equal(unsupported.calls.download.length,0);

  const failed=harness({filePreparer:async()=>{throw new Error("private file failure");}});
  await failed.state.state.setKnowledgePending(pendingTarget());
  failed.state.calls.length=0;
  assert.equal((await failed.capability.handle(txt,{
    state:failed.state.state,model:"codex"
  })).status,"failed");
  assert.deepEqual(failed.calls.cleanup,["/tmp/synthetic-job"]);
  assert.notEqual(failed.state.pending,null);
  assert.deepEqual(failed.state.calls,[]);
});

test("creates one explicit empty folder or reports its existing idempotent result",async()=>{
  const createDecision={
    ...baseDecision,action:"create_folder",reasonCode:"folder_ready",
    target:{
      scope:"new_folder",segments:["亚信工作","工作文档","交流方案"],
      origin:"user_explicit"
    },
    title:"",summary:"",tags:[],knowledgeSections:null
  };
  const created=harness({decision:createDecision});
  assert.deepEqual(
    await created.capability.handle(message("在工作资料创建亚信工作/工作文档/交流方案空目录"),{
      state:created.state.state,model:"codex"
    }),
    {
      status:"committed",
      reply:"目录已创建。\n资料库：工作资料\n位置：工作资料/亚信工作/工作文档/交流方案\n规则：仅创建空目录，不移动、重命名、覆盖或删除已有内容。",
      artifacts:["工作资料/亚信工作/工作文档/交流方案"]
    }
  );
  assert.deepEqual(created.calls.create,[{
    libraryKey:"work-knowledge",segments:["亚信工作","工作文档","交流方案"]
  }]);

  const existing=harness({
    decision:createDecision,
    writerResult:{
      status:"existing",libraryKey:"work-knowledge",
      relativePath:"工作资料/亚信工作/工作文档/交流方案"
    }
  });
  assert.equal((await existing.capability.handle(message(),{
    state:existing.state.state,model:"codex"
  })).status,"existing");
});

test("asks once before a Skill-suggested new folder and performs zero writes",async()=>{
  const decision={
    ...baseDecision,action:"ask_user",reasonCode:"folder_confirmation_required",
    question:"是否确认按这个规则创建？",
    target:{
      scope:"new_folder",segments:["亚信工作","工作文档","新交流方案"],
      origin:"skill_suggested"
    },
    title:"",summary:"",tags:[],knowledgeSections:null
  };
  const h=harness({decision});
  const result=await h.capability.handle(message(),{state:h.state.state,model:"codex"});
  assert.deepEqual(result,{
    status:"awaiting_clarification",
    reply:"需要确认后才能创建新目录。\n资料库：工作资料\n拟创建目录：亚信工作/工作文档/新交流方案\n规则：仅在该受管资料库下创建空目录；不移动、重命名、覆盖或删除已有内容。\n问题：是否确认按以上规则创建？",
    artifacts:[]
  });
  assert.equal(h.calls.commit.length+h.calls.create.length,0);
});

test("stores a bounded 24-hour next-file intent without paths or attachment data",async()=>{
  const decision={
    ...baseDecision,action:"await_file",reasonCode:"source_incomplete",
    question:"",libraryKey:"work-knowledge",
    target:{
      scope:"library_root",segments:[],origin:"user_explicit"
    },
    title:"",summary:"",tags:[],knowledgeSections:null,
    sourceIntegrity:"partial"
  };
  const h=harness({decision});
  const input=message("把我接下来发送的一份文件保存到工作资料");
  const result=await h.capability.handle(input,{state:h.state.state,model:"codex"});
  assert.deepEqual(result,{
    status:"awaiting_attachment",
    reply:"已记住本次入库要求，请在 24 小时内发送一份 TXT、Markdown、DOCX、PPTX 或 XLSX 文件。\n文件到达前不会创建目录或写入知识库。",
    artifacts:[]
  });
  assert.deepEqual(h.state.pending,{
    source:"feishu",startedAt:input.receivedAt,model:"codex",
    libraryKey:"work-knowledge",
    target:{scope:"library_root",segments:[],origin:"user_explicit"}
  });
  assert.deepEqual(Object.keys(h.state.pending),[
    "source","startedAt","model","libraryKey","target"
  ]);
  assert.equal(h.calls.commit.length+h.calls.create.length,0);
});

test("uses fixed reject and technical-failure receipts and clears only terminal safe results",async()=>{
  const rejected=harness({decision:{
    ...baseDecision,action:"reject",
    reasonCode:"existing_change_forbidden",libraryKey:"",target:null,
    title:"",summary:"",tags:[],knowledgeSections:null
  }});
  assert.deepEqual(
    await rejected.capability.handle(message("覆盖原来的知识"),{
      state:rejected.state.state,model:"codex"
    }),
    {
      status:"rejected",
      reply:"本次未写入：知识入库能力不修改、覆盖、合并或删除已有资料。",
      artifacts:[]
    }
  );
  assert.deepEqual(rejected.state.calls,[["clear","feishu"]]);

  const failed=harness({decideError:new Error("private absolute /secret/path")});
  const result=await failed.capability.handle(message(),{
    state:failed.state.state,model:"codex"
  });
  assert.deepEqual(result,{
    status:"failed",
    reply:"知识资料处理失败，本次未写入或创建目录；请稍后重试。",
    artifacts:[]
  });
  assert.equal(result.reply.includes("/secret/path"),false);
  assert.deepEqual(failed.state.calls,[]);
});

test("reports exactly one bounded stage while preserving the fixed failure receipt",async()=>{
  const secret="private body /Users/owner/secret model output";
  const scenarios=[
    {
      name:"source",
      options:{prepareError:new Error(secret)},
      expected:"knowledge_source_prepare_failed"
    },
    {
      name:"catalog",
      options:{catalogError:new Error(secret)},
      expected:"knowledge_library_catalog_failed"
    },
    {
      name:"decision",
      options:{decideError:new Error(secret)},
      expected:"knowledge_decision_failed"
    },
    {
      name:"validation",
      options:{decision:{
        ...baseDecision,
        target:{...baseDecision.target,segments:["fabricated"]}
      }},
      expected:"knowledge_decision_validation_failed"
    },
    {
      name:"writer",
      options:{writerError:new Error(secret)},
      expected:"knowledge_writer_failed"
    },
    {
      name:"receipt",
      options:{writerResult:{
        status:"created",knowledgeId:"k".repeat(64),libraryKey:"work-knowledge",
        relativePath:"/private/secret",files:["/private/secret/knowledge.md"]
      }},
      expected:"knowledge_receipt_failed"
    }
  ];
  const fixed={
    status:"failed",
    reply:"知识资料处理失败，本次未写入或创建目录；请稍后重试。",
    artifacts:[]
  };
  for (const scenario of scenarios) {
    const h=harness(scenario.options);
    const result=await h.capability.handle(message(),{
      state:h.state.state,model:"codex"
    });
    assert.deepEqual(result,fixed,scenario.name);
    assert.deepEqual(h.calls.failure,[{code:scenario.expected}],scenario.name);
    assert.equal(JSON.stringify(h.calls.failure).includes(secret),false,scenario.name);
  }
});

test("preserves only allowlisted decision metrics in one failure diagnostic",async()=>{
  const secret="private body /Users/owner/secret model output";
  const error=Object.assign(new Error(secret),{
    code:"knowledge_decision_process_failed",
    stderrBytes:317,
    retryCount:1,
    path:"/Users/owner/secret",
    output:secret
  });
  const h=harness({decideError:error});
  const result=await h.capability.handle(message(),{
    state:h.state.state,model:"codex"
  });
  assert.equal(result.status,"failed");
  assert.deepEqual(h.calls.failure,[{
    code:"knowledge_decision_process_failed",
    stderrBytes:317,
    retryCount:1
  }]);
  assert.equal(JSON.stringify(h.calls.failure).includes(secret),false);
});

test("enforces Codex-only and rejects unsafe model output with zero writer calls",async()=>{
  const deepseek=harness();
  assert.deepEqual(
    await deepseek.capability.handle(message(),{
      state:deepseek.state.state,model:"deepseek"
    }),
    {
      status:"rejected",
      reply:"知识资料入库当前仅支持 Codex。本次未调用模型、未创建目录、未写入知识库；请切换到 Codex 后重试。",
      artifacts:[]
    }
  );
  assert.equal(deepseek.calls.catalog+deepseek.calls.decide.length,0);

  const unsafe=harness({decision:{
    ...baseDecision,
    target:{...baseDecision.target,segments:["伪造目录"]}
  }});
  assert.deepEqual(
    await unsafe.capability.handle(message(),{
      state:unsafe.state.state,model:"codex"
    }),
    {
      status:"failed",
      reply:"知识资料处理失败，本次未写入或创建目录；请稍后重试。",
      artifacts:[]
    }
  );
  assert.equal(unsafe.calls.commit.length+unsafe.calls.create.length,0);

  const unsafeReceipt=harness({writerResult:{
    status:"created",knowledgeId:"k".repeat(64),libraryKey:"work-knowledge",
    relativePath:"/Volumes/private/secret",files:["/Volumes/private/secret/knowledge.md"]
  }});
  const result=await unsafeReceipt.capability.handle(message(),{
    state:unsafeReceipt.state.state,model:"codex"
  });
  assert.equal(result.status,"failed");
  assert.equal(result.reply.includes("/Volumes/private/secret"),false);
});
