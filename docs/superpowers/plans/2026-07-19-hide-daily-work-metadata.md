# Portable Hidden Daily-Work Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove all internal IDs and encoded data from user-facing daily Markdown while preserving portable supplementation, ordering, deduplication, migration safety, and Beijing-time behavior.

**Architecture:** The U drive keeps human-readable Markdown plus a hidden, versioned `RecordStore` index under `.llw-system/indexes/feishu-daily-work/records.json`; the Mac keeps Feishu identities, message IDs, write reservations, runtime state, logs, and backups. Writes reserve stable random IDs locally, commit the portable index atomically, render clean Markdown, verify hashes, and finalize pending renders.

**Tech Stack:** Node.js 24 ESM, built-in `node:test`, `node:fs/promises`, JSON, Markdown, macOS LaunchAgent, Obsidian Vault.

## Global Constraints

- All business dates and relative times use `Asia/Shanghai`.
- Each Beijing calendar day uses only `亚信工作/每日工作/YYYY年MM月DD日/工作记录.md`.
- User-facing Markdown must contain no `llw-record-*` marker, Base64 management line, record ID, sort key, or index path.
- The U-drive index may contain only record/document metadata; it must contain no App ID, App Secret, token, user ID, chat ID, Feishu message ID, or complete Feishu event.
- Programs, CLI, dependencies, credentials, message deduplication, conversations, logs, heartbeats, migration backups, and write reservations stay on the Mac.
- Index and local state files use mode `0600`; their directories use mode `0700`.
- Never overwrite a manually changed Markdown file: stop on a hash mismatch not covered by a pending render.
- Preserve every organized record, follow-up, initial verbatim source, and supplemental verbatim source during migration.
- Use TDD for every behavior change and keep existing behavior tests passing.

---

## File Map

- Create `src/record-store.mjs`: validate, read, atomically replace, and finalize the portable U-drive index.
- Modify `src/managed-record.mjs`: retain strict legacy parsing for migration and add a clean Markdown renderer with no internal metadata.
- Modify `src/state-store.mjs`: migrate state to version 3 and persist stable local write reservations.
- Modify `src/service.mjs`: reserve writes before touching the U drive and resume them without a second AI decision.
- Modify `src/vault-writer.mjs`: consume reserved random IDs, update `RecordStore`, render Markdown, and recover pending renders.
- Modify `src/record-catalog.mjs`: list candidates from `RecordStore`, not Markdown comments.
- Modify `src/main.mjs`: open the portable index and resume pending writes before normal replies/listening.
- Create `src/migrate-record-index.mjs`: back up and migrate legacy comment-based files.
- Create `test/record-store.test.mjs` and `test/migrate-record-index.test.mjs`.
- Modify existing managed-record, state-store, service, writer, catalog, and config tests.
- Modify `.agents/skills/feishu-daily-work/references/markdown-rules.md` in the U-drive workspace after code verification.
- Modify `.llw-system/SYSTEM_MAP.md` after live migration succeeds.

---

### Task 1: Clean Renderer and Portable RecordStore

**Files:**
- Create: `src/record-store.mjs`
- Create: `test/record-store.test.mjs`
- Modify: `src/managed-record.mjs`
- Modify: `test/managed-record.test.mjs`

**Interfaces:**
- Produces: `RecordStore.open(vaultRoot)`, `store.snapshot()`, `store.replace(expectedRevision, next)`, `store.finalizeRenders(expectedRevision, dates)`.
- Produces: `renderReadableDocument(date, entries)` and `parseLegacyManagedDocument(markdown, date)`.
- Index shape: `{version: 1, revision: number, records: Entry[], documents: Record<string,string>, pendingRenders: Record<string,{beforeHash:string,afterHash:string}>}`.

- [ ] **Step 1: Write failing clean-renderer tests**

Add assertions to `test/managed-record.test.mjs`:

```js
test("renders user-only markdown without internal metadata", () => {
  const markdown = renderReadableDocument("2026-07-18", [entry()]);
  assert.match(markdown, /^# 2026年07月18日工作记录/m);
  assert.match(markdown, /^## 记录 1｜16:30–17:30｜标品订单RV会议$/m);
  assert.match(markdown, /> \[!quote\]- 原始内容 1｜首次记录/);
  assert.doesNotMatch(markdown, /llw-record-|90f29b02eb9ec9bb|20260718-1630|base64/i);
});

test("keeps strict legacy parsing only for migration", () => {
  const legacy = renderLegacyManagedDocument("2026-07-18", [entry()]);
  assert.deepEqual(parseLegacyManagedDocument(legacy, "2026-07-18"), [entry()]);
});
```

