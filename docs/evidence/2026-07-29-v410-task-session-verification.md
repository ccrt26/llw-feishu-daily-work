# V4.1.0 Continuous Task Session Verification

Date: 2026-07-29  
Component branch: `agent/v410-foundation-media-gates`  
Verified component candidate commit: `0c57481`
Verified Skill commit: `4a9ed70` on `agent/v410-continuous-tasks`  
Production deployment: **not performed**

## Release position

The continuous Task Session implementation is locally complete and has passed deterministic end-to-end journeys, the complete component regression and one real isolated Codex smoke. The project owner explicitly authorized transmitting the isolated private Skill contract and generated synthetic task context for that smoke. All pre-deployment gates now pass.

Media remains disabled under `STOP_AFTER_FOUNDATION`. No media runtime, new permission, extra process, router, registry, side-effect tool, production state migration, push or deployment was performed.

The production Skill working branch briefly contained the 4.1.0 commit during local verification. Read-only production inspection detected that this path is also the live Skill source, so the new contract could not safely remain beside the old component. Commit `4a9ed70` was preserved on the isolated implementation branch, and production Skill content was restored to 4.0.1 with auditable revert commit `4a5d8db`. The running component was not restarted. Deployment must later switch the verified component and Skill together.

## Root cause verified

The original failure was not caused by WeChat or Feishu being unable to send text and files together. It came from the assistant runtime treating short delivery bursts, AI replies, questions and failures as task boundaries. The source bytes were consequently tied to an old turn and later instructions had no authoritative source binding.

The implemented boundary is one independent current Task Session per channel. Every accepted same-channel input first increments a durable revision. A debounce window schedules work only; it never decides task membership. AI completion does not close the task. Explicit controls or 24-hour inactivity change the boundary.

The longitudinal and deployment-gate verification found and fixed five integration defects that isolated tests did not expose:

1. Retained task workspaces were not accepted by the real `KnowledgeWriter` safety boundary.
2. Expired state was cleared without synchronously cleaning the old task workspace.
3. A crash after a source manifest was durable but before source IDs reached state could strand the task or force a redownload.
4. Cancellation after Writer reservation could falsely promise that nothing would be saved even though the side effect had crossed its point of no return.
5. The live V4.0.1 WeChat channel still had one valid waiting conversation. A direct V4.1.0 startup would have kept it only as an ignored legacy field, silently breaking continuity.

## Primary longitudinal evidence

`test/v410-task-session-journeys.test.mjs` passed all 11 named journeys with zero skips:

1. file-only synthetic Feishu PDF → real Source Intake → purpose question → more than 15 seconds later instruction → same task and identical SHA-256 → real `KnowledgeWriter` → one knowledge item → durable Outcome → original-channel reply;
2. revision 1 analysis held → revision 2 supplement accepted → stale `create_document` blocked before generator/Writer/Outcome/reply → revision 2 alone publishes one verified DOCX;
3. simultaneous Feishu PDF and WeChat DOCX tasks remain isolated by task ID, workspace, source context and `ReplyTarget`;
4. process restart after a question preserves the same task and PDF without redownload;
5. AI failure → later retry uses the same retained source;
6. Writer failure produces one truthful failure Outcome with no second AI call;
7. reply failure → restart resends the stored Outcome without AI or Writer;
8. cancellation during AI makes the old result stale with zero Writer calls;
9. cancellation after Writer reservation reports the irreversible boundary, finishes the real Writer once and returns the true outcome;
10. 24-hour expiry removes the old workspace and gives the next input a new task;
11. pause/resume keeps identity, while ordinary input during pause and explicit new-task controls replace and clean the old task.

The harness uses the real `IncomingMessage`, binding/idempotency gate, `StateStore`, Task Session manager, Source Intake, task source workspace, Content Safety, `PersonalAssistantClient`, authoritative tool definitions, real synthetic Vault Writer or `FileOutputWorkspace`, atomic Outcome commit and Messenger path. Only AI decisions and timing are injected.

## Regression evidence

Production V4.0.1 baseline before implementation:

```text
591 tests
591 passed
0 failed
```

V4.1.0 isolated component regression after the longitudinal and live-state migration fixes:

```text
675 tests
675 passed
0 failed
0 skipped
duration: 13.095 seconds
```

