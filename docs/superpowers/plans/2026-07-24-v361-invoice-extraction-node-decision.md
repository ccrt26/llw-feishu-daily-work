# V3.6.1 Invoice Extraction and Deterministic Node Decision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `invoice.visual` 收敛为只读取最小票面事实的 `InvoiceExtraction`，由同一个 Node.js 规则核心为飞书、微信、图片和 PDF 唯一派生归档、拒绝或澄清结果及固定回执。

**Architecture:** 保留现有双入口、`PreparedImage`、`router.visual`、Codex-only视觉调用、归档 writer、状态 version 4 和 Obsidian格式。Codex只输出严格 extraction Schema；Node.js 先验证 extraction，再执行购买方、税号、类别、文档状态、日期、金额和发票号码规则，形成 `InvoiceRuleDecision`。只有 `archive_dining/eligible` 可以进入现有 writer，其他业务结果由固定 reason code 生成回复，模型/JSON/Schema错误继续走技术失败。

**Tech Stack:** Node.js `>=24`、ES modules、Node test runner、Codex CLI只读 `--image`、JSON Schema draft-07、现有 macOS Keychain/LaunchAgent、飞书 `lark-cli`、微信固定 iLink HTTPS薄入口。

## Global Constraints

- 唯一设计基线：`LLW_PERSONAL_AI_SKILL_PLATFORM_MASTER_CONSTRUCTION_BASELINE_V3_6_1.md`。
- 开始前完整阅读工作区 `.llw-system/README.md`、`.llw-system/SYSTEM_MAP.md`、`.llw-system/FEISHU_ASSISTANT_CAPABILITY_STANDARD.md`、组件 `AGENTS.md`（若存在）和 `.agents/skills/filing-invoices/SKILL.md`。
- 生产代码仓库：`/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work`。
- Skills 仓库：`/Volumes/ZHUTONG/LLW的私人助手/LLW/.agents/skills`；不得覆盖当前未提交的用户或既有视觉路由变更。
- 所有实现必须位于隔离 worktree；先跑当前完整回归并记录实际总数。
- 新行为必须先写失败测试并看到预期红灯，再写最小实现。
- 不新增 npm 依赖、服务、进程、数据库、状态版本、Skill、Provider、OCR或模型重试。
- 不修改飞书/微信入口协议、`router.visual`、PDF路由、下载器、归档目录、Obsidian格式、哈希、防覆盖或事务规则。
- 不提取开户账号、银行账号、地址电话等当前归档不需要的额外字段。
- AI、普通日志和文档不得包含平台标识、资源Key、URL、AES Key、token、票面正文或实际敏感值。
- 正式微信保持关闭；真实微信仅在已批准的隔离测试 Vault 中临时启用。
- 正式飞书和隔离微信不得同时建立第二个飞书事件消费者。
- 组件、Skill和新 Schema必须原子部署；不长期兼容新旧两套 invoice Schema。
- 未完成完整回归、恢复演练和受控真实验收前，不提交“已修复”结论，不启用正式微信。

---

## File and Interface Map

### Skills repository

- Modify: `.agents/skills/filing-invoices/SKILL.md` — 将 AI 职责改为事实提取，Node.js职责改为唯一规则派生。
- Modify: `.agents/skills/filing-invoices/references/output-schema.json` — 新 `InvoiceExtraction` Schema。
- Modify: `.agents/skills/filing-invoices/evals/cases.jsonl` — 评测只断言提取事实、质量、类别和文档状态，不再断言 AI action。

### Component repository

- Modify: `src/capabilities/invoice/decision-client.mjs` — 提示只允许输出 `InvoiceExtraction`。
- Modify: `src/capabilities/invoice/decision-validator.mjs` — 导出 `validateInvoiceExtraction()` 与 `deriveInvoiceRuleDecision()`。
- Modify: `src/capabilities/invoice/capability.mjs` — 串联 extraction、规则派生、receipt和 writer。
- Modify: `src/capabilities/invoice/receipt.mjs` — 只根据 Node.js reason code生成业务回执。
- Modify: `test/filing-invoices-skill-contract.test.mjs`
- Modify: `test/invoice-decision-client.test.mjs`
- Modify: `test/invoice-decision-validator.test.mjs`
- Modify: `test/invoice-capability.test.mjs`
- Modify: `test/dispatcher.test.mjs`
- Modify: `test/privacy.test.mjs`（仅当现有日志/错误断言需要加入新技术分类）。
- Modify: `.llw-system/SYSTEM_MAP.md` — 只在部署和真实验收完成后更新当前事实。

