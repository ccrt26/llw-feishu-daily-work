# DeepSeek V4 Pro and Skill-Level Reasoning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Phase 3 DeepSeek text path and its 22-case evaluator on `deepseek-v4-pro`, while documenting the existing per-Skill reasoning modes without creating any new Skill.

**Architecture:** Keep the existing semantic-task boundaries and direct HTTPS client. Configuration and evaluation choose one fixed Pro model; each existing Skill records its model-specific reasoning mode, while the corresponding program path remains the deterministic enforcement point.

**Tech Stack:** Node.js ESM, `node:test`, Markdown Skills, DeepSeek OpenAI-compatible Chat Completions API.

## Global Constraints

- Work only in `/private/tmp/llw-v3-phase3-task31` and the three existing formal Skills under `/Volumes/ZHUTONG/LLW的私人助手/LLW/.agents/skills/`.
- Do not create an article-writing Skill or any other new Skill.
- Do not change production configuration, state, LaunchAgent, processes, or user documents.
- Do not read Keychain or call the real DeepSeek API during implementation.
- Do not expand the current 128 KiB request or 4096-token output limits.
- Do not add automatic model switching, fallback, model comparison, dynamic reasoning, Provider, or model-specific Skill copies.
- Do not commit or push in this session.

---

### Task 1: Fix the DeepSeek model contract on V4 Pro

**Files:**
- Modify: `test/config.test.mjs`
- Modify: `test/migrate-config-v4.test.mjs`
- Modify: `test/deepseek-client.test.mjs`
- Modify: `test/real-deepseek-eval-runner.test.mjs`
- Modify: `src/config.mjs`
- Modify: `src/migrate-config-v4.mjs`
- Modify: `src/ai/deepseek-client.mjs`
- Modify: `tools/run-real-deepseek-evals.mjs`

**Interfaces:**
- Consumes: version-4 `deepseekModel`, `invokeDeepSeek({model})`, and evaluator `--list`.
- Produces: one accepted/default/evaluated model identifier, `deepseek-v4-pro`.

- [x] **Step 1: Write failing assertions**

Change expected defaults and request/evaluator model assertions to:

```js
assert.equal(deepseekModel,"deepseek-v4-pro");
assert.equal(body.model,"deepseek-v4-pro");
assert.equal(plan.model,"deepseek-v4-pro");
```

Add `deepseek-v4-flash` to the configuration/client rejection cases.

- [x] **Step 2: Run focused tests and verify RED**

Run:

```bash
/usr/local/bin/node --test \
  test/config.test.mjs \
  test/migrate-config-v4.test.mjs \
  test/deepseek-client.test.mjs \
  test/real-deepseek-eval-runner.test.mjs
```

Expected: failures show the remaining Flash default/request/evaluator and Flash still being accepted.

- [x] **Step 3: Implement the minimal model change**

Use only:

```js
const DEEPSEEK_MODELS=new Set(["deepseek-v4-pro"]);
const MODELS=new Set(["deepseek-v4-pro"]);
```

Set both version-4 defaults and the evaluator constant to `"deepseek-v4-pro"`. Keep:

```js
thinking:{type:"disabled"},temperature:0
```

- [x] **Step 4: Run the focused tests and verify GREEN**

Run the same four-test command. Expected: all focused tests pass.

---

### Task 2: Make the existing Skill-level reasoning contract explicit

**Files:**
- Modify: `test/intent-routing-skill-contract.test.mjs`
- Modify: `test/daily-work-skill-contract.test.mjs`
- Modify: `test/filing-invoices-skill-contract.test.mjs`
- Modify: `/Volumes/ZHUTONG/LLW的私人助手/LLW/.agents/skills/feishu-intent-router/SKILL.md`
- Modify: `/Volumes/ZHUTONG/LLW的私人助手/LLW/.agents/skills/feishu-daily-work/SKILL.md`
- Modify: `/Volumes/ZHUTONG/LLW的私人助手/LLW/.agents/skills/filing-invoices/SKILL.md`

