# LLW Standalone Bilibili Task Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Subagents are prohibited by the project owner. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the exact WeChat phrases `任务结束` and `当前任务已结束` truly close the active task so the next Bilibili link is processed as a new standalone `source-001` video task.

**Architecture:** Extend only the existing exact task-control classifier and reuse the existing Dispatcher `end` path, Task Session Manager close operation, and task-workspace cleanup. The Bilibili adapter, media validation, ASR, timeline, AI, Writer, and multi-source append behavior remain unchanged.

**Tech Stack:** Node.js ESM, `node:test`, existing LLW Task Session/Dispatcher/public-video composition, macOS LaunchAgent production service.

## Global Constraints

- Do not implement video-after-PDF append or PDF/video joint analysis.
- Do not force every Bilibili link to create a new task.
- Do not change Bilibili network domains, retries, media validation, ASR, timeline, AI, Writer, or permissions.
- Do not hand-edit production state JSON or delete user files.
- Use no subagents.
- Do not commit or push Git without separate project-owner authorization; use explicit diff checkpoints instead.

---

### Task 1: Make `任务结束` a real exact task-control command

**Files:**
- Modify: `src/personal-assistant/task-session.mjs` (`classifyTaskControl`)
- Modify: `test/personal-assistant-task-session.test.mjs` (exact task-control contract)
- Create: `test/v442-standalone-bilibili-after-end-wechat-journey.test.mjs`

**Interfaces:**
- Consumes: `classifyTaskControl({instructionText:string,hasAttachments:boolean})`
- Produces: `{kind:"end"}` for attachment-free exact `任务结束` and `当前任务已结束`; all existing controls and attachment rejection remain unchanged.
- Reuses: `PersonalAssistantDispatcher.handleTaskIncomingMessage()`, `PersonalAssistantTaskSessionManager.close()`, `TaskSourceWorkspace.remove()`, `createPublicVideoSourcePreparer()`, and `createTurnSourcePreparerWithPublicVideo()`.

- [ ] **Step 1: Add the failing unit contract**

Extend `recognizes only exact attachment-free task controls` with:

```js
assert.deepEqual(classifyTaskControl({
  instructionText:"任务结束",
  hasAttachments:false
}),{kind:"end"});
assert.equal(classifyTaskControl({
  instructionText:"任务结束",
  hasAttachments:true
}),null);
assert.deepEqual(classifyTaskControl({
  instructionText:"当前任务已结束",
  hasAttachments:false
}),{kind:"end"});
```

- [ ] **Step 2: Add the failing WeChat longitudinal contract**

Create one isolated runtime that performs this exact sequence:

```js
const oldPdf=await dispatcher.handleTaskIncomingMessage(
  createWechatIncomingMessage({
    messageId:"old-pdf",userId:"wx-owner",
    conversationId:"wx-owner",createTimeMs:firstTime,
    type:"file",contextToken:"ctx-old-pdf",
    attachment:{
      type:"file",sourceAttachmentId:"old_pdf",
      displayName:"旧任务.pdf",extension:"pdf"
    }
  })
);
const oldTask=taskManager.current("wechat");
assert.deepEqual(oldTask.sourceIds,["source-001"]);

nowMs+=1_000;
const ended=await dispatcher.handleTaskIncomingMessage(
  createWechatIncomingMessage({
    messageId:"end-old",userId:"wx-owner",
    conversationId:"wx-owner",createTimeMs:nowMs,
    type:"text",contextToken:"ctx-end-old",text:"当前任务已结束"
  })
);
assert.equal(ended.status,"committed");
assert.equal(taskManager.current("wechat"),null);
await assert.rejects(
  access(taskWorkspace.workspace(oldTask.taskId)),{code:"ENOENT"}
);

nowMs+=1_000;
const video=await dispatcher.handleTaskIncomingMessage(
  createWechatIncomingMessage({
    messageId:"new-bili",userId:"wx-owner",
    conversationId:"wx-owner",createTimeMs:nowMs,
    type:"text",contextToken:"ctx-new-bili",
    text:"总结 https://www.bilibili.com/video/BV1AbCdEfGhJ/ 不保存"
  })
);
assert.equal(video.status,"committed");
const newTask=taskManager.current("wechat");
assert.notEqual(newTask.taskId,oldTask.taskId);
assert.deepEqual(newTask.sourceIds,["source-001"]);
assert.deepEqual({siteCalls,readerCalls,videoAiCalls,writerCalls},{
  siteCalls:1,readerCalls:1,videoAiCalls:1,writerCalls:0
});
```

The test runtime must use real LLW task/session/source composition with synthetic private PDF, audio, and video bytes. It must not call the network, real ASR, real AI, Messenger, or a managed Vault. The fake assistant returns one reply for the old PDF and one summary reply for the video; the public-video reader asserts that the new video handle is `source-001`.

- [ ] **Step 3: Run RED and confirm the real defect**

Run:

```bash
node --test \
  test/personal-assistant-task-session.test.mjs \
  test/v442-standalone-bilibili-after-end-wechat-journey.test.mjs
```

Expected: the unit assertion reports actual `null` instead of `{kind:"end"}`; the journey does not close the old task and therefore fails before the new standalone-video assertions.

- [ ] **Step 4: Implement the minimal classifier change**

Change only the existing end-control regular expression in `classifyTaskControl`:

```js
if (/^(?:结束|结束任务|任务结束|结束当前任务|当前任务已结束|这个任务结束)[。！!\s]*$/u
  .test(text)) {
  return {kind:"end"};
}
```

- [ ] **Step 5: Run GREEN for the direct contracts**

Run the Step 3 command again.

Expected: both files pass; the old task becomes `null`, its workspace is removed, the new task ID differs, the Bilibili source is `source-001`, site/reader/video-AI each run once, and Writer remains zero.

- [ ] **Step 6: Run the focused compatibility set**

Run:

```bash
node --test \
  test/personal-assistant-task-session.test.mjs \
  test/personal-assistant-task-session-manager.test.mjs \
  test/personal-assistant-dispatcher.test.mjs \
  test/personal-assistant-public-video-link.test.mjs \
  test/personal-assistant-public-video-source-preparer.test.mjs \
  test/personal-assistant-task-source-workspace.test.mjs \
  test/v410-task-session-journeys.test.mjs \
  test/v427-video-knowledge-save-wechat-journey.test.mjs \
  test/v443-bilibili-single-attempt-wechat-journey.test.mjs \
  test/v442-standalone-bilibili-after-end-wechat-journey.test.mjs
```

Expected: zero failures and no network or production writes.

- [ ] **Step 7: Record a no-commit diff checkpoint**

Run:

```bash
git diff --check -- \
  src/personal-assistant/task-session.mjs \
  test/personal-assistant-task-session.test.mjs \
  test/v442-standalone-bilibili-after-end-wechat-journey.test.mjs
git diff -- \
  src/personal-assistant/task-session.mjs \
  test/personal-assistant-task-session.test.mjs \
  test/v442-standalone-bilibili-after-end-wechat-journey.test.mjs
```

Expected: only the approved exact-control change and its two regression layers appear. Do not commit or push.

---

### Task 2: Verify, deploy, and close the stale production task through the fixed control path

**Files:**
- Deploy: `src/personal-assistant/task-session.mjs`
- Deploy test evidence only if the production test tree is maintained: `test/personal-assistant-task-session.test.mjs`, `test/v442-standalone-bilibili-after-end-wechat-journey.test.mjs`
- Preserve: production config, state JSON, user files, Bilibili adapter, ASR ledger, and Writer data.

**Interfaces:**
- Consumes: the GREEN candidate from Task 1.
- Produces: a restarted healthy `com.llw.feishu-daily-work` service that recognizes `任务结束`; the owner's natural next control message closes the stale task.

- [ ] **Step 1: Run the complete candidate regression once**

Run:

```bash
node --test --test-reporter=dot
```

Expected: process exits `0` with zero failures. This is required because the classifier is shared by Feishu and WeChat.

- [ ] **Step 2: Create a protected production rollback point**

Back up the current production `task-session.mjs` and any deployed test files into a new timestamped directory under:

the protected local LLW baseline directory. Do not record the user name or
absolute host path in the repository.

Record SHA-256, byte size, and mode for the original and candidate. Do not alter config or state.

- [ ] **Step 3: Deploy the exact candidate and restart once**

Install only the approved runtime file with owner-only mode, optionally install the two test files into the maintained production test tree, and restart:

```bash
launchctl kickstart -k gui/501/com.llw.feishu-daily-work
```

Expected: candidate-to-production hashes match; LaunchAgent state is `running`; one fresh startup record appears; there are no new failure logs.

- [ ] **Step 4: Run production-focused contracts and health checks**

From the production component, run the direct task-control, Dispatcher, Bilibili source, and new WeChat journey tests. Then verify the LaunchAgent process, heartbeat/startup log, unreplied Outcome count, config hash, state-file mode, and empty public-video staging.

Expected: zero test failures, service healthy, no configuration or user-data mutation.

- [ ] **Step 5: Use the natural WeChat entrance to close the current stale task**

Ask the project owner to send either exact phrase:

```text
任务结束
当前任务已结束
```

Read-only verify that the fixed control reply is `当前任务已结束。`, the current WeChat Task Session is `null`, and the old task workspace has been released. Do not forge an inbound event and do not hand-edit state.

- [ ] **Step 6: Accept one natural standalone Bilibili summary**

Ask the project owner to resend the same Bilibili link with `总结内容 不保存`. Verify from Outcome/state/logs that a new task ID was created, its source list is exactly `["source-001"]`, public source preparation and video evidence completed, AI returned the summary, Writer performed zero writes, and no public-video staging remains.

- [ ] **Step 7: Report evidence and rollback location**

Report the RED failure, GREEN direct/focused/full counts, deployed hash match, service health, true closed state, standalone Bilibili Outcome, Writer zero evidence, and rollback directory. Do not claim production success until Step 6 has completed.

## Execution result (2026-08-01)

- `任务结束` 和 `当前任务已结束` 的直接合同与微信纵向合同通过，生产后台 Task
  Session 与固定回复一致。
- 项目所有者通过自然微信入口结束旧任务，再发送独立 B 站总结；系统创建新任务，
  视频为 `source-001`，完成音轨、画面、AI 回复，Writer 为 `0`。
- 后续 V4.4.3 验证再次覆盖该纵向流程；候选与生产聚焦集均为 `104/104`。
- V4.4.3 不扩展 PDF 后追加视频或 PDF/视频联合分析，只保留已验收的独立视频边界。