### Fixed interfaces

```js
validateInvoiceExtraction(raw)
// -> deep-cloned InvoiceExtraction
// throws only on invalid/unknown/missing Schema or value/quality contradiction

deriveInvoiceRuleDecision(extraction)
// -> InvoiceRuleDecision
// never throws for an expected business mismatch, missing field or unclear field

formatNonArchive(ruleDecision)
// -> {status:"rejected"|"awaiting_clarification",reply:string,artifacts:[]}
```

`InvoiceExtraction` and `InvoiceRuleDecision` must exactly match V3.6.1 section 6.7.

---

### Task 1: Freeze Current Facts and Build the Protected Rollback Point

**Files:**
- Read: component Git repository, Skills Git repository, version 4 config/state/model/wechat state, heartbeat and LaunchAgent plist.
- Create outside Git: protected baseline under `~/Library/Application Support/LLW Assistant/backups/baselines/`.
- Create temporarily: `/private/tmp/<fresh-restore-directory>/`.

**Interfaces:**
- Consumes: current local production branch and current Skills working tree.
- Produces: verified component/Skills bundles, current working-tree Skill snapshot, config/state artifacts, manifest and restore evidence.

- [ ] **Step 1: Read current facts without changing them**

Run exact read-only commands:

```bash
git -C "/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work" status --short --branch
git -C "/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work" rev-parse HEAD
git -C "/Volumes/ZHUTONG/LLW的私人助手/LLW/.agents/skills" status --short --branch
git -C "/Volumes/ZHUTONG/LLW的私人助手/LLW/.agents/skills" rev-parse HEAD
/usr/local/bin/npm test
```

Run `npm test` with the component repository as `cwd`. Expected: exit `0`; record the actual pass total instead of copying an old number.

- [ ] **Step 2: Create a fresh implementation worktree**

Create branch `fix/v361-invoice-extraction-node-decision` from the exact current production commit. Expected: clean worktree and the same full regression total as Step 1.

- [ ] **Step 3: Create protected rollback artifacts**

The baseline must contain:

```text
component.bundle
skills.bundle
skills-working-tree.tar
config.json
state.json
model-state
wechat-state.json
heartbeat.json
com.llw.feishu-daily-work.plist
manifest.sha256
```

Directory mode must be `0700`; files `0600`. Do not include Vault files, Keychain values or ordinary logs.

- [ ] **Step 4: Restore into a fresh `/private/tmp` directory**

Verify:

```text
manifest: all OK
component bundle: fsck OK
skills bundle: fsck OK
component checkout: exact pre-change commit
Skill snapshot: content match excluding AppleDouble ._* metadata
config: version 4
formal wechatEnabled: false
plist: plutil -lint OK
restored component full test: exit 0
```

- [ ] **Step 5: Remove only the newly created restore directory**

Delete the exact validated `/private/tmp/<fresh-restore-directory>` after recording safe evidence. Do not delete the protected rollback point.

---

### Task 2: Replace the AI Decision Contract with `InvoiceExtraction`

**Files:**
- Modify: `.agents/skills/filing-invoices/SKILL.md`
- Modify: `.agents/skills/filing-invoices/references/output-schema.json`
- Modify: `.agents/skills/filing-invoices/evals/cases.jsonl`
- Modify: `test/filing-invoices-skill-contract.test.mjs`

**Interfaces:**
- Consumes: V3.6.1 `InvoiceExtraction`.
- Produces: one strict Schema with no action or user-facing text.

- [ ] **Step 1: Write the failing Skill contract test**

Add assertions equivalent to:

```js
assert.deepEqual(schema.required,[
  "invoice","field_quality","category","document_verification"
]);
for (const removed of [
  "action","confidence","reason","question","buyer_verification","file_format"
]) {
  assert.equal(JSON.stringify(schema).includes(`"${removed}"`),false);
}
assert.deepEqual(
  schema.properties.field_quality.properties.buyer_name.enum,
  ["clear","missing","unclear"]
);
assert.match(skill,/AI 只负责逐字读取票面事实/);
assert.match(skill,/Node\\.js 唯一决定归档、拒绝或澄清/);
```

