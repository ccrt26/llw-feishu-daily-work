# V3.7.0 Minimal Knowledge Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a disabled-by-default, fully tested knowledge-ingest runtime for direct text, TXT, Markdown, managed empty folders, deterministic Obsidian writes, and reply recovery.

**Architecture:** Keep one Dispatcher and static Capability Registry. A Codex-only semantic task returns the private Skill's strict decision; Node.js validates the decision, resolves only configured managed roots, prepares one source once, and publishes one immutable knowledge item atomically. Production paths and aliases remain private configuration values.

**Tech Stack:** Node.js 24 ESM, `node:test`, private Markdown Skills, strict JSON contracts, filesystem SHA-256 and atomic rename.

## Global Constraints

- Follow V3.7.0 R4 and `docs/superpowers/specs/2026-07-26-v370-minimal-knowledge-ingest-design.md`.
- Do not modify invoice, daily-work, PDFium, binding, model-switch, or existing Vault behavior.
- Do not expose private Skill content, real paths, real examples, identifiers, credentials, or source text in public fixtures, state, or logs.
- Keep `knowledge-ingest` disabled in the public allowlist, private manifest, production config, and production registry.
- New behavior must follow RED-GREEN-REFACTOR; run only relevant tests until the final phase gate.
- Use no subagents, as directed by the project owner.

---

### Task 1: Private Skill Library Catalog Contract

**Files:**
- Modify: private `llw-knowledge-ingest/SKILL.md`
- Modify: private `llw-knowledge-ingest/references/output-schema.json`
- Modify: private `llw-knowledge-ingest/evals/cases.jsonl`
- Modify: private `private-evals/test_knowledge_ingest_r4.py`
- Modify: private `manifest.json`
- Modify: private `private-evals/release-evidence.json`

**Interfaces:**
- Consumes: `allowed_libraries: Array<{library_key,display_name,aliases,existing_folders}>`
- Produces: existing `commit | create_folder | ask_user | reject` decision
- Rule: a unique existing folder may be `skill_suggested + use_existing`; a new Skill-suggested folder still requires confirmation

- [ ] **Step 1: Add failing private evals**

Add cases proving that a safe display alias can select an opaque key, one unique existing folder can be reused without confirmation, multiple matching folders ask once, and a suggested missing folder returns `folder_confirmation_required`.

- [ ] **Step 2: Verify RED**

Run:

```bash
/usr/bin/python3 -m unittest private-evals/test_knowledge_ingest_r4.py private-evals/test_manifest.py
```

Expected: failures for the unimplemented library catalog and existing-folder rules.

- [ ] **Step 3: Make the minimum Skill and Schema change**

Keep absolute paths forbidden. Allow `commit.folder_plan.origin=skill_suggested` only when
`folder_plan.mode=use_existing`; preserve confirmation for every Skill-suggested
`create_if_missing`.

- [ ] **Step 4: Regenerate manifest and release evidence**

Update the Skill minor version, all runtime hashes, and the private eval bundle hash from the
final files.

- [ ] **Step 5: Verify GREEN**

Run the target evals, manifest validator, release-evidence test, and Skill quick validation.

- [ ] **Step 6: Commit privately**

Commit on `integration/v370-skills`; do not merge private `main` or enable the Skill.

---

### Task 2: Strict Knowledge Configuration and Managed Library Catalog

**Files:**
- Modify: `src/config.mjs`
- Modify: `src/migrate-config-v5.mjs`
- Create: `src/capabilities/knowledge-ingest/library-catalog.mjs`
- Modify: `test/config.test.mjs`
- Modify: `test/migrate-config-v5.test.mjs`
- Create: `test/knowledge-library-catalog.test.mjs`

**Interfaces:**
- Produces:

```js
{
  enabled: false,
  tempRoot: "/absolute/private/jobs",
  libraries: [{
    libraryKey: "work-knowledge",
    displayName: "Synthetic Work",
    aliases: ["Synthetic Work Library"],
    root: "/absolute/vault/work"
  }],
  maxSourceBytes: 262144,
  aiTimeoutMs: 120000,
  inputFormats: ["text", "txt", "md"]
}
```

- `createKnowledgeLibraryCatalog(configuration)` returns AI-safe descriptors and keeps roots private.

- [ ] **Step 1: Write failing strict-config tests**

Reject unknown fields, duplicate keys/aliases/roots, nested roots, unsafe aliases, non-absolute roots,
unsupported formats, unsafe limits, and version-5 configurations missing the disabled capability.

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test test/config.test.mjs test/migrate-config-v5.test.mjs
```

Expected: version-5 knowledge configuration is rejected or absent.

- [ ] **Step 3: Implement the version-5 candidate shape**

Extend only version 5. Version 4 remains byte-for-byte compatible. Migration accepts explicit private
arguments and writes `knowledge-ingest.enabled=false`.

- [ ] **Step 4: Write failing catalog safety tests**

Use a synthetic Vault. Assert bounded depth/count, no hidden/system folders, no symlinks, no absolute
paths in AI descriptors, and exact configured-root containment.

- [ ] **Step 5: Implement catalog enumeration and verify GREEN**

The catalog returns:

```js
{
  libraryKey,
  displayName,
  aliases,
  existingFolders: [["category"], ["category", "topic"]]
}
```

Run the three target files.

- [ ] **Step 6: Commit**

Commit public configuration and catalog changes without production values.

---

### Task 3: Prepared Source and Strict Knowledge Decision

**Files:**
- Create: `src/capabilities/knowledge-ingest/source-preparer.mjs`
- Create: `src/capabilities/knowledge-ingest/decision-validator.mjs`
- Create: `src/capabilities/knowledge-ingest/decision-client.mjs`
- Modify: `src/core/semantic-tasks.mjs`
- Create: `test/knowledge-source-preparer.test.mjs`
- Create: `test/knowledge-decision-validator.test.mjs`
- Create: `test/knowledge-decision-client.test.mjs`
- Modify: `test/semantic-tasks.test.mjs`

**Interfaces:**
- `prepareKnowledgeText({text,maxSourceBytes}) -> PreparedKnowledgeSource`
- `validateKnowledgeDecision(value,{allowedLibraryKeys,existingFolders}) -> decision`
- `createKnowledgeIngestTask(configuration) -> async input => decision`

- [ ] **Step 1: Write failing source and validator tests**

Cover exact fields, size/hash, UTF-8 text, every action's conditional fields, safe folder segments,
allowlisted keys, existing-folder proof, and rejection of absolute paths, unknown fields, unsafe
confidence, unsafe suggested folders, move/delete/overwrite semantics, and fabricated catalog entries.

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test test/knowledge-source-preparer.test.mjs test/knowledge-decision-validator.test.mjs
```

Expected: modules are missing.

- [ ] **Step 3: Implement minimum preparation and validation**

Use literal strict field sets and deterministic validation; do not rely on the model's Schema alone.

- [ ] **Step 4: Write and verify RED for the Codex client**

The fake Codex fixture must prove:

```text
Codex-only
read-only sandbox
selected private Skill
strict output Schema
no platform identifiers
no absolute managed roots
no unrelated Vault access in prompt
```

- [ ] **Step 5: Implement client and semantic-task factory**

Retry at most the existing bounded Codex attempt policy. Classify output failures without including
source text or paths.

- [ ] **Step 6: Verify GREEN and commit**

Run the four target test files and commit.

---

### Task 4: Immutable Knowledge Writer

**Files:**
- Create: `src/capabilities/knowledge-ingest/knowledge-writer.mjs`
- Create: `test/knowledge-writer.test.mjs`

