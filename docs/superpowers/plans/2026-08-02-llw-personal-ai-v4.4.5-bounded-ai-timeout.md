# LLW Personal Assistant V4.4.5 Bounded AI Timeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend only the Personal Assistant Codex analysis deadline from 120 seconds to the existing bounded 300-second ceiling, then complete the retained real Feishu cloud-document read-summary-save journey.

**Architecture:** Keep the current single Personal Assistant and configuration schema 7. The validator will accept exactly the legacy 120,000 ms value and the V4.4.5 300,000 ms value; production will atomically change only that existing field. The existing invoker, task revision checks, Writer reservation, Outcome ordering, permissions, models and services remain unchanged.

**Tech Stack:** Node.js ESM, `node:test`, macOS LaunchAgent, existing atomic `loadConfig`/`saveConfig`, Git/GitHub.

## Global Constraints

- Current external system version remains V4.4.3 until the real Feishu journey succeeds.
- V4.4.4 safety code stays intact and is the required base for V4.4.5.
- `personalAssistant.aiTimeoutMs` accepts only `120000` and `300000`; production uses `300000`.
- Invoice, knowledge-ingest and assistant-work AI timeouts remain exactly `120000`.
- Configuration schema remains 7 and state schema remains 4.
- Do not add automatic retries, dynamic timeout policy, dependencies, permissions, models, Agents, Routers, Writers, tools, services or source types.
- Do not read, log or commit document content, platform identifiers, Vault content, tokens or absolute private business paths.
- Do not ask the owner to upload the source again; the retained Task Source is the acceptance input.
- If the same task still times out at 300 seconds, stop and diagnose; do not raise the ceiling again.

---

### Task 1: Define the two-value Personal Assistant timeout contract

**Files:**
- Modify: `test/config.test.mjs`
- Modify: `src/config.mjs`

**Interfaces:**
- Consumes: `saveConfig(file, config)` and `loadConfig(file)` from `src/config.mjs`.
- Produces: schema-7 configurations whose `personalAssistant.aiTimeoutMs` is exactly `120000` or `300000`; every other value throws `invalid_personal_assistant`.

- [ ] **Step 1: Run the unchanged direct baseline**

Run:

```bash
/usr/local/bin/node --test test/config.test.mjs test/config-v6.test.mjs
```

Expected: PASS. Record the exact test count before changing tests.

- [ ] **Step 2: Add the failing schema-7 contract test**

Add this test to `test/config.test.mjs`:

```js
test("version 7 accepts only legacy and v445 Personal Assistant timeouts",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"llw-config-v445-timeout-"));
  const file=join(dir,"config.json");
  try {
    const withTimeout=aiTimeoutMs=>configV7({
      personalAssistant:{
        ...configV7().personalAssistant,
        aiTimeoutMs
      }
    });
    await saveConfig(file,withTimeout(120000));
    assert.equal(
      (await loadConfig(file)).personalAssistant.aiTimeoutMs,
      120000
    );
    await saveConfig(file,withTimeout(300000));
    assert.equal(
      (await loadConfig(file)).personalAssistant.aiTimeoutMs,
      300000
    );
    for (const value of [1,119999,120001,299999,300001]) {
      await assert.rejects(
        ()=>saveConfig(file,withTimeout(value)),
        /invalid_personal_assistant/
      );
    }
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
});
```

- [ ] **Step 3: Run RED and confirm the intended failure**

Run:

```bash
/usr/local/bin/node --test test/config.test.mjs
```

Expected: FAIL only when saving `aiTimeoutMs:300000`, with `invalid_personal_assistant`. If another assertion fails first, correct the test fixture before touching production code.

- [ ] **Step 4: Implement the minimal validator change**

Near the other configuration constants in `src/config.mjs`, add:

```js
const PERSONAL_ASSISTANT_AI_TIMEOUTS=new Set([120_000,300_000]);
```

Replace only the hardcoded Personal Assistant timeout predicate:

```js
!PERSONAL_ASSISTANT_AI_TIMEOUTS.has(value.aiTimeoutMs)||
```

Do not modify the invoice, knowledge-ingest or assistant-work validators.

- [ ] **Step 5: Run GREEN and the adjacent configuration contract**

Run:

```bash
/usr/local/bin/node --test test/config.test.mjs test/config-v6.test.mjs
```

Expected: PASS. The legacy 120-second fixtures and the new 300-second schema-7 case both pass.

- [ ] **Step 6: Commit the contract and implementation**

Run:

```bash
git add src/config.mjs test/config.test.mjs
git commit -m "fix: allow bounded personal assistant analysis time"
```