- [ ] **Step 2: Run the focused test and verify RED**

```bash
/usr/local/bin/node --test test/filing-invoices-skill-contract.test.mjs
```

Expected: FAIL because the current Schema still requires `action`, `confidence`, `reason`, `question` and `buyer_verification`.

- [ ] **Step 3: Write the exact extraction Schema**

The top-level object must have `additionalProperties:false` and exactly:

```json
{
  "required": ["invoice", "field_quality", "category", "document_verification"]
}
```

Both `invoice` and `field_quality` must require exactly:

```text
invoice_number
issue_date
buyer_name
buyer_tax_id
seller_name
item_name
total_with_tax
```

Every invoice value is a string. Every quality value enum is `clear/missing/unclear`. Keep the existing category and document enums.

- [ ] **Step 4: Rewrite the three closed eval cases**

Use only synthetic facts. Expected cases:

```json
{"id":"invoice-positive-dining","expected":{"field_quality":"all_clear","category":"dining","document_verification":"single_invoice"}}
{"id":"invoice-negative-buyer-mismatch","expected":{"field_quality":"all_clear","category":"dining","document_verification":"single_invoice"}}
{"id":"invoice-boundary-multiple-invoices","expected":{"document_verification":"multiple_invoices"}}
```

The negative case must not expect an AI `reject`; Node.js derives that later.

- [ ] **Step 5: Update `SKILL.md`**

State explicitly:

```text
[AI] 逐字读取最小必要字段、字段质量、餐饮语义和文档完整性。
[程序] 验证Schema并唯一派生archive_dining/reject/needs_clarification。
[程序] 购买方名称和税号逐字符精确比较。
[程序] 只根据reasonCode生成回复和授权writer。
```

Remove any instruction telling AI to choose archive/reject/clarify or compose a user question.

- [ ] **Step 6: Run the contract test and verify GREEN**

Expected: focused Skill contract test passes and JSON parses successfully.

- [ ] **Step 7: Commit the Skills contract**

```bash
git add filing-invoices/SKILL.md filing-invoices/references/output-schema.json filing-invoices/evals/cases.jsonl
git commit -m "refactor: make invoice AI extraction-only"
```

Do not include unrelated existing Router Skill changes in this commit.

---

### Task 3: Validate Extraction and Derive the Only Business Decision in Node.js

**Files:**
- Modify: `src/capabilities/invoice/decision-validator.mjs`
- Modify: `test/invoice-decision-validator.test.mjs`

**Interfaces:**
- Produces: `validateInvoiceExtraction(raw)` and `deriveInvoiceRuleDecision(extraction)`.
- Used by: invoice capability and receipt tasks.

- [ ] **Step 1: Replace test fixtures with extraction fixtures**

Define:

```js
function clearExtraction(overrides={}) {
  return {
    invoice:{
      invoice_number:"123456789012",
      issue_date:"2026-07-18",
      buyer_name:"亚信科技（成都）有限公司",
      buyer_tax_id:"91510100732356360H",
      seller_name:"测试餐饮有限公司",
      item_name:"餐饮服务",
      total_with_tax:"290.00",
      ...(overrides.invoice||{})
    },
    field_quality:{
      invoice_number:"clear",
      issue_date:"clear",
      buyer_name:"clear",
      buyer_tax_id:"clear",
      seller_name:"clear",
      item_name:"clear",
      total_with_tax:"clear",
      ...(overrides.field_quality||{})
    },
    category:overrides.category||"dining",
    document_verification:overrides.document_verification||"single_invoice"
  };
}
```

- [ ] **Step 2: Write failing validation tests**

Cover:

```js
assert.deepEqual(validateInvoiceExtraction(clearExtraction()),clearExtraction());
assert.throws(()=>validateInvoiceExtraction({...clearExtraction(),action:"archive_dining"}),/unknown_extraction_field/);
assert.throws(()=>validateInvoiceExtraction(clearExtraction({
  invoice:{buyer_name:""},
  field_quality:{buyer_name:"clear"}
})),/invalid_field_quality_value_pair/);
```

- [ ] **Step 3: Write failing deterministic rule tests**

Required assertions:

