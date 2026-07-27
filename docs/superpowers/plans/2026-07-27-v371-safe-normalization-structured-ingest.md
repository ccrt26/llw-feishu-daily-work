# V3.7.1 Safe Normalization and Structured Knowledge Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The owner has explicitly disabled subagents for this work.

**Goal:** Make knowledge ingest tolerate safe equivalent AI expressions, preserve one pending file intent per entry, and create a grounded three-layer knowledge item instead of only a summary plus extracted text.

**Architecture:** Keep one Dispatcher, Router, `knowledge-ingest` Capability, deterministic safety validator, and Writer. Insert one capability-local candidate normalizer between the AI candidate and the execution validator; keep binary/source preparation local; write fixed knowledge sections and preserve original Office or Feishu snapshot bytes according to program policy.

**Tech Stack:** Node.js 24 ESM, Node test runner, Python 3 OOXML extractor, JSON Schema draft-07, Codex CLI read-only semantic task, Git worktrees, macOS LaunchAgent, WPS local feasibility gate only.

## Global Constraints

- Product version is `V3.7.1`; do not create `R1/R2/R3/R4` documents.
- Do not add a second model, cloud Office service, AI plugin, automatic model fallback, database, queue, or long-running service.
- Keep `assistant-work=false`; do not implement it in this plan.
- Keep the existing library allowlist, managed-root boundary, path validation, owner-only permissions, symlink rejection, atomic publication, idempotency, and no-overwrite rules.
- Process exactly one source. Do not add generic PDF, image/OCR, macro Office, legacy Office, archive, script, or executable support.
- Program owns `knowledge.md`, the final path, knowledge ID, source hash, source preservation policy, time, permissions, and persistence.
- AI never receives binary Office bytes, absolute paths, raw platform events, credentials, resource keys, or unrelated private context.
- Feishu and WeChat share one core, but each entry can hold at most one independent 24-hour knowledge pending.
- Use targeted tests during development, one complete regression before deployment, and one minimal real AI Office sample.
- Do not use subagents.

---

### Task 1: Publish the V1.3.0 action-level private Skill contract

**Files:**
- Modify: `/private/tmp/llw-v371-skills/llw-knowledge-ingest/SKILL.md`
- Modify: `/private/tmp/llw-v371-skills/llw-knowledge-ingest/references/output-schema.json`
- Modify: `/private/tmp/llw-v371-skills/llw-knowledge-ingest/references/knowledge-note-contract.md`
- Modify: `/private/tmp/llw-v371-skills/llw-knowledge-ingest/references/format-policy.md`
- Modify: `/private/tmp/llw-v371-skills/llw-knowledge-ingest/references/source-integrity.md`
- Modify: `/private/tmp/llw-v371-skills/llw-knowledge-ingest/evals/cases.jsonl`
- Modify: `/private/tmp/llw-v371-skills/llw-knowledge-ingest/evals/adversarial.jsonl`
- Create: `/private/tmp/llw-v371-skills/private-evals/test_knowledge_ingest_v371.py`
- Modify: `/private/tmp/llw-v371-skills/private-evals/test_release_activation.py`
- Modify: `/private/tmp/llw-v371-skills/manifest.json`
- Regenerate: `/private/tmp/llw-v371-skills/private-evals/release-evidence.json`

**Interfaces:**
- Produces: `llw-knowledge-ingest` version `1.3.0`.
- Produces: one flat Codex-compatible candidate Schema whose only unconditional field is `action`; action payload fields are bounded but optional at the Schema layer and normalized locally.
- Produces actions: `await_file`, `commit`, `create_folder`, `ask_user`, `reject`.
- Produces commit-only `knowledge_sections` with `key_facts`, `structure_and_main_content`, `reusable_content`, `source_notes`, and `content_index`.
- Removes AI ownership of `note_file` and `preserve_source`.

- [ ] **Step 1: Write failing V3.7.1 Skill contract tests**

Add tests that assert:

```python
self.assertEqual(skill_version, "1.3.0")
self.assertEqual(schema["required"], ["action"])
self.assertIn("await_file", schema["properties"]["action"]["enum"])
self.assertNotIn("note_file", schema["properties"])
self.assertNotIn("preserve_source", schema["properties"])
self.assertEqual(
    set(schema["properties"]["knowledge_sections"]["properties"]),
    {
        "key_facts",
        "structure_and_main_content",
        "reusable_content",
        "source_notes",
        "content_index",
    },
)
```

Also assert the Skill and note contract require the three layers, fixed eight-section Writer order, exact source/AI distinction, and the local-reader/WPS boundary.