**Interfaces:**
- Consumes: existing `## 8. 模型支持` sections and existing program settings.
- Produces: concise auditable statements of fixed reasoning mode; no runtime metadata file.

- [x] **Step 1: Write failing Skill contract assertions**

Require the exact task-specific facts:

```js
assert.match(skill,/Codex.*low/);
assert.match(skill,/DeepSeek V4 Pro.*非思考.*temperature=0/);
```

For invoices require:

```js
assert.match(skill,/Codex.*medium/);
assert.match(skill,/DeepSeek.*禁止/);
```

All three tests must also require that the setting is fixed by the program and cannot be overridden by user/model input.

- [x] **Step 2: Run the three contract tests and verify RED**

Run:

```bash
/usr/local/bin/node --test \
  test/intent-routing-skill-contract.test.mjs \
  test/daily-work-skill-contract.test.mjs \
  test/filing-invoices-skill-contract.test.mjs
```

Expected: failures show that the current Skill sections do not name the reasoning settings.

- [x] **Step 3: Apply minimal edits to the three existing Skills**

Record:

- Router: Codex `low`; DeepSeek V4 Pro non-thinking and `temperature=0`.
- Daily work: Codex `low`; DeepSeek V4 Pro non-thinking and `temperature=0`.
- Invoice: Codex `medium`; DeepSeek prohibited.
- Each setting is declared by the Skill and fixed by the semantic-task program; user input and model output cannot override it.

Do not add files or sections outside `## 8. 模型支持`.

- [x] **Step 4: Run contract tests and validate every formal Skill**

Expected: three contract tests pass and `quick_validate.py` returns `Skill is valid!` for all three directories.

---

### Task 3: Update current-state evidence and complete local gates

**Files:**
- Modify: `.superpowers/sdd/task-32-report.md`
- Modify: `.superpowers/sdd/task-33-eval-report.md`
- Modify: `/Volumes/ZHUTONG/LLW的私人助手/LLW/.llw-system/SYSTEM_MAP.md`

**Interfaces:**
- Consumes: verified focused-test results.
- Produces: current facts that distinguish old Flash evidence from the new Pro target.

- [x] **Step 1: Update current-state documentation**

State that the target/evaluator is V4 Pro, 1M is provider model capacity, current local request/output limits remain unchanged, and the old 18/22 Flash run remains diagnostic only.

- [x] **Step 2: Run static gates**

Run `node --check` on changed modules, evaluator `--list`, `git diff --check`, and a bounded secret-pattern scan. Expected: clean output; evaluator lists Pro, 22 cases, `keychainRead:false`, `networkAccess:false`.

- [x] **Step 3: Run the isolated full regression**

Run `/usr/local/bin/npm test` in `/private/tmp/llw-v3-phase3-task31`. Expected: all tests pass with the new total.

- [x] **Step 4: Run the current production-component regression**

Run `/usr/local/bin/npm test` in the production component directory without changing it. Expected: 162/162 pass against the modified formal Skills.

- [x] **Step 5: Stop at the real API approval gate**

Report local evidence and request separate permission to read the existing Keychain item and run the fixed 22-case V4 Pro evaluation. Do not execute it before approval.

## Post-approval execution evidence

The project owner subsequently approved reading the existing Keychain item and running the fixed real evaluation. No key material was printed or written to the workspace.

- Initial V4 Pro run: 16/22; the four Router timeouts passed on one unchanged failure-only rerun.
- Two stable semantic discrepancies were resolved at the formal fixture/program-validation boundary without changing model, reasoning mode, sampling, retry or architecture.
- Final complete V4 Pro run: 22/22 in one run, comprising Router 10/10 and daily-work 12/12.
- Production configuration, state, LaunchAgent and process remained unchanged.