```js
assert.equal(deriveInvoiceRuleDecision(clearExtraction()).reasonCode,"eligible");
assert.equal(deriveInvoiceRuleDecision(clearExtraction({
  invoice:{buyer_name:"其他公司"}
})).reasonCode,"buyer_name_mismatch");
assert.equal(deriveInvoiceRuleDecision(clearExtraction({
  invoice:{buyer_tax_id:"OTHER"}
})).reasonCode,"buyer_tax_id_mismatch");
assert.equal(deriveInvoiceRuleDecision(clearExtraction({
  invoice:{buyer_name:"其他公司",buyer_tax_id:"OTHER"}
})).reasonCode,"buyer_identity_mismatch");
```

Also cover `non_dining`, every `missing/unclear` field, `uncertain`, all non-single document states, invalid invoice number, invalid date and invalid amount. Assert every non-eligible decision has no archive authorization.

- [ ] **Step 4: Run tests and verify RED**

Expected: imports or assertions fail because the new exports do not exist.

- [ ] **Step 5: Implement `validateInvoiceExtraction()`**

Rules:

```text
exact top-level keys
exact invoice keys
exact field_quality keys
allowed enums only
clear -> non-empty value
missing/unclear -> empty value
deep clone on success
```

Do not compare buyer identity or choose a business action in this function.

- [ ] **Step 6: Implement `deriveInvoiceRuleDecision()`**

Apply deterministic order:

```text
document not single -> needs_clarification
missing quality -> needs_clarification/required_field_missing
unclear quality -> needs_clarification/required_field_unclear
buyer name + tax mismatch -> reject/buyer_identity_mismatch
name only -> reject/buyer_name_mismatch
tax only -> reject/buyer_tax_id_mismatch
non_dining -> reject/non_dining
uncertain -> needs_clarification/category_uncertain
invalid invoice number -> needs_clarification/invoice_number_invalid
invalid date -> needs_clarification/issue_date_invalid
invalid amount -> needs_clarification/total_invalid
otherwise -> archive_dining/eligible
```

Return a deep clone of the normalized invoice only for `eligible`.

- [ ] **Step 7: Run tests and verify GREEN**

Run the focused validator test. Expected: all focused tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/capabilities/invoice/decision-validator.mjs test/invoice-decision-validator.test.mjs
git commit -m "refactor: derive invoice decisions in Node"
```

---

### Task 4: Make the Codex Client Produce Facts Only

**Files:**
- Modify: `src/capabilities/invoice/decision-client.mjs`
- Modify: `test/invoice-decision-client.test.mjs`

**Interfaces:**
- Consumes: existing `AnalysisInput`.
- Produces: raw `InvoiceExtraction`; no business action.

- [ ] **Step 1: Write failing prompt and fake-output tests**

Assert the prompt contains:

```text
逐字读取票面值
每个字段输出clear/missing/unclear
不要判断是否归档、拒绝或澄清
不要输出用户回复
```

Assert it does not request `archive_dining`, `reject`, `buyer_verification`, `reason` or `question`.

- [ ] **Step 2: Run the focused client test and verify RED**

Expected: FAIL because the current prompt asks the Skill to output an action decision.

- [ ] **Step 3: Update the prompt**

Keep:

```text
$filing-invoices
$pdf for PDF only
all PDF pages
untrusted image/text boundary
program detected format and page count
read-only Codex
medium reasoning
strict output Schema
```

Replace action language with extraction-only language. Do not change retry count, timeout, sandbox or image arguments.

- [ ] **Step 4: Update fake Codex outputs**

All fake outputs must match `InvoiceExtraction`. Keep the existing test proving exactly one retry after a nonzero Codex exit and no retry for invalid JSON.

- [ ] **Step 5: Run focused tests and verify GREEN**

- [ ] **Step 6: Commit**

```bash
git add src/capabilities/invoice/decision-client.mjs test/invoice-decision-client.test.mjs
git commit -m "refactor: request invoice facts from Codex"
```

---

### Task 5: Integrate Extraction, Rule Decision and Fixed Receipts

**Files:**
- Modify: `src/capabilities/invoice/capability.mjs`
- Modify: `src/capabilities/invoice/receipt.mjs`
- Modify: `test/invoice-capability.test.mjs`

**Interfaces:**
- Consumes: validated extraction and deterministic rule decision.
- Produces: existing OutcomeDraft statuses and existing writer input.

- [ ] **Step 1: Write failing capability tests for all buyer outcomes**

For the same prepared PNG path, stub `decide()` with extraction values and assert:

```text
name mismatch -> rejected, reply mentions购买方名称, writer 0
tax mismatch -> rejected, reply mentions税号, writer 0
both mismatch -> rejected, reply mentions名称和税号, writer 0
```

Explicitly assert none of these replies contains `AI 暂时不可用`.

- [ ] **Step 2: Write failing clarification and technical failure tests**

Assert:

```text
missing/unclear -> awaiting_clarification, writer 0
non_dining -> rejected, writer 0
invalid JSON or decide throw -> failed with AI technical reply
unknown extraction field -> failed, not buyer mismatch
eligible -> writer exactly 1
```

- [ ] **Step 3: Run focused tests and verify RED**

Expected: mismatch cases currently return generic `analyze` failure or current action-based results.

- [ ] **Step 4: Update capability flow**

Implement:

```js
const raw=await decide({analysisInput});
const extraction=validateInvoiceExtraction(raw);
const ruleDecision=deriveInvoiceRuleDecision(extraction);
if (ruleDecision.action!=="archive_dining") return formatNonArchive(ruleDecision);
const archived=await writer.archive({
  transactionId,
  source:analysisInput.originalFile,
  invoice:ruleDecision.invoice,
  extension:analysisInput.archiveExtension
});
```

Expected business outcomes must not throw. Model, JSON, Schema and unknown program errors remain in the existing safe technical catch.

- [ ] **Step 5: Replace free-text receipts with reason-code mapping**

Use fixed messages:

```js
buyer_name_mismatch:
  "发票未归档：未通过入库核验。\n原因：购买方名称与指定归档主体不匹配。"
