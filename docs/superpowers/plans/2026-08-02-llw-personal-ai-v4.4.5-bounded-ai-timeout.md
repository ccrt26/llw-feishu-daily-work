# LLW Personal Assistant V4.4.5 DOCX Evidence Preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one retained Feishu cloud DOCX reliably readable, summarizable and savable without changing permissions, architecture or non-DOCX behavior.

**Architecture:** Keep the existing Personal Assistant, Router, Writer, Task Session and configuration schema. A new deterministic `TaskDocxReader` prepares hash-bound text, PNG images and a trusted coverage index before AI. Eligible DOCX turns make exactly one existing Personal Assistant call with an explicit 600-second ceiling and a single five-minute progress message; source operations and all pure non-DOCX turns remain at 120 seconds. A trusted coverage gate blocks `save_knowledge` before Writer reservation when any selected DOCX is partial, missing or stale.

**Tech Stack:** Node.js ESM, `node:test`, existing child-process and atomic-file primitives, macOS LaunchAgent, Git/GitHub.

## Execution result

2026-08-02，Tasks 1–9 已按本计划完成实现、部署和真实飞书验收。下方未勾选的
步骤保留为当时的逐步执行合同，不再表示待办状态。最终真实来源得到 123 个文字
结构、14/14 张图片和 `complete` 覆盖；一次 Personal Assistant 决策完成一次
Writer，Outcome 先保存后回复，知识项只包含一份 Markdown 和一份哈希一致的
原 DOCX。标准飞书导出结构的最后兼容修复提交为 `65da141`，未扩大权限、架构、
模型、服务、依赖或非 DOCX 行为。

## Global constraints

- Release gate at execution start: the external version remained V4.4.3 until a real retained Feishu DOCX completed Writer → Outcome → original-entry reply; that gate has now passed.
- V4.4.4 OOXML safety behavior is the required base and must remain green throughout the shared package-reader refactor.
- Production `personalAssistant.aiTimeoutMs` remains exactly `120000`; config schema remains 7 and state schema remains 4.
- `inspect`, `export` and existing attachment downloads remain bounded by their existing 120-second contracts.
- Only a turn containing at least one verified DOCX and no public video receives an explicit 600-second AI ceiling.
- A qualifying DOCX turn makes exactly one provider call with `allowSourceRead=false`; it never enters the source-read decision loop.
- Local DOCX preparation has one parent-enforced 60-second whole-turn deadline and runs in a private short-lived Node child process.
- Do not add Agent, Router, Writer, service, queue, dependency, permission, model, reasoning setting, source type or knowledge format.
- Do not modify the retired `ooxml_processor.py` unless a production caller is first proven. This plan does not modify it.
- Do not log or commit private document content, titles, platform identifiers, tokens, task IDs or Vault paths.
- New behavior is written test-first. Shared-core refactoring preserves existing behavior before new behavior is added.
- Commit after each coherent green task. Do not push or update production version before real acceptance.

---

### Task 1: Remove the obsolete 300-second configuration candidate and expose a per-call timeout

**Files:**
- Modify: `test/config.test.mjs`
- Modify: `test/personal-assistant-invoker.test.mjs`
- Modify: `test/personal-assistant-client.test.mjs`
- Modify: `src/config.mjs`
- Modify: `src/personal-assistant/invoke-personal-assistant.mjs`
- Modify: `src/personal-assistant/client.mjs`

**Contracts:**
- Schema 7 accepts only `personalAssistant.aiTimeoutMs === 120000`.
- The invoker accepts explicit integer timeouts through `600000` and rejects `600001`.
- `PersonalAssistantClient.decide(context, {timeoutMs})` forwards that value to its provider; when absent, the provider keeps its existing default.

- [ ] **Step 1: Run the direct baseline and record the existing counts**

```bash
/usr/local/bin/node --test test/config.test.mjs test/config-v6.test.mjs test/personal-assistant-invoker.test.mjs test/personal-assistant-client.test.mjs
```