- [ ] **Step 2: Run the Skill test and verify RED**

Run:

```bash
/usr/bin/python3 -m unittest private-evals.test_knowledge_ingest_v371 -v
```

Expected: FAIL because version `1.2.1`, twelve common fields, and missing structured candidate fields still exist.

- [ ] **Step 3: Implement the minimal V1.3.0 Skill contract**

Use a flat draft-07 subset without `$ref`, `allOf`, `anyOf`, `const`, `definitions`, `if`, `then`, `else`, or `oneOf`. Keep bounds in Schema; keep cross-field and path safety in the Node normalizer/validator.

The candidate shape is:

```json
{
  "action": "commit",
  "confidence": "high",
  "reason_code": "ready",
  "library_key": "work-knowledge",
  "target": {
    "scope": "existing_folder",
    "segments": ["工作文档", "交流方案"],
    "origin": "user_explicit"
  },
  "title": "交流方案",
  "summary": "来源约束的摘要。",
  "tags": ["交流"],
  "knowledge_sections": {
    "key_facts": ["来源直接支持的事实"],
    "structure_and_main_content": "结构化主要内容。",
    "reusable_content": ["可复用内容"],
    "source_notes": "来源范围与限制。",
    "content_index": "本地提取内容索引。"
  },
  "source_integrity": "complete"
}
```

`ask_user` and `reject` do not carry irrelevant title, summary, tags, target, or knowledge sections. `await_file` carries only confirmed library and target context.

- [ ] **Step 4: Update synthetic evals and manifest hashes**

Use only fictional fixtures. Update the exact runtime file hashes, version, release activation, and release evidence. Do not store raw model outputs or private paths in the release evidence.

- [ ] **Step 5: Run all private Skill tests**

Run:

```bash
/usr/bin/python3 -m unittest discover -s private-evals -p 'test_*.py' -v
```

Expected: all tests pass.

- [ ] **Step 6: Commit the Skill contract**

```bash
git add llw-knowledge-ingest private-evals manifest.json
git commit -m "feat: define v371 structured knowledge candidate"
```

---

### Task 2: Normalize flexible AI candidates before strict execution validation

**Files:**
- Create: `src/capabilities/knowledge-ingest/candidate-normalizer.mjs`
- Modify: `src/capabilities/knowledge-ingest/decision-validator.mjs`
- Modify: `src/capabilities/knowledge-ingest/decision-client.mjs`
- Modify: `src/capabilities/knowledge-ingest/capability.mjs`
- Create: `test/knowledge-candidate-normalizer.test.mjs`
- Modify: `test/knowledge-decision-validator.test.mjs`
- Modify: `test/knowledge-decision-client.test.mjs`
- Modify: `test/knowledge-capability.test.mjs`

**Interfaces:**
- Produces:

```js
normalizeKnowledgeCandidate(candidate, {libraries, source})
```

- Returns a strict internal decision:

```js
{
  action,
  reasonCode,
  question,
  libraryKey,
  target:{scope,segments,origin},
  title,
  summary,
  tags,
  knowledgeSections,
  sourceIntegrity
}
```

- `validateKnowledgeDecision(normalized,{libraries,source})` accepts only this exact internal structure.

- [ ] **Step 1: Write failing normalizer tests**

Cover:

```js
normalizeKnowledgeCandidate({
  action:"commit",
  library_key:"personal-knowledge",
  folder_plan:{mode:"use_existing",segments:["日常生活"],origin:"user_explicit"},
  title:"示例",summary:"摘要",tags:[],
  knowledge_sections:sections,
  source_integrity:"complete"
},{libraries,source:completeSource})
```

Expected target: `{scope:"library_root",segments:[],origin:"user_explicit"}` when `日常生活` is the exact selected library display name or alias.

Also cover:

- new explicit `target.scope`;
- legacy `folder_plan`;
- exact display name/alias to one allowlisted library key;
- `ask_user` retaining one confirmed library without triggering a technical failure;
- `await_file` with confirmed library and target;
- omitted irrelevant fields;
- harmless empty legacy fields removed;
- unknown library, ambiguous alias, unknown action, path syntax, unconfirmed new folder, incomplete commit, and unknown fields rejected.

- [ ] **Step 2: Run the normalizer tests and verify RED**

Run:

```bash
/usr/local/bin/node --test test/knowledge-candidate-normalizer.test.mjs
```

Expected: FAIL because `candidate-normalizer.mjs` does not exist.

- [ ] **Step 3: Implement deterministic candidate normalization**