buyer_tax_id_mismatch:
  "发票未归档：未通过入库核验。\n原因：购买方统一社会信用代码/纳税人识别号与指定归档主体不匹配。"
buyer_identity_mismatch:
  "发票未归档：未通过入库核验。\n原因：购买方名称和统一社会信用代码/纳税人识别号均与指定归档主体不匹配。"
non_dining:
  "发票未归档：未通过入库核验。\n原因：票面项目不属于当前已启用的餐饮发票类别。"
```

Clarification messages must identify only the missing class, not echo invoice values. Unknown reason code must throw `invalid_invoice_rule_decision`.

- [ ] **Step 6: Run focused tests and verify GREEN**

- [ ] **Step 7: Verify writer invariants**

Run:

```bash
/usr/local/bin/node --test \
  test/invoice-capability.test.mjs \
  test/invoice-decision-validator.test.mjs \
  test/invoice-archive-writer.test.mjs
```

Expected: exit `0`; only eligible extraction reaches writer.

- [ ] **Step 8: Commit**

```bash
git add src/capabilities/invoice/capability.mjs src/capabilities/invoice/receipt.mjs test/invoice-capability.test.mjs
git commit -m "fix: return deterministic invoice rule outcomes"
```

---

### Task 6: Prove Feishu and WeChat Use the Same Rule Core

**Files:**
- Modify: `test/dispatcher.test.mjs`
- Modify: `test/incoming-message.test.mjs` only if an existing fixture needs the new extraction shape.

**Interfaces:**
- Consumes: two channel messages and one identical extraction fixture.
- Produces: identical decision category, reply and artifact count.

- [ ] **Step 1: Write the failing cross-channel test**

Create one Feishu image message and one WeChat image message that both reach `invoice`. Stub `router.visual` to `route/invoice` and `invoice.visual` to the same buyer-identity-mismatch extraction.

Assert:

```js
assert.deepEqual(
  sends.map(item=>({source:item.replyTarget.source,text:item.text})),
  [
    {source:"feishu",text:expectedMismatchReply},
    {source:"wechat",text:expectedMismatchReply}
  ]
);
assert.deepEqual(writes,[]);
```

- [ ] **Step 2: Run the dispatcher test and verify RED**

- [ ] **Step 3: Make only fixture/composition changes needed for GREEN**

Do not add source-specific branches. If production code needs an `if (source==="wechat")` to choose a business result or receipt, stop: that violates V3.6.1.

- [ ] **Step 4: Add eligible-path equivalence**

For a synthetic exact buyer/tax dining extraction, assert both sources call the same writer contract. Use a fake writer; do not write real Vault files in the unit test.

- [ ] **Step 5: Run dispatcher, channel messenger and WeChat runtime tests**

```bash
/usr/local/bin/node --test \
  test/dispatcher.test.mjs \
  test/channel-messenger.test.mjs \
  test/lark-runtime.test.mjs \
  test/wechat-runtime.test.mjs \
  test/wechat-reply.test.mjs