### Task 2: Lock the existing invoker ceiling without changing runtime code

**Files:**
- Modify: `test/personal-assistant-invoker.test.mjs`
- Verify unchanged: `src/personal-assistant/invoke-personal-assistant.mjs`
- Verify unchanged: `src/main.mjs`

**Interfaces:**
- Consumes: `invokePersonalAssistantCodex({timeoutMs})`, whose current validator accepts integer values from 1 through 300,000.
- Produces: regression evidence that exactly 300,000 ms is accepted and 300,001 ms is rejected before a child process can perform work.

- [ ] **Step 1: Add the upper-bound characterization test**

Add after the existing timeout test:

```js
test("accepts the exact 300-second Codex ceiling and rejects a larger value",async()=>{
  const response=JSON.stringify({
    type:"reply",
    reply:{text:"完成。"},
    ask:null,
    sourceReadRequest:null,
    toolCall:null,
    taskUpdate:null
  });
  await assert.doesNotReject(
    ()=>invokeSyntheticCodex({FAKE_RESPONSE:response},300000)
  );
  await assert.rejects(
    ()=>invokeSyntheticCodex({FAKE_RESPONSE:response},300001),
    /assistant_invocation_invalid/
  );
});
```

- [ ] **Step 2: Run the invoker and composition contracts**

Run:

```bash
/usr/local/bin/node --test test/personal-assistant-invoker.test.mjs test/main-composition.test.mjs
```

Expected: PASS. Confirm `git diff -- src/personal-assistant/invoke-personal-assistant.mjs src/main.mjs` is empty.

- [ ] **Step 3: Commit the characterization test**

Run:

```bash
git add test/personal-assistant-invoker.test.mjs
git commit -m "test: lock bounded Codex analysis ceiling"
```

### Task 3: Verify the complete candidate and record deployable evidence

**Files:**
- Create: `docs/evidence/2026-08-02-v445-bounded-ai-timeout-baseline.md`
- Create: `docs/reports/2026-08-02-v445-bounded-ai-timeout-candidate.md`
- Modify: `README.md`
- Verify unchanged: all files outside the approved V4.4.5 allowlist.

**Interfaces:**
- Consumes: Tasks 1–2 commits and the already deployed V4.4.4 safety journey.
- Produces: one immutable candidate commit, focused and complete regression evidence, exact changed-file list, rollback requirements and the statement that production still uses 120 seconds until deployment.

- [ ] **Step 1: Run the focused candidate set**

Run:

```bash
/usr/local/bin/node --test   test/config.test.mjs   test/config-v6.test.mjs   test/main-composition.test.mjs   test/personal-assistant-invoker.test.mjs   test/personal-assistant-task-session.test.mjs   test/personal-assistant-task-source-workspace.test.mjs   test/personal-assistant-save-knowledge.test.mjs   test/knowledge-writer.test.mjs   test/v444-feishu-cloud-document-ingest-journey.test.mjs
```

Expected: all pass. This set proves configuration, the 300-second invoker bound, current-task safety, Writer/Outcome contracts and the Feishu cloud-document journey.

- [ ] **Step 2: Run one complete regression because configuration is shared startup code**

Run:

```bash
/usr/local/bin/npm test
```

Expected: zero product failures. If only `test/video-timeline-reader-contract.test.mjs` fails with the already documented restricted-sandbox AVFoundation `Cannot Encode` condition, rerun that exact unchanged test once with normal local media permission and record both results; do not repeat the whole suite.

- [ ] **Step 3: Write the baseline evidence**

The evidence file must record only:

```markdown
# V4.4.5 Bounded AI Timeout Baseline

- Real failure: assistant_timeout at exactly 120000 ms
- Source preparation: passed; one retained DOCX
- Writer calls: 0
- Knowledge writes: 0
- Document shape: 2666430 bytes, 26 OOXML entries, 14 media entries,
  84340 document.xml bytes, approximately 6673 text characters
- Configuration before deployment: schema 7, personalAssistant.aiTimeoutMs 120000
- V4.4.4 safety inspector remains deployed
```

Do not include the document name, Task ID, message ID, user ID, chat ID, content or Vault path.

- [ ] **Step 4: Write the candidate report and README status**

The candidate report must include exact base/head commits, RED/GREEN results, focused and complete regression counts, changed-file allowlist, no-expanded-boundaries statement, rollback instructions and “not deployed” status. README must state that V4.4.5 is a bounded 300-second candidate and that the external system version remains V4.4.3 pending real acceptance.

- [ ] **Step 5: Self-check and commit candidate evidence**

Run:

```bash
git diff --check
git status --short
git diff --name-only a0f365e..HEAD
```