- [ ] **Step 2: Replace the obsolete configuration test with a failing exact-120 contract**

Test `120000` succeeds and each of `1`, `119999`, `120001`, `300000`, `600000` fails with `invalid_personal_assistant`. Run `test/config.test.mjs`; RED must be the current acceptance of `300000`.

- [ ] **Step 3: Replace the old invoker ceiling test with a failing 600-second boundary test**

Use the existing synthetic child fixture. Assert `600000` does not reject and `600001` rejects with `assistant_invocation_invalid`. Run the single test; RED must be the current 300-second ceiling.

- [ ] **Step 4: Add a failing client forwarding test**

Capture the provider options from:

```js
await client.decide(context, {timeoutMs: 600_000});
assert.equal(received.timeoutMs, 600_000);
```

Also assert an omitted `timeoutMs` remains omitted. Run `test/personal-assistant-client.test.mjs`; RED must show that the option is not forwarded.

- [ ] **Step 5: Implement the minimal contracts**

Restore `src/config.mjs` to exact `120_000` validation. Change only the invoker upper validator from `300_000` to `600_000`; keep its default `120_000`. Extend `PersonalAssistantClient.decide` to pass an optional `timeoutMs` to the provider without introducing a new default.

- [ ] **Step 6: Run GREEN and confirm unrelated timeout validators did not change**

```bash
/usr/local/bin/node --test test/config.test.mjs test/config-v6.test.mjs test/personal-assistant-invoker.test.mjs test/personal-assistant-client.test.mjs
git diff -- src/config.mjs src/personal-assistant/invoke-personal-assistant.mjs src/personal-assistant/client.mjs
```

- [ ] **Step 7: Commit**

```bash
git add src/config.mjs src/personal-assistant/invoke-personal-assistant.mjs src/personal-assistant/client.mjs test/config.test.mjs test/personal-assistant-invoker.test.mjs test/personal-assistant-client.test.mjs
git commit -m "fix: separate docx analysis timeout contract"
```

### Task 2: Extract one strict bounded OOXML package reader without changing V4.4.4

**Files:**
- Create: `src/personal-assistant/bounded-ooxml-package.mjs`
- Create: `test/personal-assistant-bounded-ooxml-package.test.mjs`
- Modify: `src/personal-assistant/source-security-inspector.mjs`
- Verify: `test/personal-assistant-source-security-inspector.test.mjs`
- Verify: `test/v444-feishu-cloud-document-ingest-journey.test.mjs`

**API:**

```js
openBoundedOoxmlPackage(filePath, {
  maxEntries,
  maxEntryBytes,
  maxTotalBytes,
  expectedSha256
})
// returns immutable canonical entry metadata plus bounded readEntry(name)
```

The module owns canonical ZIP-name validation, duplicate detection, entry and aggregate size limits, CRC/decompression checks, package-relative target resolution, strict relationship parsing, and XML preflight that rejects `DOCTYPE`/`ENTITY`/external entities.

- [ ] **Step 1: Run the complete V4.4.4 safety baseline**

```bash
/usr/local/bin/node --test test/personal-assistant-source-security-inspector.test.mjs test/v444-feishu-cloud-document-ingest-journey.test.mjs
```

- [ ] **Step 2: Add RED package-reader tests**

Cover: expected SHA match/mismatch, canonical names, duplicate normalized names, `../` escape, max entries, single-entry limit, aggregate limit, truncated data, XML declarations, forbidden `DOCTYPE`/`ENTITY`, internal relationship resolution, dangling target, and External relationship preservation for the inspector to classify.

- [ ] **Step 3: Move existing low-level primitives into the shared module**

Do not alter the inspector's relationship policy. The inspector must call the shared reader and retain its exact V4.4.4 allow/reject decisions, especially: only typed Office hyperlink + valid credential-free HTTP(S) may be external; unknown/type-missing/external media/template/OLE/workbook/attachment remain rejected.