- [ ] **Step 2: Run the focused renderer tests and verify failure**

Run: `node --test test/managed-record.test.mjs`

Expected: FAIL because `renderReadableDocument`, `renderLegacyManagedDocument`, and `parseLegacyManagedDocument` are not exported.

- [ ] **Step 3: Split legacy parsing from clean rendering**

In `src/managed-record.mjs`, rename the existing encoded renderer/parser to explicit legacy names and add:

```js
export function renderReadableDocument(date, entries) {
  validateDocument(date, entries);
  const heading = `# ${date.slice(0, 4)}年${date.slice(5, 7)}月${date.slice(8, 10)}日工作记录`;
  const blocks = entries.slice().sort(compareEntries)
    .map((entry, index) => renderReadableBlock(entry, index + 1));
  return `${heading}\n\n${blocks.join("\n\n---\n\n")}\n`;
}

function renderReadableBlock(entry, number) {
  const {record} = entry;
  const time = displayTime(record);
  return `## 记录 ${number}｜${time}｜${safeInline(record.title)}\n\n`
    + renderInfo(record, time) + "\n\n"
    + `### 整理后记录\n\n${safeParagraph(record.summary)}\n\n`
    + `### 后续事项\n\n${renderFollowUps(record.follow_ups)}\n\n`
    + renderSources(entry.sources);
}
```

The readable renderer must never call `encodeRecordData`. Keep Base64 decode/legacy parsing available only to the migration module.

- [ ] **Step 4: Write failing RecordStore tests**

Create `test/record-store.test.mjs` covering initialization, mode, round-trip, revision conflict, path safety, malformed JSON, and pending-render finalization:

```js
test("persists a versioned portable index with mode 0600", async () => {
  const root = await vault();
  const store = await RecordStore.open(root);
  const initial = store.snapshot();
  const next = {...initial, records: [entry()]};
  await store.replace(initial.revision, next);
  const reopened = await RecordStore.open(root);
  assert.deepEqual(reopened.snapshot().records, [entry()]);
  assert.equal((await stat(indexPath(root))).mode & 0o777, 0o600);
});

test("rejects stale revisions and malformed or identity-bearing fields", async () => {
  const store = await RecordStore.open(await vault());
  await assert.rejects(store.replace(99, store.snapshot()), /record_store_conflict/);
  await assert.rejects(store.replace(0, {
    ...store.snapshot(),
    records: [{...entry(), messageId: "om_forbidden"}]
  }), /invalid_record_store/);
});
```

- [ ] **Step 5: Run RecordStore tests and verify failure**

Run: `node --test test/record-store.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/record-store.mjs`.

- [ ] **Step 6: Implement RecordStore atomically**

Create `src/record-store.mjs` with fixed path and strict top-level keys:

```js
export const INDEX_RELATIVE = ".llw-system/indexes/feishu-daily-work/records.json";

export class RecordStore {
  static async open(vaultRoot) {
    const root = await realpath(vaultRoot);
    await Promise.all([
      stat(join(root, ".obsidian")),
      stat(join(root, ".llw-system", "SYSTEM_MAP.md"))
    ]);
    const parent = join(root, ".llw-system", "indexes", "feishu-daily-work");
    await mkdir(parent, {recursive: true, mode: 0o700});
    const parentReal = await realpath(parent);
    if (!parentReal.startsWith(`${root}${sep}`)) throw new Error("record_store_path_escape");
    const file = join(parentReal, "records.json");
    const data = await readStoreOrInitial(file);
    validateStore(data);
    return new RecordStore(file, data);
  }

  snapshot() { return structuredClone(this.data); }

  async replace(expectedRevision, next) {
    const current = await readStoreOrInitial(this.file);
    validateStore(current);
    if (current.revision !== expectedRevision) throw new Error("record_store_conflict");
    const committed = {...structuredClone(next), version: 1, revision: expectedRevision + 1};
    validateStore(committed);
    await atomicWriteJson(this.file, committed);
    this.data = committed;
    return this.snapshot();
  }