```

- [ ] **Step 6: Commit**

```bash
git add test/dispatcher.test.mjs test/incoming-message.test.mjs
git commit -m "test: prove invoice outcomes match across channels"
```

---

### Task 7: Run Skill, Invoice, Visual, PDF and Full Regression Gates

**Files:**
- No new production files.
- Read: all modified files and current test output.

**Interfaces:**
- Consumes: completed isolated implementation.
- Produces: fresh evidence for every affected boundary.

- [ ] **Step 1: Run Skill and Schema gates**

```bash
/usr/local/bin/node --test \
  test/filing-invoices-skill-contract.test.mjs \
  test/intent-routing-skill-contract.test.mjs
```

- [ ] **Step 2: Run all invoice tests**

```bash
/usr/local/bin/node --test test/invoice-*.test.mjs
```

- [ ] **Step 3: Run routing and dual-entry tests**

```bash
/usr/local/bin/node --test \
  test/dispatcher.test.mjs \
  test/intent-router-client.test.mjs \
  test/semantic-tasks.test.mjs \
  test/prepared-image.test.mjs \
  test/wechat-api.test.mjs \
  test/wechat-resource-downloader.test.mjs \
  test/wechat-runtime.test.mjs
```

- [ ] **Step 4: Run privacy tests**

```bash
/usr/local/bin/node --test test/privacy.test.mjs
```

Expected: no output contains fixture invoice values, platform identifiers, URLs, keys or paths.

- [ ] **Step 5: Run full regression**

```bash
/usr/local/bin/npm test
```

Expected: exit `0`, failures `0`. Record the new actual total.

- [ ] **Step 6: Inspect exact diff**

Expected production diff is limited to:

```text
filing-invoices Skill/Schema/evals
invoice decision client
invoice validator/rule derivation
invoice capability/receipt
affected tests
V3.6.1 plan/docs
```

No source-specific invoice rule, state migration, dependency, package-lock, entry protocol or Obsidian change is allowed.

---

### Task 8: Test Vault, Restore Exercise and Deployment Preparation

**Files:**
- Use: existing isolated Gate B test config and Vault.
- Do not modify: formal Vault data.

**Interfaces:**
- Consumes: all-green isolated commits.
- Produces: deployment candidate and verified rollback.

- [ ] **Step 1: Build a deployment candidate from the exact tested commit**

Record component commit and Skills commit/snapshot. Do not deploy from an uncommitted source tree.

- [ ] **Step 2: Repeat manifest and restore verification**

Restore the pre-deploy rollback point into a new `/private/tmp` directory and run its full regression. Expected: old component and old Schema work together.

- [ ] **Step 3: Validate atomic compatibility**

Prove:

```text
new component + new Schema -> tests pass
old component + old Schema -> restore tests pass
new component + old Schema -> must not be deployed
old component + new Schema -> must not be deployed
```

No long-term dual Schema logic may be added.

- [ ] **Step 4: Verify formal configuration**

Expected:

```text
version=4
model=codex
formal wechatEnabled=false
formal Vault unchanged
plist valid
```

- [ ] **Step 5: Start only the isolated test service**

Unload the formal LaunchAgent first so only one Feishu event consumer exists. Start the tested component against the isolated config with `wechatEnabled=true`; verify heartbeat and no startup error.

---

### Task 9: Controlled Real Acceptance

**Files:**
- Runtime only; no new source edits during acceptance.
- Update docs only after all acceptance results are known.

**Interfaces:**
- Consumes: isolated test service and synthetic test files.
- Produces: evidence for correct reject, clarification, archive and cross-channel equivalence.

- [ ] **Step 1: Re-send the fixed buyer-mismatch invoice through WeChat**

Expected:

```text
route=invoice
ruleDecision=reject/buyer_identity_mismatch or the exact observed mismatch combination
reply states the deterministic mismatch
status=rejected
artifact_count=0
writer_count=0
temporary files=0
```

It must not reply `AI 暂时不可用`.

- [ ] **Step 2: Send the same fixed file through Feishu**

Expected: same reason code, same reply text, same zero-artifact result. Channel reply mechanics differ; business result does not.

- [ ] **Step 3: Test one unclear synthetic invoice**

Expected: `awaiting_clarification`, fixed missing/unclear reply, zero writer, temp cleanup.

- [ ] **Step 4: Test one eligible synthetic dining invoice**

Use only a pre-approved synthetic fixture whose buyer name, tax ID, category, date, amount and invoice number satisfy all rules. Expected:

```text
archive_dining/eligible
writer exactly once
original file archived
source/target SHA-256 equal
transaction published
reply committed
```

If the user does not approve a real write even in the isolated Vault, keep this as an automated writer test and do not claim real archive acceptance.

- [ ] **Step 5: Confirm service health and isolation**

Expected:

```text
isolated heartbeat fresh
one Node main
one lark-cli consumer
formal Vault unchanged
formal wechatEnabled=false
no pending reply
no open invoice conversation after reject/commit
```

- [ ] **Step 6: Stop isolated service and restore formal LaunchAgent**

Restore the formal service with `wechatEnabled=false`; verify version 4, Codex, fresh heartbeat, one consumer and last exit `0`.

---

### Task 10: Documentation, Final Verification, Commit and Push

**Files:**
- Modify: `.llw-system/SYSTEM_MAP.md`
- Add to component docs: `docs/superpowers/plans/2026-07-24-v361-invoice-extraction-node-decision.md`
- Preserve externally: `LLW_PERSONAL_AI_SKILL_PLATFORM_MASTER_CONSTRUCTION_BASELINE_V3_6_1.md`

**Interfaces:**
- Consumes: fresh full regression, acceptance and health evidence.
- Produces: auditable current facts and synchronized GitHub branches.

- [ ] **Step 1: Update `SYSTEM_MAP.md`**

Record only confirmed facts:

```text
V3.6.1 extraction-only invoice contract
Node.js unique rule derivation
actual component and Skills commits
actual full test total
actual isolated acceptance results
rollback path and restore result
formal model/config/wechat state
single-consumer health
```

Do not store invoice values, platform identifiers or message content.

- [ ] **Step 2: Run the final full regression again**

```bash
/usr/local/bin/npm test
```

Expected: exit `0`, failures `0`.

- [ ] **Step 3: Run final Git and documentation checks**

```bash
git status --short --branch
git diff --check
rg -n 'TBD|TODO|fill in|implement later' docs/superpowers/plans/2026-07-24-v361-invoice-extraction-node-decision.md
```

Expected: no diff whitespace errors and no placeholders.

- [ ] **Step 4: Commit component documentation/final integration**

```bash
git add src test docs/superpowers/plans/2026-07-24-v361-invoice-extraction-node-decision.md
git commit -m "fix: make invoice outcomes deterministic"
```

Commit Skills separately in the Skills repository; do not combine unrelated dirty Router files.

- [ ] **Step 5: Push verified branches**

Push only after the user-authorized acceptance and fresh final verification. Report:

```text
component branch and commit
Skills branch and commit
remote push result
formal production state
formal WeChat remains disabled unless separately approved
```

- [ ] **Step 6: Preserve rollback and remove only disposable worktrees**

Do not delete the protected rollback baseline. Remove implementation worktrees only after commits are pushed and the formal service health check is complete.

---

## Plan Self-Review Checklist

- [ ] Every V3.6.1 requirement maps to a task.
- [ ] No task creates a second channel-specific invoice rule.
- [ ] No task lets AI output a final action or user reply.
- [ ] All expected business mismatches become deterministic Node.js outcomes.
- [ ] Technical failures remain distinguishable from business rejection.
- [ ] Writer authorization is no broader than before.
- [ ] New and old Schema are never mixed in deployment.
- [ ] TDD RED and GREEN commands are explicit.
- [ ] Rollback includes both component and current Skills state.
- [ ] Formal WeChat remains disabled pending separate approval.
- [ ] No placeholder language remains.
