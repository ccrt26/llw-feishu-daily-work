import test from "node:test";
import assert from "node:assert/strict";
import {
  appendTaskInput,
  classifyTaskControl,
  createTaskSession,
  pauseTaskSession,
  publicTaskContext,
  resolveTaskStage,
  resumeTaskSession,
  validateTaskSession,
  validateTaskUpdate
} from "../src/personal-assistant/task-session.mjs";

const TASK_ID="A".repeat(43);
const NOW="2026-07-29T01:00:00.000Z";
const LATER="2026-07-29T01:01:00.000Z";

function feishuText({
  id="message-1",
  text="先帮我看看这个项目",
  receivedAt=NOW
}={}) {
  return {
    source:"feishu",
    sourceMessageId:id,
    userId:"bound-user",
    conversationId:"bound-conversation",
    receivedAt,
    instructionText:text,
    attachments:[],
    replyTarget:{
      source:"feishu",
      sourceMessageId:id,
      conversationId:"bound-conversation"
    }
  };
}

test("creates one active channel task and increments every accepted input revision",()=>{
  const first=createTaskSession({
    message:feishuText(),
    model:"codex",
    taskId:TASK_ID,
    now:NOW
  });
  const second=appendTaskInput({
    session:first,
    message:feishuText({
      id:"message-2",
      text:"重点看风险",
      receivedAt:LATER
    }),
    now:LATER
  });

  assert.equal(first.status,"active");
  assert.equal(first.revision,1);
  assert.equal(first.resolvedRevision,0);
  assert.equal(first.pendingInputs.length,1);
  assert.equal(second.revision,2);
  assert.equal(second.resolvedRevision,0);
  assert.equal(second.pendingInputs.length,2);
  assert.equal(second.source,"feishu");
  assert.equal(second.taskId,TASK_ID);
  assert.equal(second.startedAt,NOW);
  assert.equal(second.expiresAt,"2026-07-30T01:01:00.000Z");
});

test("projects only AI-safe task continuity and excludes protected pending envelopes",()=>{
  const session=createTaskSession({
    message:feishuText(),
    model:"codex",
    taskId:TASK_ID,
    now:NOW
  });

  assert.deepEqual(publicTaskContext(session),{
    taskId:TASK_ID,
    status:"active",
    revision:1,
    goal:"先帮我看看这个项目",
    workingSummary:"",
    confirmedRequirements:[],
    rejectedDirections:[],
    recentTurns:[],
    sourceIds:[],
    waiting:null,
    startedAt:NOW,
    updatedAt:NOW
  });
});

test("recognizes only exact attachment-free task controls",()=>{
  assert.deepEqual(classifyTaskControl({
    instructionText:"开始新任务：整理另一份方案",
    hasAttachments:false
  }),{
    kind:"new_task",
    instructionText:"整理另一份方案"
  });
  assert.deepEqual(classifyTaskControl({
    instructionText:"继续刚才的",
    hasAttachments:false
  }),{kind:"resume"});
  assert.deepEqual(classifyTaskControl({
    instructionText:"取消当前任务",
    hasAttachments:false
  }),{kind:"cancel"});
  assert.deepEqual(classifyTaskControl({
    instructionText:"先暂停",
    hasAttachments:false
  }),{kind:"pause"});
  assert.deepEqual(classifyTaskControl({
    instructionText:"这个任务结束",
    hasAttachments:false
  }),{kind:"end"});
  assert.deepEqual(classifyTaskControl({
    instructionText:"任务结束",
    hasAttachments:false
  }),{kind:"end"});
  assert.deepEqual(classifyTaskControl({
    instructionText:"当前任务已结束",
    hasAttachments:false
  }),{kind:"end"});
  assert.equal(classifyTaskControl({
    instructionText:"报告中写“结束任务”",
    hasAttachments:false
  }),null);
  assert.equal(classifyTaskControl({
    instructionText:"取消",
    hasAttachments:true
  }),null);
  assert.equal(classifyTaskControl({
    instructionText:"任务结束",
    hasAttachments:true
  }),null);
  assert.equal(classifyTaskControl({
    instructionText:"当前任务已结束",
    hasAttachments:true
  }),null);
});

test("resolves one stage without closing the task and preserves later input",()=>{
  const first=createTaskSession({
    message:feishuText(),
    model:"codex",
    taskId:TASK_ID,
    now:NOW
  });
  const second=appendTaskInput({
    session:first,
    message:feishuText({
      id:"message-2",
      text:"重点看风险",
      receivedAt:LATER
    }),
    now:LATER
  });
  const resolved=resolveTaskStage({
    session:second,
    throughRevision:1,
    userText:"先帮我看看这个项目",
    assistantText:"你希望我重点分析什么？",
    waiting:{
      type:"waiting_answer",
      question:"你希望我重点分析什么？",
      preparedTool:null,
      confirmed:{}
    },
    taskUpdate:{
      workingSummary:"正在确认项目分析重点。",
      confirmedRequirements:[],
      rejectedDirections:[]
    },
    now:"2026-07-29T01:02:00.000Z"
  });

  assert.equal(resolved.status,"active");
  assert.equal(resolved.revision,2);
  assert.equal(resolved.resolvedRevision,1);
  assert.deepEqual(
    resolved.pendingInputs.map(input=>input.revision),
    [2]
  );
  assert.deepEqual(
    resolved.recentTurns.map(turn=>turn.role),
    ["user","assistant"]
  );
  assert.equal(resolved.waiting.type,"waiting_answer");
  assert.equal(resolved.workingSummary,"正在确认项目分析重点。");
});

test("pauses and resumes without changing task identity or revision",()=>{
  const session=createTaskSession({
    message:feishuText(),
    model:"codex",
    taskId:TASK_ID,
    now:NOW
  });
  const paused=pauseTaskSession({
    session,
    now:"2026-07-29T01:02:00.000Z"
  });
  const resumed=resumeTaskSession({
    session:paused,
    now:"2026-07-29T01:03:00.000Z"
  });

  assert.equal(paused.status,"paused");
  assert.equal(resumed.status,"active");
  assert.equal(resumed.taskId,TASK_ID);
  assert.equal(resumed.revision,1);
});

test("rejects malformed task state and unsafe task updates with one bounded error",()=>{
  const session=createTaskSession({
    message:feishuText(),
    model:"codex",
    taskId:TASK_ID,
    now:NOW
  });
  for (const mutate of [
    value=>{ value.extra=true; },
    value=>{ value.taskId="platform-message-1"; },
    value=>{ value.source="other"; },
    value=>{ value.revision=0; },
    value=>{ value.resolvedRevision=2; },
    value=>{ value.pendingInputs[0].instructionText="a".repeat(131_073); },
    value=>{ value.sourceIds=["source-001","source-001"]; }
  ]) {
    const input=structuredClone(session);
    mutate(input);
    assert.throws(
      ()=>validateTaskSession(input),
      {message:"task_session_invalid"}
    );
  }

  assert.throws(()=>validateTaskUpdate({
    workingSummary:"/absolute/private/path",
    confirmedRequirements:[],
    rejectedDirections:[]
  }),{message:"task_session_invalid"});
  assert.throws(()=>validateTaskUpdate({
    workingSummary:"正常摘要",
    confirmedRequirements:["相同","相同"],
    rejectedDirections:[]
  }),{message:"task_session_invalid"});
});