- [ ] **Step 4: Run GREEN, the V4.4.4 journey, and diff for policy drift**

```bash
/usr/local/bin/node --test test/personal-assistant-bounded-ooxml-package.test.mjs test/personal-assistant-source-security-inspector.test.mjs test/v444-feishu-cloud-document-ingest-journey.test.mjs
git diff -- src/personal-assistant/source-security-inspector.mjs
```

- [ ] **Step 5: Commit**

```bash
git add src/personal-assistant/bounded-ooxml-package.mjs src/personal-assistant/source-security-inspector.mjs test/personal-assistant-bounded-ooxml-package.test.mjs
git commit -m "refactor: share bounded ooxml package reader"
```

### Task 3: Build the deterministic DOCX parser and coverage classifier

**Files:**
- Create: `src/personal-assistant/docx-evidence-helper.mjs`
- Create: `test/fixtures/docx-evidence-fixture.mjs`
- Create: `test/personal-assistant-docx-evidence-helper.test.mjs`

**Child input/output:**

```js
// stdin job
{ inputPath, expectedSha256, outputDir, limits }

// stdout result envelope
{
  originalSha256,
  observations,
  imageCandidates,
  coverage: { status: "complete" | "partial", limitations, parts }
}
```

Each image candidate contains exactly `documentOrder`, `ownerPartName`, `relationshipId`, `targetMediaPartName`, `jobRelativePath`, `sha256`. It is emitted only when the relationship in that exact owner part resolves to the declared `word/media/...` PNG.

- [ ] **Step 1: Add a minimal synthetic DOCX fixture builder**

The builder creates bounded packages without private business data and can vary document XML, owner-part relationships, media, content types and extra entries.

- [ ] **Step 2: Add RED complete-coverage tests**

Prove ordered representation of headings, paragraphs, numbered/bulleted lists, table cells, headers, footers, footnotes, endnotes and PNG images. Include the same relationship ID in `document.xml` and `header1.xml` pointing to different PNG files; assert both exact owner-scoped mappings and monotonically increasing `documentOrder`.

- [ ] **Step 3: Add RED partial-coverage tests**

Each of comments, tracked changes, chart, diagram/SmartArt, equation, text box, `altChunk`, custom XML binding, other DrawingML, JPEG/WebP/GIF/SVG/EMF/TIFF, image-budget overflow, text-budget overflow and unknown possibly-visible internal content must yield `partial` with a stable limitation code. A syntactically valid unsupported internal relation is partial, never complete.

- [ ] **Step 4: Add RED fail-closed tests**

Cover malformed XML, forbidden entities, unsafe/dangling/escaping relationship targets, duplicate normalized ZIP names, resource violations, hash mismatch, media declared PNG but non-PNG magic, and unknown external relations. These return a deterministic preparation error and publish nothing.

- [ ] **Step 5: Implement the helper using only the shared package reader**

Parse supported WordprocessingML objectively. Do not summarize or perform network access. Require `word/document.xml`; parse optional numbering/styles/header/footer/footnotes/endnotes when present. Classify every package entry and relationship as represented, known metadata, known unsupported, unknown possibly visible or unsafe.

- [ ] **Step 6: Run GREEN and verify the helper has no network/runtime dependency**

```bash
/usr/local/bin/node --test test/personal-assistant-docx-evidence-helper.test.mjs test/personal-assistant-bounded-ooxml-package.test.mjs test/personal-assistant-source-security-inspector.test.mjs
```

- [ ] **Step 7: Commit**

```bash
git add src/personal-assistant/docx-evidence-helper.mjs test/fixtures/docx-evidence-fixture.mjs test/personal-assistant-docx-evidence-helper.test.mjs
git commit -m "feat: prepare deterministic docx evidence"
```

### Task 4: Publish and reuse owner-only, hash-bound task DOCX evidence

