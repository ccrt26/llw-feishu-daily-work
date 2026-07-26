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
  action:"commit",confidence:"high",reason_code:"ready",question:"",
  library_key:"work-knowledge",
  folder_plan:{
    mode:"use_existing",segments:["亚信工作","工作文档","交流方案"],
    origin:"skill_suggested"
  },
  title:"客户交流方案",summary:"一份经过来源约束的交流方案。",tags:["交流"],
  note_file:"knowledge.md",source_integrity:"complete",preserve_source:true
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
  let pending=null;
  const calls=[];
  return {
    calls,
    get pending() { return pending; },
    state:{
      async setKnowledgePending(value) { calls.push(["set",structuredClone(value)]); pending=structuredClone(value); },
      async clearKnowledgePending() { calls.push(["clear"]); pending=null; },
      async getKnowledgePending() { return pending; }
    }
  };
}

function harness({decision=baseDecision,decideError,writerResult}={}) {
  const calls={catalog:0,prepare:[],decide:[],commit:[],create:[]};
  const state=stateHarness();
  const writer={
    async commit(input) {
      calls.commit.push(structuredClone(input));
      return writerResult||{
        status:"created",knowledgeId:"k".repeat(64),libraryKey:"work-knowledge",
        relativePath:"工作资料/亚信工作/工作文档/交流方案/客户交流方案",
        files:["工作资料/亚信工作/工作文档/交流方案/客户交流方案/knowledge.md"]
      };
    },
    async createFolder(input) {
      calls.create.push(structuredClone(input));
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
    async catalog() { calls.catalog+=1; return structuredClone(libraries); },
    sourcePreparer(input) { calls.prepare.push(structuredClone(input)); return prepared(input.text); },
    skillVersion:"1.2.0"
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
    source:{...prepared(input.text),content:input.text},
    skillVersion:"1.2.0",preserveSource:true
  });
  assert.deepEqual(h.state.calls,[["clear"]]);
});

test("creates one explicit empty folder or reports its existing idempotent result",async()=>{
  const createDecision={
    ...baseDecision,action:"create_folder",reason_code:"folder_ready",
    folder_plan:{
      mode:"create_if_missing",segments:["亚信工作","工作文档","交流方案"],
      origin:"user_explicit"
    },
    title:"",summary:"",tags:[],note_file:"",preserve_source:false
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
    ...baseDecision,action:"ask_user",reason_code:"folder_confirmation_required",
    question:"是否确认按这个规则创建？",
    folder_plan:{
      mode:"create_if_missing",segments:["亚信工作","工作文档","新交流方案"],
      origin:"skill_suggested"
    },
    title:"",summary:"",tags:[],note_file:""
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
    ...baseDecision,action:"ask_user",reason_code:"source_incomplete",
    question:"请发送一份文件。",
    library_key:"",
    folder_plan:{mode:"use_existing",segments:[],origin:"user_explicit"},
    title:"",summary:"",tags:[],note_file:"",source_integrity:"partial"
  };
  const h=harness({decision});
  const input=message("把我接下来发送的一份文件保存到工作资料");
  const result=await h.capability.handle(input,{state:h.state.state,model:"codex"});
  assert.deepEqual(result,{
    status:"awaiting_clarification",
    reply:"已记住本次入库要求，请在 24 小时内发送一份 TXT 或 Markdown 文件。\n文件到达前不会创建目录或写入知识库。",
    artifacts:[]
  });
  assert.deepEqual(h.state.pending,{
    request:input.text,startedAt:input.receivedAt,model:"codex"
  });
  assert.deepEqual(Object.keys(h.state.pending),["request","startedAt","model"]);
  assert.equal(h.calls.commit.length+h.calls.create.length,0);
});

test("uses fixed reject and technical-failure receipts and clears only terminal safe results",async()=>{
  const rejected=harness({decision:{
    ...baseDecision,action:"reject",confidence:"high",
    reason_code:"existing_change_forbidden",library_key:"",
    folder_plan:{mode:"use_existing",segments:[],origin:"user_explicit"},
    title:"",summary:"",tags:[],note_file:""
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
  assert.deepEqual(rejected.state.calls,[["clear"]]);

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
    folder_plan:{...baseDecision.folder_plan,segments:["伪造目录"]}
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
