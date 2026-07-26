# V3.6.2 Invoice Date Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept clear electronic-invoice dates in either `YYYY-MM-DD` or `YYYY年MM月DD日`, validate them deterministically, and provide canonical `YYYY-MM-DD` only to the existing archive writer.

**Architecture:** Preserve the raw `InvoiceExtraction` contract. Add one private Node.js date parser inside the existing invoice rule-decision module, normalize only the two approved lexical forms after all existing higher-priority gates, and clone the normalized date into the eligible `InvoiceRuleDecision`.

**Tech Stack:** Node.js 24 ESM, built-in `node:test`, existing LLW Skill contract tests and Git.

## Global Constraints

- V3.6.2 is the only future construction baseline for this change.
- AI must continue to copy the visible invoice date verbatim.
- Node.js may accept only exact `YYYY-MM-DD` and exact zero-padded `YYYY年MM月DD日`.
- Both forms must pass the same real Gregorian calendar validation.
- The original `InvoiceExtraction` must not be mutated.
- The writer must continue to receive only `YYYY-MM-DD`.
- Do not change entry protocols, Router, Schema shape, buyer rules, amount rules, invoice-number rules, archive paths, Obsidian format, state version, configuration, models, dependencies, services, or reply transport.
- No subagent execution is used because the active environment instruction prohibits proactive subagents.

---

### Task 1: Version the governing documentation

**Files:**
- Create: `/Users/ccrt/Downloads/LLW_PERSONAL_AI_SKILL_PLATFORM_MASTER_CONSTRUCTION_BASELINE_V3_6_2.md`
- Create: `docs/superpowers/specs/2026-07-24-v362-invoice-date-normalization-design.md`
- Create: `docs/superpowers/plans/2026-07-24-v362-invoice-date-normalization.md`

**Interfaces:**
- Consumes: V3.6.1 extraction-only boundary and the production replay evidence.
- Produces: the exact two-form date contract used by all later tasks.

- [ ] **Step 1: Create V3.6.2 from V3.6.1**

Record the root cause, accepted and rejected forms, normalized writer value, unchanged extraction, tests, rollback and deployment boundaries.

- [ ] **Step 2: Self-review the documents**

Run:

```bash
rg -n 'TBD|TODO|待定|V3_6_1.md|V3\.6及更早' \
  /Users/ccrt/Downloads/LLW_PERSONAL_AI_SKILL_PLATFORM_MASTER_CONSTRUCTION_BASELINE_V3_6_2.md \
  docs/superpowers/specs/2026-07-24-v362-invoice-date-normalization-design.md \
  docs/superpowers/plans/2026-07-24-v362-invoice-date-normalization.md
```

Expected: no unresolved placeholders or stale authority references.

### Task 2: Prove the defect with failing component tests

**Files:**
- Modify: `test/invoice-decision-validator.test.mjs`
- Modify: `test/invoice-capability.test.mjs`

**Interfaces:**
- Consumes: `deriveInvoiceRuleDecision(InvoiceExtraction)`.
- Produces: an eligible decision with normalized `invoice.issue_date`, without mutating the extraction.

- [ ] **Step 1: Replace the old Chinese-date rejection assertion**

Add assertions equivalent to:

```js
const extraction=clearExtraction({invoice:{issue_date:"2026年07月21日"}});
const decision=deriveInvoiceRuleDecision(extraction);
assert.equal(decision.action,"archive_dining");
assert.equal(decision.reasonCode,"eligible");
assert.equal(decision.invoice.issue_date,"2026-07-21");
assert.equal(extraction.invoice.issue_date,"2026年07月21日");
```

- [ ] **Step 2: Add strict negative syntax assertions**

Require `issue_date_invalid` for `2026/07/21`, `2026年7月21日`, surrounding whitespace and `2026-02-30`.

- [ ] **Step 3: Add a capability-to-writer assertion**

Provide a clear Chinese date extraction through the real capability and assert the injected writer receives `2026-07-21`.

- [ ] **Step 4: Run the target tests and verify RED**

Run:

```bash
node --test test/invoice-decision-validator.test.mjs test/invoice-capability.test.mjs
```

Expected: fail because the current validator returns `issue_date_invalid` and does not call the writer.

### Task 3: Implement the minimal Node.js normalization

**Files:**
- Modify: `src/capabilities/invoice/decision-validator.mjs`