Expected changed files are limited to `src/config.mjs`, the two direct tests, the V4.4.5 spec/plan/evidence/report and `README.md`.

Commit:

```bash
git add README.md docs/evidence/2026-08-02-v445-bounded-ai-timeout-baseline.md docs/reports/2026-08-02-v445-bounded-ai-timeout-candidate.md
git commit -m "docs: record v4.4.5 bounded timeout candidate"
```

### Task 4: Build and verify the V4.4.4 rollback point

**Files:**
- Create outside Git: owner-only baseline under `/Users/ccrt/Library/Application Support/LLW Assistant/backups/baselines/`
- Read only: production component, configuration, state, Skill manifest and LaunchAgent.

**Interfaces:**
- Consumes: current V4.4.4 production component and schema-7 configuration with 120,000 ms.
- Produces: a verified baseline able to restore the exact pre-V4.4.5 component and configuration without copying logs, Keychain secrets or Vault content.

- [ ] **Step 1: Reconcile production before stopping**

Record only counts, modes and SHA-256 values for:

```text
one LaunchAgent
one Node main process
one direct lark-cli consumer
advancing heartbeat
config version 7 and state version 4
personalAssistant.aiTimeoutMs 120000
unchanged Skill manifest hash
zero unreplied Outcome
one retained DOCX Task Source
zero new knowledge write for the failed attempt
```

- [ ] **Step 2: Create the owner-only rollback baseline**

Create a unique directory matching:

```text
v445-bounded-ai-timeout-pre-deploy-20260802-XXXXXX
```

Set the directory to `0700` and artifacts to `0600`. Include:

```text
component-predeploy.tgz
config-predeploy.json
state-predeploy-live.tgz
skills-predeploy.tgz
com.llw.feishu-daily-work.plist
component-repository.bundle
SHA256SUMS
FILE_MODES
```

The state archive may remain only in this protected local baseline. Do not include normal logs, Vault files, document copies outside the already protected state snapshot, tokens or Keychain data.

- [ ] **Step 3: Restore-test in a fresh private directory**

Use `mktemp -d /private/tmp/llw-v445-rollback-restore.XXXXXX`, then verify:

```bash
shasum -a 256 -c SHA256SUMS
git -C /private/tmp/llw-v444-feishu-cloud-document-safety bundle verify component-repository.bundle
/usr/local/bin/node --test restored-component/test/config.test.mjs
```

Also compare the restored `src/config.mjs` and `config-predeploy.json` byte-for-byte with production. Do not stop the service until all checks pass.

### Task 5: Atomically deploy code and the one-field configuration change

**Files:**
- Modify in production: `src/config.mjs`
- Modify in production: direct V4.4.5 tests/docs/README from the verified candidate
- Modify in protected state: `config.json` field `personalAssistant.aiTimeoutMs` only.

**Interfaces:**
- Consumes: verified candidate and rollback point.
- Produces: the same single production service running schema 7 with `personalAssistant.aiTimeoutMs=300000`.

- [ ] **Step 1: Stop the existing service once and verify zero residual processes**

Run:

```bash
launchctl bootout gui/501 /Users/ccrt/Library/LaunchAgents/com.llw.feishu-daily-work.plist
```

Expected: service absent, zero LLW main process and zero matching lark consumer.

- [ ] **Step 2: Capture a stopped-state snapshot**

Add `state-predeploy-stopped.tgz` to the rollback directory, regenerate `SHA256SUMS` and `FILE_MODES`, and verify every hash.

- [ ] **Step 3: Atomically install only candidate allowlist files**

Use mode `0644`, owner `ccrt`, group `staff`; stage each file beside its destination and rename it over the exact target. Verify each production SHA-256 equals the candidate SHA-256.

- [ ] **Step 4: Atomically update the existing configuration through production code**

From the production component directory, set `V445_CONFIG` to the absolute
production config path and run:

```bash
/usr/local/bin/node --input-type=module -e '
  const {loadConfig,saveConfig}=await import("./src/config.mjs");
  const file=process.argv[1];
  const before=await loadConfig(file);
  const next=structuredClone(before);
  next.personalAssistant.aiTimeoutMs=300000;
  await saveConfig(file,next);
' "$V445_CONFIG"
```

Then verify:

```text
config version == 7
personalAssistant.aiTimeoutMs == 300000
every other JSON field equals config-predeploy.json
file mode == 0600
invoice.aiTimeoutMs == 120000
knowledge-ingest.aiTimeoutMs == 120000
assistant-work.aiTimeoutMs == 120000
```

- [ ] **Step 5: Run production-path focused tests before restart**