**Files:**
- Create: `src/personal-assistant/task-docx-evidence.mjs`
- Create: `src/personal-assistant/task-docx-reader.mjs`
- Create: `test/personal-assistant-task-docx-evidence.test.mjs`
- Create: `test/personal-assistant-task-docx-reader.test.mjs`
- Modify: `src/personal-assistant/model-image-evidence.mjs`
- Modify: `test/personal-assistant-model-image-evidence.test.mjs`

**Reader API:**

```js
await taskDocxReader.prepare({workspaceDir, sources, signal, now});
// {
//   observations,
//   modelImageFiles,
//   coverageBySource: {
//     [sourceId]: {
//       sourceId, originalSha256, indexRelativePath, indexSha256,
//       status: "complete" | "partial", limitations
//     }
//   }
// }
```

Each `DocxImageEvidence` has exactly: `sourceId`, `relativePath`, `sha256`, `documentOrder`, `ownerPartName`, `relationshipId`, `targetMediaPartName`.

- [ ] **Step 1: Add RED publication tests**

Assert fixed safe names `source-00N.docx-text.json`, `source-00N.docx-image-NNN.png`, `source-00N.docx-index.json`; `0600`; exclusive staging; atomic rename; original/index/evidence hashes; owner-part relation map; sidecar manifest; cleanup on any failure; no modification of original DOCX.

- [ ] **Step 2: Add RED exact-reuse tests**

Reuse only when original SHA, index SHA, every evidence SHA and the reconstructed trusted coverage map match. Missing files, extra files, wrong permission, altered index, stale original or changed relation map fail closed rather than silently regenerating from stale evidence.

- [ ] **Step 3: Add RED child/watchdog/cancellation tests**

Use an injectable fake sleeping helper to prove the parent terminates it at the configured 60-second contract, cleans the private job, publishes nothing and respects an abort signal. Do not add a real 60-second wall-clock test.

- [ ] **Step 4: Extend the model-image validator test-first**

Add a DOCX descriptor branch while preserving PDF/video descriptors. Validate exact keys, safe private relative path, PNG signature, bytes, dimensions/pixels, SHA, strictly increasing `documentOrder`, and owner/relationship/target syntax. The authoritative `(ownerPartName, relationshipId) → targetMediaPartName` proof remains in the signed/hash-bound DOCX index produced by the publisher; the generic validator must not invent that mapping.

- [ ] **Step 5: Implement reader, publisher and validator branch**

Copy the current DOCX into an owner-only private job, start the short-lived Node helper, enforce the whole `prepare` deadline in the parent, validate all child output, publish atomically, then return only evidence reconstructed from the validated index.

- [ ] **Step 6: Run GREEN and adjacent PDF/video evidence regressions**

```bash
/usr/local/bin/node --test test/personal-assistant-task-docx-evidence.test.mjs test/personal-assistant-task-docx-reader.test.mjs test/personal-assistant-model-image-evidence.test.mjs test/personal-assistant-task-pdf-reader.test.mjs test/personal-assistant-video-timeline-reader.test.mjs
```

- [ ] **Step 7: Commit**

```bash
git add src/personal-assistant/task-docx-evidence.mjs src/personal-assistant/task-docx-reader.mjs src/personal-assistant/model-image-evidence.mjs test/personal-assistant-task-docx-evidence.test.mjs test/personal-assistant-task-docx-reader.test.mjs test/personal-assistant-model-image-evidence.test.mjs
git commit -m "feat: publish trusted task docx evidence"
```

### Task 5: Integrate one-call DOCX analysis, five-minute progress and the Writer coverage gate

**Files:**
- Modify: `src/personal-assistant/coordinator.mjs`
- Create: `test/personal-assistant-coordinator-docx.test.mjs`
- Verify: `test/personal-assistant-coordinator-tools.test.mjs`
- Modify: `src/personal-assistant/dispatcher.mjs` (only if this is the current failure-reply owner)
- Modify: corresponding dispatcher test if needed