**Interfaces:**
- Consumes: a clear raw `issue_date` string.
- Produces: canonical `YYYY-MM-DD` or `null`.

- [ ] **Step 1: Add one private parser**

Implement:

```js
function normalizeIssueDate(value) {
  const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value) ||
    /^(\d{4})年(\d{2})月(\d{2})日$/.exec(value);
  if (!match) return null;
  const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]);
  const date=new Date(Date.UTC(year,month-1,day));
  if (date.getUTCFullYear()!==year ||
      date.getUTCMonth()!==month-1 ||
      date.getUTCDate()!==day) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}
```

- [ ] **Step 2: Normalize only in the eligible decision**

Replace the boolean date gate with:

```js
const issueDate=normalizeIssueDate(extraction.invoice.issue_date);
if (!issueDate) return clarify("issue_date_invalid");
```

Return a cloned invoice with `issue_date:issueDate`; do not mutate `extraction`.

- [ ] **Step 3: Run the target tests and verify GREEN**

Run:

```bash
node --test test/invoice-decision-validator.test.mjs test/invoice-capability.test.mjs
```

Expected: all target tests pass.

### Task 4: Update and verify the filing-invoices Skill contract

**Files:**
- Modify: `/Volumes/ZHUTONG/LLW的私人助手/LLW/.agents/skills/filing-invoices/SKILL.md`
- Modify: `test/invoice-skill-contract.test.mjs`

**Interfaces:**
- Consumes: the unchanged raw extraction behavior.
- Produces: explicit guidance that Node.js accepts exactly two date forms and gives the writer a canonical date.

- [ ] **Step 1: Add the failing Skill contract assertion**

Require the Skill to contain both `YYYY-MM-DD` and `YYYY年MM月DD日`, and to state that normalization belongs to Node.js while raw extraction remains unchanged.

- [ ] **Step 2: Run the contract test and verify RED**

Run:

```bash
node --test test/invoice-skill-contract.test.mjs
```

Expected: fail because the Skill does not yet declare the two-form rule.

- [ ] **Step 3: Update the minimal Skill paragraphs**

Keep the current extraction-only text and add the exact two-form Node.js rule in processing and invariants. Do not alter frontmatter, Schema shape, routing contract or model support.

- [ ] **Step 4: Run the Skill validator and contract test**

Run the repository's existing Skill checks and:

```bash
node --test test/invoice-skill-contract.test.mjs
```

Expected: pass.

### Task 5: Verify, protect, deploy and accept

**Files:**
- Modify after successful deployment: `/Volumes/ZHUTONG/LLW的私人助手/LLW/.llw-system/SYSTEM_MAP.md`

**Interfaces:**
- Consumes: verified component and Skill commits.
- Produces: a protected rollback point, deployed production service, health evidence and real Feishu result.

- [ ] **Step 1: Run all invoice and full regression tests**

Run:

```bash
npm test
```

Expected: all tests pass with zero failures.

- [ ] **Step 2: Create the protected rollback point**

Back up the pre-deploy component, Skills, version-4 config/state/model/heartbeat, plist and manifest without logs, Vault data or Keychain values. Set directory mode `0700` and files `0600`.

- [ ] **Step 3: Restore into a fresh `/private/tmp` directory**

Verify manifest hashes, Git commits, Skill contract and complete tests from restored artifacts. Remove the temporary restore only after verification.

- [ ] **Step 4: Commit and push verified component and Skill changes**

Push the component fix branch and the Skills main update. Do not include the user invoice, extracted values, platform identifiers, logs, state or secrets.

- [ ] **Step 5: Atomically deploy and restart once**

Stop the single LaunchAgent, fast-forward the production component and Skills to verified commits, and start the same LaunchAgent once. Do not enable WeChat as part of this change.

- [ ] **Step 6: Verify production health**

Confirm version-4 state/config, Codex, current WeChat switch, one Node.js main process, one direct lark event consumer, advancing heartbeat and zero unreplied outcomes.

- [ ] **Step 7: Run real Feishu acceptance**

Ask the owner to resend the same clear invoice. Expect the date-format clarification to disappear. Final archive/reject behavior must be determined only by all existing invoice rules.

- [ ] **Step 8: Update `SYSTEM_MAP.md`**

Record exact commits, test counts, rollback path, normalization boundary, deployment state and real acceptance without invoice values or platform identifiers.