Run the Task 3 focused command from the production component directory. Expected: all pass.

- [ ] **Step 6: Start the same LaunchAgent once**

Run:

```bash
launchctl bootstrap gui/501 /Users/ccrt/Library/LaunchAgents/com.llw.feishu-daily-work.plist
```

Verify one main process, one direct Feishu consumer, advancing heartbeat, seven-file Skill load, no new startup error, unchanged state schema, unchanged Skill manifest, unchanged media gates, retained Task Source and unchanged knowledge fingerprint.

### Task 6: Complete the real retained-source acceptance

**Files:**
- No candidate code changes.
- Production state/knowledge changes only through the normal user-authorized workflow.

**Interfaces:**
- Consumes: the retained Task Session source and one authentic owner message `重试`.
- Produces: one current revision, one `save_knowledge` call, one KnowledgeWriter result, durable Outcome before one reply and no temporary residue.

- [ ] **Step 1: Ask for the only unavoidable owner action**

Ask the project owner to send exactly:

```text
重试
```

in the same private Feishu conversation. Do not ask for the document again and do not synthesize an inbound message.

- [ ] **Step 2: Monitor the journey without printing content or identifiers**

Verify:

```text
same Task Session source count == 1
no second export or second original-source copy
AI completes within <= 300000 ms
Writer reservation occurs only for the current revision
Outcome status == committed or existing
Outcome replied == true
artifact count == 1
knowledge file count increases once, or remains stable only for deterministic existing
preserved DOCX SHA-256 equals retained source SHA-256
temporary export/source staging is empty
no assistant_timeout or source_security_rejected for this revision
```

- [ ] **Step 3: End and clean the accepted task**

Ask the owner to send `任务结束`. Verify Task Session becomes inactive/empty and `task-sources` is cleaned without changing the published knowledge item.

### Task 7: Declare V4.4.5 and close Git/GitHub

**Files:**
- Modify: `README.md`
- Modify: `docs/reports/2026-08-02-v445-bounded-ai-timeout-candidate.md`
- Modify: `docs/superpowers/specs/2026-08-02-llw-personal-ai-v4.4.5-bounded-ai-timeout-design.md`
- Modify: root `.llw-system/README.md`
- Modify: root `.llw-system/SYSTEM_MAP.md`
- Modify: root `.llw-system/FEISHU_CLOUD_DOCUMENT_PERMISSION_AUDIT.md`
- Modify: root `docs/superpowers/specs/2026-08-01-llw-personal-ai-v4.5.0-feishu-cloud-knowledge-source-design.md`

**Interfaces:**
- Consumes: verified production evidence from Tasks 4–6.
- Produces: one authoritative V4.4.5 system version, accurate next-plan prerequisite, merged private GitHub history and a healthy production service.

- [ ] **Step 1: Update component and system facts**

Record exact candidate/merge commits, rollback path, focused/full regression counts, production config hash, one-process/one-consumer health, real Outcome status, Writer result, source hash equality and cleanup. Do not include private document content, names, IDs or Vault paths.

Update the V4.5.0 prerequisite from “V4.4.4 real acceptance” to “V4.4.5 real acceptance”, because V4.4.5 is the version that completes the journey.

- [ ] **Step 2: Run final verification before completion claims**

Run fresh:

```bash
git diff --check
git status --short
/usr/local/bin/node --test   test/config.test.mjs   test/config-v6.test.mjs   test/main-composition.test.mjs   test/personal-assistant-invoker.test.mjs   test/v444-feishu-cloud-document-ingest-journey.test.mjs
```

Also recheck production process uniqueness, heartbeat, configuration value, zero unreplied Outcome and empty task-source staging after task end.

- [ ] **Step 3: Commit final evidence**

Run:

```bash
git add README.md docs/reports/2026-08-02-v445-bounded-ai-timeout-candidate.md docs/superpowers/specs/2026-08-02-llw-personal-ai-v4.4.5-bounded-ai-timeout-design.md
git commit -m "docs: record v4.4.5 production acceptance"
```

- [ ] **Step 4: Publish through the private GitHub workflow**

Use the `github:yeet` workflow to push `fix/v445-personal-assistant-timeout`, open a draft PR against `main`, verify the PR diff contains the V4.4.4 safety commits plus V4.4.5 bounded-timeout commits, run required checks, mark ready and merge without force-push. Confirm remote `main` contains the merge commit.

- [ ] **Step 5: Finish the development branch**

Use `superpowers:verification-before-completion` and `superpowers:finishing-a-development-branch`. Only then report V4.4.5 complete and identify V4.5.0 as the next planned capability.