**Interfaces:**
- `new KnowledgeWriter({vaultRoot,libraries})`
- `createFolder({libraryKey,segments})`
- `commit({libraryKey,folderSegments,title,summary,tags,source,skillVersion,preserveSource})`

- [ ] **Step 1: Write failing writer tests**

Use a synthetic Vault and hand-derived expected Markdown. Cover:

- new direct-text item;
- stable `knowledge_id`;
- duplicate source returns `existing`;
- same title/different source gets a non-overwriting hash suffix;
- work and life roots remain disjoint;
- user-explicit empty folder creation and existing-folder idempotency;
- missing Vault marker, path escape, hidden/reserved segment, symlink component and root mismatch;
- staging failure leaves no item;
- concurrent publication never overwrites;
- final file modes, ordinary-file identity, fixed file list and hash verification.

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test test/knowledge-writer.test.mjs
```

Expected: module is missing.

- [ ] **Step 3: Implement minimal atomic writer**

Derive:

```js
knowledgeId = sha256(`${libraryKey}\0${source.sha256}`)
```

Render deterministic YAML and Markdown, stage under the final parent, fsync files, and atomically rename
without modifying an existing item.

- [ ] **Step 4: Verify GREEN and commit**

Run only the writer and managed-folder tests, then commit.

---

### Task 5: Knowledge Capability, Pending File Intent, and Receipts

**Files:**
- Create: `src/capabilities/knowledge-ingest/capability.mjs`
- Create: `src/capabilities/knowledge-ingest/receipt.mjs`
- Modify: `src/state-store.mjs`
- Create: `test/knowledge-capability.test.mjs`
- Modify: `test/state-store.test.mjs`

**Interfaces:**
- `createKnowledgeIngestCapability({decide,writer,catalog,sourcePreparer,skillVersion})`
- Bounded state slot:

```js
{
  pending: null | {
    request: "bounded user request",
    startedAt: "ISO timestamp",
    model: "codex"
  }
}
```

- [ ] **Step 1: Write failing StateStore tests**

Prove exact shape, 24-hour expiry, fixed model, one pending request, no attachment bytes/path/platform
identifier, migration from existing version 4, and explicit clear after success/reject/cancel.

- [ ] **Step 2: Verify RED**

Run the StateStore target tests and confirm the missing API failure.

- [ ] **Step 3: Implement minimum strict state methods**

Keep state version 4. Do not reuse daily-work conversation or Task Session storage.

- [ ] **Step 4: Write failing capability tests**

Cover direct text commit, create-folder, existing, ask-user, reject, technical failure, Codex-only
enforcement, zero writer calls on unsafe decisions, pending “send one file” intent, and exact fixed
receipts without absolute paths.

- [ ] **Step 5: Implement capability and receipts**

The capability returns only existing Dispatcher statuses and relative artifacts. It never sends messages
or writes state outcomes itself.

- [ ] **Step 6: Verify GREEN and commit**

Run capability and StateStore targets.

---

### Task 6: TXT/Markdown Single-Download Integration

**Files:**
- Modify: `src/adapters/wechat-resource-downloader.mjs`
- Reuse: `src/adapters/lark-resource-downloader.mjs`
- Modify: `src/capabilities/knowledge-ingest/source-preparer.mjs`
- Modify: `test/wechat-resource-downloader.test.mjs`
- Modify: `test/lark-resource-downloader.test.mjs`
- Modify: `test/knowledge-source-preparer.test.mjs`
- Modify: `test/knowledge-capability.test.mjs`

**Interfaces:**
- WeChat downloader gains an explicit `allowedFileExtensions` option whose default remains `["pdf"]`.
- `prepareKnowledgeFile({file,displayName,extension,maxSourceBytes})` accepts only verified TXT/Markdown.

- [ ] **Step 1: Write failing adapter and preparer tests**

Cover valid UTF-8 TXT/Markdown, extension mismatch, NUL/binary content, invalid UTF-8, oversized files,
symlinks, extra download outputs, unsupported Office/PDF, one download, and cleanup on every result.

- [ ] **Step 2: Verify RED**

Run the three target files and confirm that WeChat TXT/Markdown and knowledge preparation fail.

- [ ] **Step 3: Implement minimum extension allowlist and file preparation**

Preserve invoice's default PDF-only behavior and all existing PDF magic checks.

- [ ] **Step 4: Add pending-intent integration tests**

Prove “save the next file” followed by one TXT/Markdown attachment reuses the stored bounded request,
calls one semantic task, writes once, clears pending state, and produces one outcome.

- [ ] **Step 5: Verify GREEN and commit**

Run adapter, preparer, capability, invoice download, and privacy targets.

---

### Task 7: Disabled Runtime Composition and Shared Dispatcher

**Files:**
- Modify: `src/capabilities/index.mjs`
- Modify: `src/main.mjs`
- Modify: `src/core/dispatcher.mjs`
- Modify: `test/capability-registry.test.mjs`
- Modify: `test/main-composition.test.mjs`
- Modify: `test/dispatcher.test.mjs`
- Modify: `test/core-routing.test.mjs`
- Modify: `test/privacy.test.mjs`

**Interfaces:**
- Static registry can accept a `knowledgeIngest` handler only when explicitly enabled.
- Main validates the private Skill version and generic configuration but does not register it while both
  allowlist and production config remain disabled.
- Dispatcher reuses the existing outcome-before-reply path.

- [ ] **Step 1: Write failing registry and composition tests**

Assert the disabled capability is absent, enabled synthetic composition has exactly one extra capability,
and private Skill content/roots are not returned or logged.

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test test/capability-registry.test.mjs test/main-composition.test.mjs
```