  async finalizeRenders(expectedRevision, dates) {
    const next = this.snapshot();
    for (const date of dates) delete next.pendingRenders[date];
    return this.replace(expectedRevision, next);
  }
}

function validateStore(data) {
  const keys = Object.keys(data).sort().join(",");
  if (keys !== "documents,pendingRenders,records,revision,version") throw new Error("invalid_record_store");
  if (data.version !== 1 || !Number.isSafeInteger(data.revision)) throw new Error("invalid_record_store");
  validateEntries(data.records);
  validateHashes(data.documents, data.pendingRenders);
}
```

Implement `readStoreOrInitial(file)` to return `{version:1, revision:0, records:[], documents:{}, pendingRenders:{}}` only on `ENOENT`. Implement `atomicWriteJson(file, data)` using `open(temporary, "wx", 0o600)`, `handle.writeFile()`, `handle.sync()`, `handle.close()`, and same-directory `rename`. `validateEntries` must reuse the managed-record entry validator and reject additional record/source fields; `validateHashes` must accept only ISO dates mapped to lowercase 64-character SHA-256 values and pending objects containing exactly `beforeHash` and `afterHash`.

- [ ] **Step 7: Run focused tests**

Run: `node --test test/managed-record.test.mjs test/record-store.test.mjs`

Expected: all focused tests PASS.

- [ ] **Step 8: Commit Task 1**

```bash
git add src/managed-record.mjs src/record-store.mjs test/managed-record.test.mjs test/record-store.test.mjs
git commit -m "feat: add portable daily-work record index"
```

---

### Task 2: Durable Mac-Local Write Reservations

**Files:**
- Modify: `src/state-store.mjs`
- Modify: `test/state-store.test.mjs`

**Interfaces:**
- Produces: `state.getReservation(messageId)`, `state.pendingReservations()`, `state.reserveWrite(messageId, intent)`, and existing `saveOutcome(...)` clearing the matching reservation atomically.
- Reservation shape: `{messageId, action, createTime, targetRecordId, records, recordIds, sourceIds}` stored only in the Mac-local state file.

- [ ] **Step 1: Write failing migration and reservation tests**

```js
test("migrates version 2 and persists stable write reservations in version 3", async () => {
  const {file} = await fresh();
  await writeFile(file, JSON.stringify({version: 2, conversation: null, outcomes: {}}));
  const state = await StateStore.open(file);
  const first = await state.reserveWrite("om_1", {
    action: "create_record", createTime: 1784445864192,
    targetRecordId: "", records: [record()]
  });
  const second = await StateStore.open(file);
  assert.deepEqual(second.getReservation("om_1"), first);
  assert.match(first.recordIds[0], /^[a-f0-9]{16}$/);
  assert.equal(JSON.parse(await readFile(file, "utf8")).version, 3);
});