Implement only enumerated transformations. Do not read the user message and do not call a model. Reject ambiguous or unsafe values. Map legacy root expressions only when the selected library and the single repeated display/alias segment are an exact one-to-one match.

- [ ] **Step 4: Write failing strict-validator and client integration tests**

Assert the execution validator accepts only normalized results and that `decision-client` parses, normalizes, and validates one candidate before returning. Assert parse/process errors remain technical failures, while safe equivalents do not trigger another AI call.

- [ ] **Step 5: Implement strict normalized validation and client integration**

Remove the duplicate raw-candidate validation path. Keep a second strict normalized validation in the Capability so injected/mocked decisions cannot bypass the execution contract.

- [ ] **Step 6: Run targeted candidate tests**

Run:

```bash
/usr/local/bin/node --test \
  test/knowledge-candidate-normalizer.test.mjs \
  test/knowledge-decision-validator.test.mjs \
  test/knowledge-decision-client.test.mjs \
  test/knowledge-capability.test.mjs
```

Expected: all tests pass.

- [ ] **Step 7: Commit candidate normalization**

```bash
git add src/capabilities/knowledge-ingest test/knowledge-candidate-normalizer.test.mjs test/knowledge-decision-validator.test.mjs test/knowledge-decision-client.test.mjs test/knowledge-capability.test.mjs
git commit -m "feat: normalize safe knowledge candidates"
```

---

### Task 3: Preserve one source-bound pending per Feishu and WeChat entry

**Files:**
- Modify: `src/state-store.mjs`
- Modify: `src/core/dispatcher.mjs`
- Modify: `src/capabilities/knowledge-ingest/capability.mjs`
- Modify: `src/capabilities/knowledge-ingest/receipt.mjs`
- Modify: `test/state-store.test.mjs`
- Modify: `test/dispatcher.test.mjs`
- Modify: `test/knowledge-capability.test.mjs`

**Interfaces:**
- Produces:

```js
state.getKnowledgePending(source, nowMs)
state.setKnowledgePending({
  source, startedAt, model, libraryKey,
  target:{scope,segments,origin}
})
state.clearKnowledgePending(source)
```

- Valid sources are exactly `feishu` and `wechat`.
- Pending contains no message body, platform ID, resource key, file bytes, token, or absolute path.

- [ ] **Step 1: Write failing source-bound StateStore tests**

Assert Feishu and WeChat can each hold one pending, cannot replace their own open pending, do not consume or clear the other entry, expire independently after 24 hours, and migrate the old empty `{pending:null}` slot to the new source map.

- [ ] **Step 2: Run StateStore tests and verify RED**

Run:

```bash
/usr/local/bin/node --test test/state-store.test.mjs
```

Expected: FAIL because the current store has one global pending containing the raw request.

- [ ] **Step 3: Implement exact source-bound pending storage**

Persist only the confirmed normalized target. Safely drop an old non-null unbound pending during migration rather than guessing an entry. Production deployment must first verify no open pending exists.

- [ ] **Step 4: Write failing Dispatcher bypass tests**

Cover:

- Feishu pending + Feishu Office attachment bypasses Router and invokes `knowledge-ingest`;
- WeChat pending + WeChat attachment does the same;
- cross-entry attachment does not consume the other pending;
- two entries can wait concurrently;
- cancellation and new task clear only the current entry;
- duplicate attachment does not rerun AI or Writer;
- pending response uses `awaiting_attachment`, so no global Router conversation is created.

- [ ] **Step 5: Implement the pending-first Dispatcher path**

After security and duplicate checks, before model command and Router:

```js
const pending=await state.getKnowledgePending(message.source, receivedAt);
if (pending && isSingleSupportedKnowledgeFile(message)) {
  return runNamedCapability("knowledge-ingest", message, {
    state,
    model:pending.model,
    knowledgePending:pending
  });
}
```

Do not bypass security, idempotency, capability enablement, source binding, or file validation.

- [ ] **Step 6: Update Capability and receipts**

`await_file` stores confirmed normalized context and returns `awaiting_attachment`. The attachment path uses injected `knowledgePending`, downloads/prepares once, and clears only its source on terminal success/rejection.

- [ ] **Step 7: Run targeted state/dispatcher/capability tests**

Run:

```bash
/usr/local/bin/node --test \
  test/state-store.test.mjs \
  test/dispatcher.test.mjs \
  test/knowledge-capability.test.mjs
```

Expected: all tests pass.

- [ ] **Step 8: Commit source-bound pending**

