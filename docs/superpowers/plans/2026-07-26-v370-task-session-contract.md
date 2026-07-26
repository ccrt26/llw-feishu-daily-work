# V3.7.0 Task Session Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:executing-plans` inline. The owner explicitly prohibited
> subagents. Execute task-by-task with RED-GREEN checkpoints.

**Goal:** Add the strict, disabled Task Session contract and one shared
version-4 StateStore slot required by the approved V3.7.0 R3 first batch.

**Architecture:** A focused pure contract module validates exact session
objects against an explicit continuation policy and verified source list.
StateStore persists one session slot and enforces identity, model, time, draft
version, and terminal-state transitions without changing Router or Dispatcher.

**Tech Stack:** Node.js 24 ESM, `node:test`, `node:fs/promises`, existing
version-4 JSON StateStore, Git linked worktree.

## Global Constraints

- No subagents, model calls, GitHub upload, deployment, production writes, or
  service restart.
- Keep state envelope version exactly `4`.
- Keep `assistant-work` and `knowledge-ingest` disabled.
- Do not implement Router continuation, automatic expiry, workspace files,
  knowledge search, drafting, output generation, or platform sending.
- Tests use synthetic temporary data and assert behavior, not source text.
- Errors contain bounded codes only and never echo session content or paths.

---

### Task 1: Strict TaskSession contract

**Files:**
- Create: `test/task-session.test.mjs`
- Create: `src/core/task-session.mjs`

**Interfaces:**
- Produces:
  `validateTaskSession(value, {policy, verifiedSourcePaths})`.
- `policy` is an exact array of
  `{capability: string, models: ("codex"|"deepseek")[]}`.
- Returns a deep-cloned validated session.

- [ ] **Step 1: Write the failing valid-contract and cloning test**

Use one literal session:

```js
const session={
  version:1,
  session_id:"123e4567-e89b-42d3-a456-426614174000",
  capability:"assistant-work",
  status:"open",
  model:"codex",
  goal:"根据项目资料整理验收说明",
  task_summary:"",
  confirmed_requirements:["保留来源"],
  rejected_directions:[],
  source_paths:["projects/acceptance.md"],
  current_draft_version:0,
  recent_turns:[{role:"user",text:"先整理一个提纲"}],
  started_at:"2026-07-26T05:00:00.000Z",
  updated_at:"2026-07-26T05:00:00.000Z"
};
```

Assert exact deep equality, non-identity, and no mutation of nested arrays.

- [ ] **Step 2: Run RED**

Run:

```bash
node --test test/task-session.test.mjs
```

Expected: failure because `src/core/task-session.mjs` does not exist.

- [ ] **Step 3: Add failing table-driven boundary tests**

Cover unknown fields, non-plain objects, invalid UUID/status/model/capability,
empty or oversized text, duplicate or oversized lists, unsafe/unverified
source paths, noncanonical or reversed timestamps, invalid draft versions, malformed
turns, and serialized size over 32 KiB. Each rejection must expose only
`invalid_task_session`.

- [ ] **Step 4: Implement the minimal pure validator**

Implement exact field sets, UTF-8 byte bounds, literal array limits, canonical
UUID/ISO validation, safe relative path validation, policy matching,
verified-source membership, total JSON byte limit, and structured cloning.

- [ ] **Step 5: Run GREEN**

Run:

```bash
node --test test/task-session.test.mjs
```

Expected: every Task Session contract test passes with no warnings.

- [ ] **Step 6: Commit**

```bash
git add src/core/task-session.mjs test/task-session.test.mjs
git commit -m "feat: add strict task session contract"
```

### Task 2: Version-4 StateStore session slot

**Files:**
- Modify: `test/state-store.test.mjs`
- Modify: `src/state-store.mjs`

**Interfaces:**
- `StateStore.open(file, {maxOutcomes, taskSessionPolicy})`.
- `getTaskSession()` returns the current open session or `null`.
- `saveTaskSession(session, {verifiedSourcePaths})` creates, updates, or
  replaces a terminal session.
- `closeTaskSession(status, updatedAt)` accepts only `completed`, `cancelled`,
  or `expired`.

- [ ] **Step 1: Write failing persistence and restart tests**

Assert a synthetic open session survives `StateStore.open` with the same draft
version, state/file version remains 4, mode remains `0600`, and exactly one
`capabilityState["task-session"].session` exists.

- [ ] **Step 2: Run RED**

Run:

```bash
node --test test/state-store.test.mjs
```

Expected: failure because `saveTaskSession` and `getTaskSession` do not exist.

- [ ] **Step 3: Add failing transition tests**

Assert:

- a different ID cannot replace an open session;
- same-session update preserves ID, capability, model, and `started_at`;
- draft version and `updated_at` cannot move backwards;
- closing persists each allowed terminal status;
- terminal sessions cannot update or close twice;
- a new open session may replace a terminal session;
- unverified sources and policy mismatch never change persisted bytes.

- [ ] **Step 4: Implement the minimal StateStore integration**

Normalize the shared slot in empty and version 1–4 loaded state. Validate any
non-null restored session against the explicit policy. Use the TaskSession
validator for every write. Preserve existing atomic persistence and cloning.
Keep daily-work, Router, invoice, outcomes, and state version unchanged.

- [ ] **Step 5: Run GREEN and adjacent tests**

Run:

```bash
node --test test/task-session.test.mjs test/state-store.test.mjs \
  test/dispatcher.test.mjs test/service.test.mjs
```

Expected: all selected tests pass with no warnings.

- [ ] **Step 6: Commit**

```bash
git add src/state-store.mjs test/state-store.test.mjs
git commit -m "feat: reserve shared task session state"
```

### Task 3: Local candidate verification

**Files:**
- Review all files changed from `19c0b93`.

**Interfaces:**
- No new production action.

- [ ] **Step 1: Run formatting and privacy checks**

Run `git diff --check`. Inspect added lines for real user paths, platform IDs,
credentials, private Skill prose, and actual private hashes.

- [ ] **Step 2: Run the proportional final gate**

Run the Task Session, StateStore, Dispatcher, Service, config-v5, manifest,
and main-composition tests. Do not repeat all 337 tests because this disabled
contract does not change Router, Dispatcher, main composition, or production
configuration. A future integration/deployment gate runs the full suite once.

- [ ] **Step 3: Verify isolation**

Confirm the component candidate worktree is clean after commits, formal
component and private Skill checkouts remain clean, and formal configuration,
state, service, LaunchAgent, and Vault were not changed.

- [ ] **Step 4: Report**

Report exact local commits, targeted test count, deferred full-regression
reason, unchanged production boundary, and the next R3 decision: knowledge
library directory before starting the minimum ingest loop.