**Decision rules:**
- Eligible: at least one verified DOCX and no public video.
- Mixed DOCX + ordinary text/image/PDF/PPTX/XLSX: eligible; all existing non-DOCX readers remain unchanged.
- DOCX + public video: reject before provider and Writer with a user-facing split-task request.
- Eligible call: `timeoutMs: 600000`, `allowSourceRead: false`, call count exactly one.
- Non-DOCX-only call: existing `120000` config/default and existing source-read behavior.

- [ ] **Step 1: Add RED routing and call-count tests**

Cover pure DOCX, DOCX mixed with ordinary sources, DOCX + public video rejection, pure PDF, pure PPTX/XLSX, pure image/text and pure public video. Assert provider options and exact call counts. If a DOCX provider returns a source-read envelope, assert invalid result, one call and zero Writer.

- [ ] **Step 2: Add RED progress tests using fake timers**

At 299,999 ms send nothing. At 300,000 ms send at most one message only if the exact task/revision is still current and AI remains pending. Use deterministic idempotency key `docx-progress:<task-id>:<revision>`. Progress failure must not fail the eventual final path, create Outcome or reserve Writer. Completion/cancel/revision change clears the timer.

- [ ] **Step 3: Add RED trusted coverage-gate tests**

Before `reserveWriter`, take the union of `toolCall.arguments.sourceIds` and `evidenceSourceIds`. For each selected DOCX require a current `coverageBySource` entry whose source ID and original SHA match, index/evidence were validated, and status is `complete`. Selected partial/missing/stale DOCX yields a limitation-aware reply and Writer reservations/calls of zero. An unselected partial DOCX must not block saving another selected complete source.

- [ ] **Step 4: Implement minimal coordinator changes**

Prepare DOCX evidence before context construction, merge observations/images through existing evidence contracts, classify the turn, schedule/cancel the progress timer, pass the explicit per-call timeout, prohibit the DOCX source-read loop and apply the gate before Writer reservation. Add a stable `docx_prepare_failed` phase only if the existing phase vocabulary cannot accurately report helper failure.

- [ ] **Step 5: Run GREEN plus current task/revision/Writer/Outcome contracts**

```bash
/usr/local/bin/node --test test/personal-assistant-coordinator-docx.test.mjs test/personal-assistant-coordinator-tools.test.mjs test/personal-assistant-task-session.test.mjs test/personal-assistant-task-session-manager.test.mjs test/personal-assistant-save-knowledge.test.mjs
```

- [ ] **Step 6: Commit**

```bash
git add src/personal-assistant/coordinator.mjs test/personal-assistant-coordinator-docx.test.mjs src/personal-assistant/dispatcher.mjs test/personal-assistant-dispatcher.test.mjs
git commit -m "feat: bound single-call docx analysis"
```

Only add dispatcher files if they actually changed.

### Task 6: Wire independent time contracts in main composition

**Files:**
- Modify: `src/main.mjs`
- Modify: `test/main-composition.test.mjs`
- Modify: any direct constructor fixture that must receive `TaskDocxReader`

**Composition:**
- Feishu document exporter `inspect/export`: `120000`.
- Existing Feishu/WeChat attachment downloader: existing `120000` boundary.
- `TaskDocxReader`: parent `60000` preparation deadline.
- Provider closure: `timeoutMs ?? config.personalAssistant.aiTimeoutMs`.
- Coordinator eligible DOCX call: explicit `600000`.

- [ ] **Step 1: Add RED composition tests**

Use injected fakes to prove each distinct timeout reaches only its intended component. Prove changing per-call AI timeout cannot make exporter/downloader construction fail. Prove non-DOCX uses config `120000`.

- [ ] **Step 2: Wire the reader and decouple timeouts**

Instantiate one `TaskDocxReader`; pass it to the existing coordinator. Keep configuration, permissions, models, services and all other readers unchanged.

- [ ] **Step 3: Run GREEN and startup/config regressions**

```bash
/usr/local/bin/node --test test/main-composition.test.mjs test/config.test.mjs test/config-v6.test.mjs test/personal-assistant-invoker.test.mjs
```