The first restricted run produced 24 failures solely because the sandbox denied temporary loopback listeners with `listen EPERM 127.0.0.1`. The suite was rerun with local-loopback permission. After adding the three deployment migration checks, the final candidate passed `675/675`.

## Privacy and architecture checks

- Production composition contains one `PersonalAssistantClient`, one Task Session manager and one Dispatcher.
- The authoritative side-effect tools remain exactly: `record_daily_work`, `archive_dining_invoice`, `save_knowledge`, `create_document`.
- Feishu and WeChat remain I/O adapters to the same Personal Assistant and keep independent current Task Sessions.
- The credential-pattern scan found only guard regexes, authorization construction and explicit synthetic negative-test fixtures. No literal production token or platform identity was found.
- Deterministic reports contain only synthetic hashes, statuses, decision kinds, counts and elapsed time.
- Source workspaces and manifests are owner-only and are removed on task replacement, cancellation before Writer, completion of a deferred cancellation, or expiry.

## Real isolated Codex evidence

`test/v410-task-session-real-model-smoke.mjs` used the isolated V4.1.0 Skill worktree, a generated non-private PDF and private temporary directories. It recorded no prompt text, model response body, absolute path or platform-like identifier.

After explicit project-owner authorization, the real Codex invocation completed in 57.040 seconds:

```json
{
  "status": "passed",
  "taskIdStable": true,
  "decisions": ["ask", "reply"],
  "stages": ["awaiting_clarification", "committed"],
  "sourceCount": 1,
  "writerCalls": 0,
  "replyCount": 2,
  "elapsedMs": 57040
}
```

The generated PDF was accepted without an instruction, the real model asked for the purpose, and a later instruction was processed in the same task against the same single source. The second decision was a direct reply, so the safe zero-Writer path was correctly preserved.

Immediately afterward, the complete deterministic journey suite was rerun and again passed all 11 journeys with zero failures or skips. This satisfies the full-flow evidence gate. Production deployment and real platform acceptance remain separate subsequent gates; media runtime installation and enablement remain prohibited.

## Live-state migration evidence

A read-only preflight found one current V4.0.1 WeChat waiting conversation and no Feishu waiting conversation or retained media source. Deployment therefore gained an explicit, V6-only migration rather than discarding the old state.

The migration converts each safe legacy per-channel conversation into that channel's active Task Session, preserving its model, bounded recent turns, question, waiting type, confirmed fields, start/update time and 24-hour expiry. It clears the legacy field only in the same atomic state persistence. If a legacy conversation contains a retained source that cannot be proven equivalent to a task source, startup fails closed and leaves the state bytes unchanged.

A protected copy of the actual production state was migrated in `/private/tmp` and then deleted. The redacted result was:

```json
{
  "status": "passed",
  "stateVersion": 4,
  "oldConversationCleared": true,
  "wechatTaskCreated": true,
  "turnCountPreserved": true,
  "modelPreserved": true,
  "waitingTypePreserved": true,
  "feishuRemainsEmpty": true,
  "fileMode": 384
}
```

Decimal mode `384` is owner-only `0600`. No conversation text, identity, task ID or protected path was recorded in the report.

## Protected rollback evidence

The exact pre-deploy V4.0.1 baseline is preserved under the protected `v410-task-session-pre-deploy-2026-07-29` baseline directory.

It contains:

- complete component and Skills Git bundles;
- production component commit `b3351098fd74d2d3e833504c0101207eb09a7f43`;
- production Skill rollback commit `4a5d8db10a215690fb8ec209c90266a8a4b9e07c`, whose runtime content is 4.0.1;
- exact protected version-6 config and version-4 state snapshots;
- heartbeat, model and WeChat state;
- the unchanged LaunchAgent plist;
- owner-only modes, SHA-256 manifest, recovery order and restore-drill report.

The directory is mode `0700`; every file is `0600`. The final manifest verified every file. A fresh temporary restore cloned both bundles, checked out the recorded commits, byte-compared every protected snapshot and ran the restored component regression:

```text
591 tests
591 passed
0 failed
0 skipped
```

The production LaunchAgent was not stopped or restarted during backup or restore rehearsal. Disposable restore and staging directories were removed after the protected baseline was verified.