```bash
git add src/state-store.mjs src/core/dispatcher.mjs src/capabilities/knowledge-ingest test/state-store.test.mjs test/dispatcher.test.mjs test/knowledge-capability.test.mjs
git commit -m "feat: bind knowledge pending to each entry"
```

---

### Task 4: Create grounded three-layer knowledge notes and fail closed on unread visual structure

**Files:**
- Modify: `src/capabilities/knowledge-ingest/ooxml_processor.py`
- Modify: `src/capabilities/knowledge-ingest/office-source-preparer.mjs`
- Modify: `src/capabilities/knowledge-ingest/source-preparer.mjs`
- Modify: `src/capabilities/knowledge-ingest/knowledge-writer.mjs`
- Modify: `src/capabilities/knowledge-ingest/capability.mjs`
- Modify: `test/knowledge-office-source-preparer.test.mjs`
- Modify: `test/knowledge-source-preparer.test.mjs`
- Modify: `test/knowledge-writer.test.mjs`
- Modify: `test/knowledge-capability.test.mjs`
- Create: `docs/V371_WPS_LOCAL_READER_GATE.md`

**Interfaces:**
- Prepared source adds:

```js
extractionIntegrity: "complete" | "partial"
extractionLimitations: string[]
```

- Writer `commit` adds:

```js
knowledgeSections:{
  keyFacts:string[],
  structureAndMainContent:string,
  reusableContent:string[],
  sourceNotes:string,
  contentIndex:string
}
```

- Program policy preserves original bytes for `file` and `feishu_document`; direct text is preserved inside `knowledge.md` without a duplicate `source.txt`.

- [ ] **Step 1: Write failing OOXML extraction-integrity tests**

Create synthetic fixtures for:

- text-only DOCX/PPTX/XLSX → `complete`;
- media/chart/drawing/speaker-note/comment/external structure detected → `partial` with bounded reason codes;
- existing macro, encryption, external relationship, archive, size, row, sheet, slide, and unsafe XML rejections unchanged.

- [ ] **Step 2: Run Office preparer tests and verify RED**

Run:

```bash
/usr/local/bin/node --test test/knowledge-office-source-preparer.test.mjs
```

Expected: FAIL because extraction integrity metadata is absent.

- [ ] **Step 3: Implement bounded extraction evidence**

The Python extractor returns exact format, content, integrity, and bounded limitation codes. Node validates the exact object and passes only textual evidence and safe metadata to AI.

- [ ] **Step 4: Write failing eight-section Writer tests**

Assert exact frontmatter plus:

```markdown
# 标题
## 摘要
## 关键事实
## 结构与主要内容
## 可复用内容
## 来源说明
## 结构化原文或内容索引
### 本地读取器提取内容
```

Assert source bytes remain byte-identical, direct text has no duplicate source file, AI sections never replace the extracted source, and unsafe section values are rejected.

- [ ] **Step 5: Implement fixed Writer rendering**

Program generates frontmatter and headings. Escape or normalize bounded text; do not allow candidate-provided frontmatter, paths, or filenames. Include extraction limitations in source notes and append the exact extracted text under the final section.

- [ ] **Step 6: Fail closed before AI for partial local extraction**

When the local reader reports `partial`, do not spend a model call. Return one explicit bounded clarification/rejection explaining that visual or structural content could not be fully read. Do not clear the other entry pending.

- [ ] **Step 7: Run the WPS local feasibility gate**

Inspect only the installed WPS application, bundle metadata, documented local command/automation surface, offline export behavior, timeout, and temporary cleanup. Do not grant new permissions or upload files. Record one of:

- `enabled`: a fixed, testable local render/export contract exists; or
- `disabled`: no stable protected automation contract is available, so complex visual Office input remains `partial`.

- [ ] **Step 8: Run targeted source/Writer/Capability tests**

Run:

```bash
/usr/local/bin/node --test \
  test/knowledge-source-preparer.test.mjs \
  test/knowledge-office-source-preparer.test.mjs \
  test/knowledge-writer.test.mjs \
  test/knowledge-capability.test.mjs
```

Expected: all tests pass.

- [ ] **Step 9: Commit structured knowledge persistence**

```bash
git add src/capabilities/knowledge-ingest test/knowledge-source-preparer.test.mjs test/knowledge-office-source-preparer.test.mjs test/knowledge-writer.test.mjs test/knowledge-capability.test.mjs docs/V371_WPS_LOCAL_READER_GATE.md
git commit -m "feat: persist structured grounded knowledge"
```

---

### Task 5: Bind Skill V1.3.0, verify atomically, and prepare deployment

