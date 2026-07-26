import test from "node:test";
import assert from "node:assert/strict";
import {createAssistantWorkCapability} from "../src/capabilities/assistant-work/capability.mjs";

const sessionId="123e4567-e89b-42d3-a456-426614174000";
const grounding=mode=>({
  mode,uses_model_knowledge:mode!=="source_strict",
  contains_inference:mode!=="source_strict",
  needs_current_fact_verification:false
});
const message=(text,receivedAt="2026-07-26T01:00:00.000Z")=>({
  source:"feishu",sourceMessageId:"m1",userId:"u1",conversationId:"c1",
  receivedAt,text,attachments:[],
  replyTarget:{source:"feishu",sourceMessageId:"m1",conversationId:"c1"}
});

function harness({
  decisions,initialSession=null,initialDraft="",allowedOutputFormats=[],
  generateFile=null
}={}){
  let session=initialSession?structuredClone(initialSession):null;
  let draft=initialDraft;
  const calls={
    decide:[],search:[],saveDraft:[],create:[],update:[],close:[],generateFile:[]
  };
  const manager={
    getOpen:()=>session?.status==="open"?structuredClone(session):null,
    create:async input=>{
      calls.create.push(structuredClone(input));
      session={
        version:1,session_id:sessionId,capability:"assistant-work",status:"open",
        model:input.model,grounding_mode:input.groundingMode,goal:input.goal,
        task_summary:"",confirmed_requirements:[],rejected_directions:[],
        source_paths:[...input.sourcePaths],current_draft_version:0,recent_turns:[],
        started_at:input.startedAt,updated_at:input.startedAt
      };
      return structuredClone(session);
    },
    update:async input=>{
      calls.update.push(structuredClone(input));
      session={...session,source_paths:[...input.sourcePaths],
        current_draft_version:input.draftVersion,updated_at:input.updatedAt};
      return structuredClone(session);
    },
    close:async(status,updatedAt)=>{
      calls.close.push([status,updatedAt]);
      session={...session,status,updated_at:updatedAt};
    }
  };
  const workspace={
    load:async()=>({
      currentDraftVersion:session.current_draft_version,currentDraft:draft,
      sourcePaths:[...session.source_paths],startedAt:session.started_at,
      updatedAt:session.updated_at
    }),
    saveDraft:async input=>{
      calls.saveDraft.push(structuredClone(input));
      draft=input.text;
      return {version:input.baseVersion+1};
    }
  };
  const queue=[...(decisions||[])];
  const capability=createAssistantWorkCapability({
    decide:async input=>{calls.decide.push(structuredClone(input));return queue.shift();},
    search:async input=>{
      calls.search.push(structuredClone(input));
      return input.sourcePaths?.length
        ?input.sourcePaths.map(path=>({path,excerpt:"# 合成资料\n需要书面确认。",score:3}))
        :[{path:"工作资料/合成项目/验收.md",excerpt:"# 合成资料\n需要书面确认。",score:5}];
    },
    workspace,sessionManager:manager,allowedOutputFormats,
    generateFile:generateFile?async input=>{
      calls.generateFile.push(structuredClone(input));
      return generateFile(input);
    }:null
  });
  return {capability,calls,get session(){return session;},get draft(){return draft;}};
}

test("creates a source-strict session and one versioned first draft from verified sources",async()=>{
  const h=harness({decisions:[{
    action:"create_draft",reason_code:"ready",question:"",
    reply:"合成方案第一版。",source_paths:["工作资料/合成项目/验收.md"],
    grounding_report:grounding("source_strict"),output:null
  }]});
  const result=await h.capability.handle(message("根据合成项目资料起草一份方案"),{
    model:"codex"
  });
  assert.equal(result.status,"committed");
  assert.equal(result.reply,"合成方案第一版。");
  assert.equal(h.calls.create[0].groundingMode,"source_strict");
  assert.equal(h.calls.saveDraft[0].baseVersion,0);
  assert.equal(h.calls.update[0].draftVersion,1);
  assert.deepEqual(result.artifacts,[`task-session/${sessionId}/draft-v1.md`]);
});

test("continues with the session-fixed model and loads the current draft",async()=>{
  const existing={
    version:1,session_id:sessionId,capability:"assistant-work",status:"open",
    model:"codex",grounding_mode:"hybrid",goal:"写合成文章",task_summary:"",
    confirmed_requirements:[],rejected_directions:[],source_paths:[],
    current_draft_version:1,recent_turns:[],
    started_at:"2026-07-26T01:00:00.000Z",updated_at:"2026-07-26T01:01:00.000Z"
  };
  const h=harness({initialSession:existing,initialDraft:"第一段。\n\n第二段。",decisions:[{
    action:"revise_draft",reason_code:"ready",question:"",
    reply:"第一段。\n\n更自然的第二段。",source_paths:[],
    grounding_report:grounding("hybrid"),output:null
  }]});
  await h.capability.handle(message("第二段再自然一点","2026-07-26T01:02:00.000Z"),{
    model:"deepseek"
  });
  assert.equal(h.calls.decide[0].model,"codex");
  assert.equal(h.calls.decide[0].currentDraft.text,"第一段。\n\n第二段。");
  assert.equal(h.calls.saveDraft[0].baseVersion,1);
});