- [ ] **Step 4: Commit**

```bash
git add src/main.mjs test/main-composition.test.mjs
git commit -m "fix: decouple source and docx analysis deadlines"
```

### Task 7: Prove the vertical Feishu DOCX journey and failure boundaries

**Files:**
- Create or replace: `test/v445-feishu-docx-evidence-journey.test.mjs`
- Modify only if needed: existing journey fixtures

- [ ] **Step 1: Add the successful vertical contract**

Test:

```text
Feishu cloud-document message
→ user-identity export
→ V4.4.4 safety inspection
→ DOCX evidence preparation
→ exactly one Personal Assistant call
→ save_knowledge
→ one KnowledgeWriter atomic write
→ Outcome persisted
→ one final Feishu reply
→ staging cleanup
```

Assert DOCX provider options (`600000`, `allowSourceRead=false`), trusted complete coverage, progress idempotency behavior, Writer at most once and Outcome-before-reply ordering.

- [ ] **Step 2: Add zero-write failure journeys**

Cover partial selected DOCX, preparation timeout/error, AI ten-minute timeout, invalid source-read envelope, task revision update and cancellation. Each must retain source, make Writer zero, avoid false-success Outcome/reply and clean unpublished jobs.

- [ ] **Step 3: Add mixed/non-DOCX regression journeys**

Prove DOCX + ordinary sources remains one 600-second call; DOCX + public video rejects before AI; pure PDF/video/text retains existing reader/source-read/120-second behavior.

- [ ] **Step 4: Run the journey set**

```bash
/usr/local/bin/node --test test/v444-feishu-cloud-document-ingest-journey.test.mjs test/v445-feishu-docx-evidence-journey.test.mjs test/v427-video-knowledge-save-wechat-journey.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add test/v445-feishu-docx-evidence-journey.test.mjs
git commit -m "test: prove v4.4.5 feishu docx journey"
```

### Task 8: Candidate verification, resource measurements and documentation

**Files:**
- Modify: `README.md`
- Replace: `docs/evidence/2026-08-02-v445-bounded-ai-timeout-baseline.md`
- Replace: `docs/reports/2026-08-02-v445-bounded-ai-timeout-candidate.md`
- Modify if present: version/changelog documentation that currently calls the old 300-second candidate active

- [ ] **Step 1: Run the focused contract set**

Run all files added or changed in Tasks 1–7 plus V4.4.4 inspector/journey, Task Session, Writer and Outcome tests. Record command, counts, duration and result without private data.

- [ ] **Step 2: Measure DOCX preparation on deployment-type Mac**

Use synthetic, non-private bounded fixtures. Measure cold and warm runs for:

1. one legal DOCX at the 2,048-entry/64-MiB expanded package boundary;
2. up to eight legal DOCX files at the 80-MiB task boundary.

Record total duration, peak published bytes and result code. Any 60-second watchdog hit, resource violation for a legal fixture or clearly nonlinear growth blocks deployment. Do not weaken limits to make a benchmark pass.

- [ ] **Step 3: Run one complete regression because shared startup, OOXML and coordinator code changed**

```bash
/usr/local/bin/npm test
```

This single complete run is required to detect format, entry and source-safety regressions that focused tests cannot see. Do not mechanically repeat it. If an environment-only media test fails, rerun only that exact unchanged test under the required local media permission and record both results.

- [ ] **Step 4: Run static hygiene and inspect the exact scope**

```bash
git diff --check
git status --short
git diff --name-only a0f365e..HEAD
rg -n "300_000|300000|V4\.4\.5|aiTimeoutMs" src test README.md docs/superpowers docs/evidence docs/reports
```

Every remaining `300000` must be the five-minute progress contract or clearly marked superseded history, never production configuration or final AI timeout.

- [ ] **Step 5: Replace obsolete candidate evidence and update README**