**Files:**
- Modify: `src/main.mjs`
- Modify: `test/main-composition.test.mjs`
- Modify: `test/private-skill-manifest.test.mjs` only if fixture expectations require the new version.
- Create: `docs/V371_SAFE_NORMALIZATION_ACCEPTANCE.md`
- Modify after deployment: `/Volumes/ZHUTONG/LLW的私人助手/LLW/.llw-system/SYSTEM_MAP.md`

**Interfaces:**
- Component allowlist accepts exactly `llw-knowledge-ingest` version `1.3.0`.
- Skill and component are deployed together; old/new Schema and runtime are not cross-compatible.

- [ ] **Step 1: Write failing version-binding tests**

Assert `src/main.mjs` allows exactly `1.3.0` and the current runtime rejects `1.2.1`.

- [ ] **Step 2: Run version-binding tests and verify RED**

Run:

```bash
/usr/local/bin/node --test test/main-composition.test.mjs test/private-skill-manifest.test.mjs
```

Expected: FAIL because the allowlist is still `1.2.1`.

- [ ] **Step 3: Update the exact Skill version binding**

Change only the knowledge Skill version. Keep all other capability and model gates unchanged.

- [ ] **Step 4: Run proportional targeted verification**

Run:

```bash
/usr/local/bin/node --test \
  test/knowledge-candidate-normalizer.test.mjs \
  test/knowledge-decision-validator.test.mjs \
  test/knowledge-decision-client.test.mjs \
  test/knowledge-capability.test.mjs \
  test/knowledge-source-preparer.test.mjs \
  test/knowledge-office-source-preparer.test.mjs \
  test/knowledge-writer.test.mjs \
  test/state-store.test.mjs \
  test/dispatcher.test.mjs \
  test/main-composition.test.mjs \
  test/private-skill-manifest.test.mjs
```

- [ ] **Step 5: Run one bounded real Codex candidate smoke test**

Use one fictional text or small text-only DOCX in an isolated synthetic Vault. Verify the deployed Schema is accepted, one candidate normalizes, the Writer creates all fixed sections, and no raw/private identifiers are logged. Do not repeat the AI call for PPTX and XLSX.

- [ ] **Step 6: Run complete component and Skill regressions**

Run:

```bash
/usr/local/bin/npm test
```

Run:

```bash
/usr/bin/python3 -m unittest discover -s private-evals -p 'test_*.py' -v
```

Expected: zero failures.

- [ ] **Step 7: Commit final component binding and acceptance record**

```bash
git add src/main.mjs test docs/V371_SAFE_NORMALIZATION_ACCEPTANCE.md
git commit -m "feat: bind v371 knowledge ingest"
```

- [ ] **Step 8: Push both validated feature branches**

```bash
git push -u origin agent/v371-knowledge-skill
git push -u origin agent/v371-safe-normalization
```

- [ ] **Step 9: Build and restore-test one protected pre-deploy rollback point**

Include component and Skills Git bundles, exact commits, protected config/state, LaunchAgent, current Skill manifest, hashes, restore evidence, and no Vault content, ordinary logs, credentials, platform identifiers, or message bodies.

- [ ] **Step 10: Deploy atomically**

Before deployment verify:

- no open knowledge pending;
- one LaunchAgent and one actual Feishu event consumer;
- current model and capability flags;
- clean production and Skill worktrees;
- rollback manifest complete.

Deploy the validated component commit and Skill V1.3.0 together, update protected manifest/config hashes, restart the existing LaunchAgent once, and verify heartbeat and process topology.

- [ ] **Step 11: Run post-deploy tests and synthetic Vault acceptance**

Run the knowledge targeted suite in the deployed component. Use synthetic text, DOCX, root, existing folder, suggested folder confirmation, dangerous path rejection, per-entry pending isolation, idempotency, source hash equality, exact permissions, and zero temporary residue.

- [ ] **Step 12: Complete minimal real entry acceptance**

Use:

- one Feishu text two-stage flow;
- one WeChat text-only DOCX two-stage flow;
- one entry-isolation check;
- one explicit cancellation or safe rejection.

Verify outcomes are persisted before replies, artifacts contain the fixed knowledge sections, source bytes match for Office, no duplicate writes occur, logs contain no bodies/IDs/credentials/paths, and service health remains normal.

- [ ] **Step 13: Update the system map and final acceptance record**

Record exact product/Skill/component versions, commits, test counts, rollback location, WPS gate result, enabled capabilities, process health, and bounded acceptance outcomes. Do not record message bodies or platform identifiers.