- [ ] **Step 3: Implement minimum static wiring**

Do not add dynamic plugins, new listeners, a second Dispatcher, production configuration changes, or
knowledge-specific keyword routing.

- [ ] **Step 4: Write failing shared-dispatch tests**

Prove Feishu and WeChat synthetic messages use the same handler; duplicate outcome does not rerun AI or
Writer; reply failure resumes the same stored result; explicit daily-work/invoice remains unchanged.

- [ ] **Step 5: Implement only required Dispatcher recovery fields**

Do not add file reply support in this phase.

- [ ] **Step 6: Verify GREEN and commit**

Run the registry, composition, dispatcher, routing, state, privacy, daily-work, invoice and PDF integration
target group.

---

### Task 8: Phase Verification, Evidence, and Push

**Files:**
- Modify: `docs/PROJECT_OVERVIEW.md` only with public candidate facts
- Modify: private release evidence only with private hashes and results

**Interfaces:**
- No production mutation

- [ ] **Step 1: Run private final targets**

Run all private contract/eval/manifest/quick-validation tests once.

- [ ] **Step 2: Run public target group**

Run all new and directly affected tests. Fix only failures caused by this phase.

- [ ] **Step 3: Run one complete public regression**

Run:

```bash
/usr/local/bin/npm test
```

Expected: all tests pass, zero skipped/cancelled.

- [ ] **Step 4: Cross-load actual private integration**

Validate manifest hash, runtime file hashes, owner/modes, versions, disabled flags, and public allowlist
without printing Skill content.

- [ ] **Step 5: Run privacy, diff, and rollback-isolation checks**

Confirm no real directory, source content, identifier or secret entered public Git; restore the candidate
component and Skills into fresh private temporary directories and run the bounded verification there.

- [ ] **Step 6: Push only integration branches**

Push `integration/v370-skills` and `integration/v370`. Do not merge `main`, create a PR, migrate production
configuration, restart, enable, or delete candidate branches.

- [ ] **Step 7: Report**

Report commits, RED/GREEN counts, full regression count, evidence hashes, unchanged production facts, and
the remaining Office/Feishu-document phase.