Record the approved design, RED/GREEN evidence, exact changed files, focused/full results, resource measurements, rollback requirements and status “not externally released”. Mark the old fixed-300 plan/deployment attempt as superseded and rolled back. Do not include private content or identifiers.

- [ ] **Step 6: Perform main-agent correctness review against every design invariant**

Verify exact one-call, timeout separation, fail-closed package parsing, owner-scoped image relationships, coverage-before-reservation, zero-write failures, non-DOCX unchanged, and no scope expansion. Do not use another subagent; the approved independent design review already consumed the one reviewer allowed by the owner.

- [ ] **Step 7: Commit the candidate report**

```bash
git add README.md docs/evidence/2026-08-02-v445-bounded-ai-timeout-baseline.md docs/reports/2026-08-02-v445-bounded-ai-timeout-candidate.md
git commit -m "docs: record v4.4.5 docx evidence candidate"
```

### Task 9: Deploy safely and complete the retained real Feishu acceptance

**Files outside Git:**
- Production component: `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work`
- Owner-only rollback baseline: `/Users/ccrt/Library/Application Support/LLW Assistant/backups/baselines/`
- Existing protected config/state/LaunchAgent and logs

- [ ] **Step 1: Verify and refresh the rollback point**

Capture production component hash manifest, config/state schema and permission modes without secret values. Preserve the currently healthy V4.4.4 production component and verify the restore procedure before changing production.

- [ ] **Step 2: Deploy only the verified candidate atomically**

Copy from the exact candidate commit, preserve owner-only permissions, restart the single existing LaunchAgent, and verify exactly one service, one Node main process, one direct Feishu consumer, advancing heartbeat and healthy Skill loading. Do not change production `personalAssistant.aiTimeoutMs` from `120000`.

- [ ] **Step 3: Verify pre-acceptance safety**

Confirm the retained source still exists, no knowledge write occurred, no duplicate consumer exists and no stale candidate process remains.

- [ ] **Step 4: Request the only necessary owner action**

If no retained “重试” message is already pending after this deployment, ask the owner to send exactly “重试” in the same Feishu conversation. Do not ask for another upload.

- [ ] **Step 5: Observe one real vertical journey without reading/logging business content**

Record only phase durations, counts, hashes/coverage result codes and ordering. Acceptance requires:

- current retained DOCX SHA matches its evidence index;
- all 14 previously observed PNG media are represented or an explicit limitation safely blocks saving;
- provider call count is exactly one and returns a valid decision within ten minutes;
- KnowledgeWriter is called at most once;
- successful save persists Outcome before the original-entry final reply;
- no false-success reply and no duplicate write.

- [ ] **Step 6: Handle acceptance result**

On success, update production/system version documentation to V4.4.5, run final health checks and commit the release evidence. On any failure, preserve source and evidence, prove Writer zero or reconcile the single reservation outcome, roll back to the verified V4.4.4 baseline when runtime health or safety is uncertain, and report the exact failing phase. Do not raise the ten-minute ceiling.

- [ ] **Step 7: Sync only after verified success**

After all tests, health checks and real acceptance are green, commit the final release record and push the verified branch under the owner's standing synchronization authorization. Report branch, commits, deployment state and rollback point.

## Completion gate

V4.4.5 is complete only when all of the following are true:

- configuration remains schema 7 with production AI default 120 seconds;
- source operations remain 120 seconds and DOCX preparation is parent-bounded at 60 seconds;
- qualifying DOCX analysis uses one 600-second call and one optional five-minute progress message;
- pure non-DOCX behavior remains unchanged;
- selected incomplete/stale DOCX cannot reserve or call Writer;
- focused tests, one justified full regression and deployment-shape resource measurements pass;
- the retained real Feishu journey completes Writer → Outcome → original-entry reply exactly once;
- production health is green and the external version is then, and only then, V4.4.5.

**Gate result:** passed on 2026-08-02. Production is V4.4.5; schema 7 and
`personalAssistant.aiTimeoutMs=120000` remain unchanged. The verified rollback
baselines remain owner-only outside Git.
