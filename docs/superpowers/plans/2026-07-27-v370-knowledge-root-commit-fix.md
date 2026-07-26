# V3.7.0 Knowledge Root Commit Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow an immutable knowledge item to be committed directly under a selected managed library root while continuing to reject empty folder-creation plans.

**Architecture:** Keep the existing `KnowledgeWriter` and all path-safety checks. Add one explicit validation option used only by `commit`; `createFolder` retains the current non-empty requirement.

**Tech Stack:** Node.js ESM, `node:test`, local Git worktree, macOS LaunchAgent.

## Global Constraints

- Do not change Router, private Skill, Schema, configuration, reply text, or permissions.
- Do not move, rename, overwrite, or delete existing user material.
- Do not expose source text, platform identifiers, credentials, or absolute private paths in logs or reports.
- Do not use subagents.

---

### Task 1: Protect and implement managed-root commits

**Files:**
- Modify: `test/knowledge-writer.test.mjs`
- Modify: `src/capabilities/knowledge-ingest/knowledge-writer.mjs`

**Interfaces:**
- Consumes: `KnowledgeWriter.commit({libraryKey,folderSegments,...})`
- Produces: `validateSegments(segments,{allowRoot})` behavior used only inside the writer

- [ ] **Step 1: Write the failing test**

Add a real Writer test using the existing synthetic Vault:

```js
test("commits directly under a selected managed library root without creating a category",async()=>{
  const h=await harness();
  try {
    const result=await h.writer.commit(commitInput({
      libraryKey:"personal-knowledge",
      folderSegments:[],
      title:"根目录知识项"
    }));
    assert.equal(result.relativePath,"personal-library/根目录知识项");
    assert.deepEqual(await readdir(h.personal),["根目录知识项"]);
    assert.deepEqual(await readdir(h.work),[]);
  } finally { await rm(h.root,{recursive:true,force:true}); }
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
/usr/local/bin/node --test test/knowledge-writer.test.mjs
```

Expected: the new test fails with `knowledge_write_rejected`.

- [ ] **Step 3: Write the minimal implementation**

Change the commit call and validator:

```js
validateSegments(input.folderSegments,{allowRoot:true});

function validateSegments(segments,{allowRoot=false}={}) {
  if (!Array.isArray(segments)||(!allowRoot&&segments.length<1)||
      segments.length>5||segments.some(segment=>!validSegment(segment))) {
    throw new Error("invalid_segments");
  }
}
```

Leave `createFolder` unchanged so it uses `allowRoot:false`.

- [ ] **Step 4: Verify GREEN and the security boundary**

Run:

```bash
/usr/local/bin/node --test test/knowledge-writer.test.mjs
/usr/local/bin/node --test test/knowledge-decision-validator.test.mjs test/knowledge-capability.test.mjs test/knowledge-writer.test.mjs
```

Expected: all tests pass, including the existing empty `createFolder` rejection.

### Task 2: Regression, deployment, and acceptance

**Files:**
- Update after verified acceptance: `docs/V370_KNOWLEDGE_STAGE_A_INCIDENT_R1.md`
- Update after verified acceptance: `/Volumes/ZHUTONG/LLW的私人助手/LLW/.llw-system/SYSTEM_MAP.md`

**Interfaces:**
- Consumes: verified integration commit
- Produces: production component, healthy single consumer, evidence-backed Feishu and WeChat outcomes

- [ ] **Step 1: Run the complete integration regression**

Run `/usr/local/bin/npm test` once in the integration worktree. Expected: zero failures.

- [ ] **Step 2: Commit and synchronize the validated component**

Commit only the scoped source, test, design, plan, and incident changes. Push the authorized integration
and production branches only after verification.

- [ ] **Step 3: Deploy atomically**

Create a protected rollback point, fast-forward the production component, run production regression,
restart the existing LaunchAgent once, and verify exactly one event consumer.

- [ ] **Step 4: Run real acceptance**

Send one bounded synthetic root-library request through Feishu and one through WeChat. Verify each yields
one `knowledge-ingest/committed` or idempotent `existing` outcome, one reply, and validated ordinary-file
artifacts with no staging residue.

- [ ] **Step 5: Update current-state evidence**

Record the sanitized root cause, fix commit, test counts, deployment health, and real acceptance results.