test("asks once without writing a draft and closes explicit completion",async()=>{
  const clarification=harness({decisions:[{
    action:"ask_user",reason_code:"clarification_required",question:"面向哪类读者？",
    reply:"",source_paths:[],grounding_report:grounding("hybrid"),output:null
  }]});
  const asked=await clarification.capability.handle(message("写一篇文章"),{model:"codex"});
  assert.deepEqual(asked,{status:"awaiting_clarification",reply:"面向哪类读者？",artifacts:[]});
  assert.equal(clarification.calls.saveDraft.length,0);

  const complete=harness({initialSession:clarification.session,decisions:[{
    action:"complete",reason_code:"task_completed",question:"",
    reply:"当前任务已完成。",source_paths:[],
    grounding_report:grounding("hybrid"),output:null
  }]});
  const done=await complete.capability.handle(
    message("完成当前任务","2026-07-26T01:03:00.000Z"),{model:"codex"}
  );
  assert.equal(done.status,"committed");
  assert.deepEqual(complete.calls.close,[["completed","2026-07-26T01:03:00.000Z"]]);
});

test("does not auto-switch a new DeepSeek task or call AI",async()=>{
  const h=harness({decisions:[]});
  const result=await h.capability.handle(message("起草一份合成方案"),{model:"deepseek"});
  assert.equal(result.status,"rejected");
  assert.match(result.reply,/仅支持 Codex/);
  assert.equal(h.calls.decide.length,0);
  assert.equal(h.calls.create.length,0);
});

test("generates one verified DOCX from the current draft without a second decision call",async()=>{
  const existing={
    version:1,session_id:sessionId,capability:"assistant-work",status:"open",
    model:"codex",grounding_mode:"hybrid",goal:"写交流方案",task_summary:"",
    confirmed_requirements:[],rejected_directions:[],source_paths:[],
    current_draft_version:2,recent_turns:[],
    started_at:"2026-07-26T01:00:00.000Z",updated_at:"2026-07-26T01:01:00.000Z"
  };
  const h=harness({
    initialSession:existing,initialDraft:"# 交流方案\n\n已定稿正文。",
    allowedOutputFormats:["docx","pptx","xlsx"],
    generateFile:async()=>({
      kind:"docx",path:"/private/output/session/output.docx",
      displayName:"工作稿-v2.docx",
      mime:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sha256:"a".repeat(64),size:2048
    })
  });
  const result=await h.capability.handle(
    message("把当前稿导出成 Word 文档"),{model:"codex"}
  );
  assert.equal(h.calls.generateFile.length,1);
  assert.equal(h.calls.generateFile[0].draftText,"# 交流方案\n\n已定稿正文。");
  assert.equal(h.calls.decide.length,0);
  assert.equal(result.status,"committed");
  assert.deepEqual(result.replyFiles,[{
    kind:"docx",path:"/private/output/session/output.docx",
    displayName:"工作稿-v2.docx",
    mime:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    sha256:"a".repeat(64),size:2048,
    idempotencyKey:`assistant-file:feishu:m1:${"a".repeat(16)}`
  }]);
});

test("does not generate before a draft exists or for the unsupported WeChat file entry",async()=>{
  const noDraft=harness({
    allowedOutputFormats:["docx"],generateFile:async()=>{throw new Error("no");}
  });
  const asked=await noDraft.capability.handle(
    message("导出成Word文档"),{model:"codex"}
  );
  assert.equal(asked.status,"awaiting_clarification");
  assert.equal(noDraft.calls.generateFile.length,0);
  assert.equal(noDraft.calls.decide.length,0);

  const existing={
    version:1,session_id:sessionId,capability:"assistant-work",status:"open",
    model:"codex",grounding_mode:"hybrid",goal:"写方案",task_summary:"",
    confirmed_requirements:[],rejected_directions:[],source_paths:[],
    current_draft_version:1,recent_turns:[],
    started_at:"2026-07-26T01:00:00.000Z",updated_at:"2026-07-26T01:01:00.000Z"
  };
  const wechat=harness({
    initialSession:existing,initialDraft:"正文",allowedOutputFormats:["docx"],
    generateFile:async()=>{throw new Error("no");}
  });
  const wxMessage={
    ...message("导出成Word文档"),source:"wechat",sourceMessageId:"1001",
    replyTarget:{source:"wechat",sourceMessageId:"1001",conversationId:"wx-owner"}
  };
  const rejected=await wechat.capability.handle(wxMessage,{model:"codex"});
  assert.equal(rejected.status,"rejected");
  assert.match(rejected.reply,/微信.*暂不支持/u);
  assert.equal(wechat.calls.generateFile.length,0);
});