test("reuses a reservation and clears it only after outcome persistence", async () => {
  const state = await StateStore.open((await fresh()).file);
  const one = await state.reserveWrite("om_1", createIntent());
  const two = await state.reserveWrite("om_1", createIntent());
  assert.deepEqual(two, one);
  await state.saveOutcome("om_1", {status: "committed", reply: "已入库", recordIds: one.recordIds});
  assert.equal(state.getReservation("om_1"), null);
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test test/state-store.test.mjs`

Expected: FAIL because version 3 and reservation methods do not exist.

- [ ] **Step 3: Implement version-3 state and strict reservation validation**

Use `randomBytes(8).toString("hex")` for record/source IDs. Persist the entire validated decision so a resumed write never calls AI a second time:

```js
async reserveWrite(messageId, intent) {
  if (this.data.reservations[messageId]) return structuredClone(this.data.reservations[messageId]);
  const count = intent.action === "create_record" ? intent.records.length : 1;
  const reservation = {
    messageId,
    ...structuredClone(intent),
    recordIds: intent.action === "create_record" ? ids(count) : [intent.targetRecordId],
    sourceIds: ids(count)
  };
  validateReservation(reservation);
  this.data.reservations[messageId] = reservation;
  await this.persist();
  return structuredClone(reservation);
}
```

Migrate versions 1 and 2 to `{version:3, conversation, outcomes, reservations:{}}`. `saveOutcome` must save the outcome and delete the reservation in the same `persist()` call.

- [ ] **Step 4: Run state tests**

Run: `node --test test/state-store.test.mjs`

Expected: all state tests PASS and persisted file mode remains `0600`.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/state-store.mjs test/state-store.test.mjs
git commit -m "feat: persist daily-work write reservations"
```

---

### Task 3: Index-Backed Writer, Catalog, and Recovery

**Files:**
- Modify: `src/vault-writer.mjs`
- Modify: `src/record-catalog.mjs`
- Modify: `src/service.mjs`
- Modify: `src/main.mjs`
- Modify: `test/vault-writer.test.mjs`
- Modify: `test/record-catalog.test.mjs`
- Modify: `test/service.test.mjs`

**Interfaces:**
- `new VaultWriter(vaultRoot, recordStore)`.
- `new RecordCatalog(vaultRoot, recordStore)`.
- `writer.create(reservation)` and `writer.supplement(reservation)` use only reserved random IDs, never Feishu IDs.
- `writer.recoverPendingRenders()` returns `{recoveredDates, conflicts}`.
- `service.resumePendingWrites()` completes local reservations before `resumeReplies()`.

Add these exact helpers to `test/vault-writer.test.mjs` and use the existing `vault()` and `record()` factories:

```js
async function portableVault() {
  const root = await vault();
  return {root, store: await RecordStore.open(root)};
}

function createReservation(overrides = {}) {
  return {
    messageId: "m-initial",
    action: "create_record",
    createTime: 1784445864192,
    targetRecordId: "",
    records: [record()],
    recordIds: ["90f29b02eb9ec9bb"],
    sourceIds: ["aaaaaaaaaaaaaaaa"],
    ...overrides
  };
}

function supplementReservation(overrides = {}) {
  return {
    messageId: "m-supplement",
    action: "supplement_record",
    createTime: 1784445972514,
    targetRecordId: "90f29b02eb9ec9bb",
    records: [record({occurred_time: "16:30", original_text: "补充原文"})],
    recordIds: ["90f29b02eb9ec9bb"],
    sourceIds: ["bbbbbbbbbbbbbbbb"],
    ...overrides
  };
}

function dailyFile(root) {
  return join(root, "亚信工作", "每日工作", "2026年07月18日", "工作记录.md");
}
```

- [ ] **Step 1: Change writer tests to require clean Markdown and index-backed supplementation**

```js
test("creates clean markdown while keeping ids only in the hidden index", async () => {
  const {root, store} = await portableVault();
  const writer = new VaultWriter(root, store);
  await writer.create(createReservation());
  const markdown = await readFile(dailyFile(root), "utf8");
  assert.doesNotMatch(markdown, /llw-record-|90f29b02eb9ec9bb/);
  assert.equal(store.snapshot().records[0].id, "90f29b02eb9ec9bb");
});

test("stops instead of overwriting a manual Markdown edit", async () => {
  const {root, store} = await portableVault();
  const writer = new VaultWriter(root, store);
  await writer.create(createReservation());
  await appendFile(dailyFile(root), "\n用户手工修改\n");
  await assert.rejects(writer.supplement(supplementReservation()), /daily_file_conflict/);
});

test("recovers an index-first pending render after restart", async () => {
  const {root, store} = await portableVault();
  const reservation = createReservation();
  const input = reservation.records[0];
  const entry = {
    id: reservation.recordIds[0],
    sortKey: "20260718-1630-1784445864192-00",
    record: {
      occurred_date: input.occurred_date,
      occurred_time: input.occurred_time,
      occurred_end_time: input.occurred_end_time,
      title: input.title,
      people: input.people,
      location: input.location,
      summary: input.summary,
      follow_ups: input.follow_ups
    },
    sources: [{kind: "initial", text: input.original_text, sourceId: reservation.sourceIds[0]}]
  };
  const after = renderReadableDocument("2026-07-18", [entry]);
  const snapshot = store.snapshot();
  await store.replace(snapshot.revision, {
    ...snapshot,
    records: [entry],
    documents: {"2026-07-18": sha256(after)},
    pendingRenders: {"2026-07-18": {beforeHash: sha256(""), afterHash: sha256(after)}}
  });
  const result = await new VaultWriter(root, await RecordStore.open(root)).recoverPendingRenders();
  assert.deepEqual(result.conflicts, []);
  assert.match(await readFile(dailyFile(root), "utf8"), /标品订单RV会议/);
});
```

Define test-local `sha256(value)` as `createHash("sha256").update(value).digest("hex")`.

- [ ] **Step 2: Change catalog tests to read the index**

Use this test body after creating the existing Vault markers:

```js
const store = await RecordStore.open(root);
const snapshot = store.snapshot();
await store.replace(snapshot.revision, {
  ...snapshot,
  records: Array.from({length: 21}, (_, index) => entry(index))
});
const candidates = await new RecordCatalog(root, store).list({limit: 20});
assert.equal(candidates.length, 20);
assert.equal(JSON.stringify(candidates).includes("原文"), false);
assert.equal(JSON.stringify(candidates).includes(root), false);
assert.equal(JSON.stringify(candidates).includes("pendingRenders"), false);
```

- [ ] **Step 3: Change service tests to require reservation-before-write and restart recovery**

```js
test("resumes a reserved write without invoking AI again", async () => {
  let decisions = 0;
  const h = await harness(async () => { decisions++; throw new Error("must_not_run"); });
  await h.state.reserveWrite("m1", {
    action: "create_record",
    createTime: 1784426400000,
    targetRecordId: "",
    records: [record(baseEvent.content)]
  });
  await h.service.resumePendingWrites();
  assert.equal(decisions, 0);
  assert.equal(h.creates.length, 1);
  assert.equal(h.state.pendingReservations().length, 0);
});
```

- [ ] **Step 4: Run focused tests and verify failure**

Run: `node --test test/vault-writer.test.mjs test/record-catalog.test.mjs test/service.test.mjs`

Expected: FAIL because constructors and reservation APIs still use Markdown-embedded metadata/message IDs.

- [ ] **Step 5: Refactor VaultWriter around RecordStore snapshots**

For each affected date:

```js
const before = await readOptional(target);
verifyDocumentHash(snapshot, date, before);
const after = renderReadableDocument(date, nextEntries);
const next = stagePendingRender(snapshot, date, hash(before), hash(after), nextEntries);
const committed = await store.replace(snapshot.revision, next);
await atomicReplace(target, before, after);
await verifyHash(target, hash(after));
await store.finalizeRenders(committed.revision, [date]);
```

If an entry/source ID from the reservation already exists, do not append it again; finish or recover the pending render idempotently. `recoverPendingRenders()` may write only when the current file hash equals either `beforeHash` or `afterHash`; every other value is a conflict.

- [ ] **Step 6: Refactor RecordCatalog to sanitize index entries**

Read `store.snapshot().records`, sort by date/sort key, return at most 20 objects with only:

```js
{
  record_id, date, occurred_time, occurred_end_time,
  title, people, location, summary, follow_ups
}
```

Continue validating that the configured Vault is mounted before returning candidates.

- [ ] **Step 7: Refactor service and startup flow**

After a high-confidence create/supplement decision, call `state.reserveWrite(...)` before the writer. Add:

```js
async resumePendingWrites() {
  for (const reservation of this.state.pendingReservations()) {
    await this.commitReservation(reservation);
  }
}
```

In `src/main.mjs`, open `RecordStore`, construct writer/catalog with it, call `writer.recoverPendingRenders()`, fail startup on conflicts, then call `service.resumePendingWrites()` and `service.resumeReplies()` before listening.

- [ ] **Step 8: Run focused and full tests**

Run: `node --test test/vault-writer.test.mjs test/record-catalog.test.mjs test/service.test.mjs`

Expected: focused tests PASS.

Run: `npm test`

Expected: all tests PASS, including existing Beijing-date, sender, attachment, and AI-schema tests.

- [ ] **Step 9: Commit Task 3**

```bash
git add src/vault-writer.mjs src/record-catalog.mjs src/service.mjs src/main.mjs test/vault-writer.test.mjs test/record-catalog.test.mjs test/service.test.mjs
git commit -m "refactor: keep daily-work metadata out of markdown"
```

---

### Task 4: Idempotent Legacy Migration and Local Backup

**Files:**
- Create: `src/migrate-record-index.mjs`
- Create: `test/migrate-record-index.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `migrateLegacyRecords({vaultRoot, backupRoot, now})`.
- CLI: `node src/migrate-record-index.mjs <vault-root> <mac-backup-root>`.
- Returns: `{migratedFiles, migratedRecords, backupDirectory, alreadyCurrent}` without exposing user source text.

In `test/migrate-record-index.test.mjs`, define `legacyVaultWithInitialAndSupplement()` by creating Vault markers, rendering one entry with `renderLegacyManagedDocument`, and returning `{root, backups, dailyFile, legacyMarkdown, legacyRecordId, legacySourceIds, initial, supplement}`. Define `malformedLegacyVault()` from the same fixture by removing its end marker and returning `{options:{vaultRoot:root, backupRoot:backups, now}, dailyFile, before}`. These factories must use fixed source strings and temporary directories only.

- [ ] **Step 1: Write failing migration tests**

```js
test("backs up legacy files and migrates all content to a clean portable index", async () => {
  const setup = await legacyVaultWithInitialAndSupplement();
  const result = await migrateLegacyRecords({
    vaultRoot: setup.root,
    backupRoot: setup.backups,
    now: new Date("2026-07-19T08:00:00Z")
  });
  assert.equal(result.migratedRecords, 1);
  assert.equal(result.migratedFiles, 1);
  const markdown = await readFile(setup.dailyFile, "utf8");
  assert.doesNotMatch(markdown, /llw-record-/);
  const [stored] = (await RecordStore.open(setup.root)).snapshot().records;
  assert.deepEqual(stored.sources.map(source => source.text), [setup.initial, setup.supplement]);
  assert.notEqual(stored.id, setup.legacyRecordId);
  assert.notDeepEqual(stored.sources.map(source => source.sourceId), setup.legacySourceIds);
  assert.deepEqual(await readFile(result.backupFile, "utf8"), setup.legacyMarkdown);
});

test("is idempotent and leaves the live file unchanged on validation failure", async () => {
  const setup = await malformedLegacyVault();
  await assert.rejects(migrateLegacyRecords(setup.options), /malformed_record_markers/);
  assert.equal(await readFile(setup.dailyFile, "utf8"), setup.before);
});
```

- [ ] **Step 2: Run migration tests and verify failure**

Run: `node --test test/migrate-record-index.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement backup-first migration**

The implementation must:

1. Validate Vault markers and fixed daily-work root.
2. Parse every legacy managed document before any live-file replacement.
3. Create a Mac-local timestamped backup directory with mode `0700`.
4. Copy each original file preserving its daily relative path; set backup files read-only after verification.
5. Convert every legacy record/source ID to a new cryptographically random 16-character hexadecimal ID before it enters the portable index; the Mac-only backup retains the original legacy form.
6. Stage pending renders with the legacy file hash as `beforeHash` and clean Markdown hash as `afterHash`.
7. Atomically write the index, atomically replace and verify each Markdown file, then finalize pending renders.
8. Return only counts and backup paths; never print record text or identifiers.

Add to `package.json`:

```json
"migrate:metadata": "node src/migrate-record-index.mjs"
```

- [ ] **Step 4: Run migration and full tests**

Run: `node --test test/migrate-record-index.test.mjs`

Expected: migration tests PASS.

Run: `npm test`

Expected: complete suite PASS.

- [ ] **Step 5: Commit Task 4**

```bash
git add src/migrate-record-index.mjs test/migrate-record-index.test.mjs package.json
git commit -m "feat: migrate encoded daily-work metadata safely"
```

---

### Task 5: Skill Rules, Deployment, Migration, and Acceptance

**Files:**
- Modify: `/Volumes/ZHUTONG/LLW的私人助手/LLW/.agents/skills/feishu-daily-work/references/markdown-rules.md`
- Modify: `/Volumes/ZHUTONG/LLW的私人助手/LLW/.llw-system/SYSTEM_MAP.md`
- Runtime repository: `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work`

**Interfaces:**
- Skill continues returning only JSON matching `output-schema.json`; deterministic writer owns display/index writes.
- Live index: `/Volumes/ZHUTONG/LLW的私人助手/LLW/.llw-system/indexes/feishu-daily-work/records.json`.
- Mac backup root: `/Users/ccrt/Library/Application Support/LLW Assistant/backups/feishu-daily-work-metadata-migration/`.

- [ ] **Step 1: Update Skill Markdown rules with no encoded markers**

Replace the marker-based example with a clean example beginning directly at `## 记录 N｜时间｜标题`. Add explicit rules:

```markdown
- 工作记录 Markdown 不得包含内部记录编号、排序键、索引路径、HTML 管理注释或 Base64 管理数据。
- 内部结构由确定性写入器保存到 `.llw-system/indexes/feishu-daily-work/records.json`；不得向 AI 暴露索引内容或路径。
```

Run:

```bash
python3 "/Users/ccrt/.codex/skills/.system/skill-creator/scripts/quick_validate.py" \
  "/Volumes/ZHUTONG/LLW的私人助手/LLW/.agents/skills/feishu-daily-work"
```

Expected: validation succeeds with no malformed frontmatter or missing referenced file.

- [ ] **Step 2: Run pre-deployment verification**

In the implementation worktree:

Run: `npm test`

Expected: all tests PASS.

Run: `git diff --check`

Expected: no output and exit code 0.

Run a secret-pattern scan over the complete branch history and changed U-drive Skill/System Map files.

Expected: no App Secret, token, user/chat/message identifier, private key, or authorization header.

- [ ] **Step 3: Stop the live service and capture health state**

Run: `launchctl print gui/501/com.llw.feishu-daily-work`

Expected: the current service is present before removal.

Run: `launchctl remove com.llw.feishu-daily-work`

Expected: exit code 0; verify no listener remains before migration.

Open the Mac-local version-3 state through `StateStore` and verify `conversation === null`, `pendingReservations().length === 0`, and `unreplied().length === 0`. If any value is non-empty, restart the old service to finish it or stop and request user direction; do not migrate while work is pending.

- [ ] **Step 4: Fast-forward the verified implementation into the local runtime repository**

Push the tested implementation branch to the private GitHub repository, fast-forward `main` only after review, then run in the runtime repository:

```bash
git pull --ff-only origin main
```

Expected: local `main` equals remote `main`; no uncommitted runtime changes.

- [ ] **Step 5: Run the real migration once**

```bash
/usr/local/bin/node src/migrate-record-index.mjs \
  "/Volumes/ZHUTONG/LLW的私人助手/LLW" \
  "/Users/ccrt/Library/Application Support/LLW Assistant/backups/feishu-daily-work-metadata-migration"
```

Expected: exactly the existing managed daily files/records are reported by count, a Mac-local backup path is returned, and no record text or identifiers are printed.

- [ ] **Step 6: Verify live data before restart**

Run checks that assert:

- `工作记录.md` contains no `llw-record-start`, `llw-record-data`, `llw-record-end`, or long Base64 management line.
- The visible title, organized summary, follow-up, initial source, and supplement source are unchanged.
- The hidden index exists, validates, and has mode `0600`.
- The U drive contains no credentials or raw Feishu identifiers.
- The Mac backup reopens and byte-matches the pre-migration file.

- [ ] **Step 7: Update SYSTEM_MAP and restart**

Document the portable hidden index, Mac-local write reservations, migration backup, and clean-Markdown rule in `.llw-system/SYSTEM_MAP.md`.

Bootstrap the existing LaunchAgent definition, then run:

```bash
launchctl print gui/501/com.llw.feishu-daily-work
```

Expected: service running with a fresh heartbeat and no pending reservation/render conflict.

- [ ] **Step 8: Perform real Feishu acceptance**

Send one clearly dated private text record, confirm it creates the correct Beijing-date file, then send a natural-language supplement and confirm it updates the same record. Verify the Markdown remains clean after both operations and that the bot reply contains the organized content and relative location.

- [ ] **Step 9: Final verification and publish**

Run: `npm test`

Expected: complete suite PASS.

Run: `git status --short --branch`

Expected: clean branch tracking `origin/main`.

Compare local and GitHub `main` commit hashes and confirm the GitHub repository remains `PRIVATE`.

Commit any final code documentation changes with:

```bash
git add docs src test package.json
git commit -m "docs: document clean portable daily-work storage"
```

Do not commit the U-drive Skill, user records, hidden index, backups, state, logs, or credentials to GitHub.
