# V3.6.3 Invoice Minimal Eligibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make buyer name, buyer tax ID, and dining category the only invoice business-eligibility gates while safely normalizing clear dates and amounts for Obsidian storage and numbering same-month equal-amount invoices as amount, amount-2, amount-3.

**Architecture:** Keep the current extraction-only AI Schema and the single Feishu/WeChat invoice core. `decision-validator.mjs` will select only the approved business facts and derive a normalized storage candidate; `archive-writer.mjs` will perform deterministic SHA-256 idempotency and sequential same-month naming. The existing capability, transaction state, exclusive copy, reply routing, Vault boundary, and model boundary remain unchanged.

**Tech Stack:** Node.js 24 ESM, `node:test`, built-in `fs/promises`, existing Codex `invoice.visual`, Markdown Skill contracts, Git.

## Global Constraints

- V3.6.3 is the only forward implementation baseline; V3.6.2 remains unchanged as history.
- AI continues to return the current exact `InvoiceExtraction` Schema and never returns actions or user replies.
- Only exact buyer name, exact buyer tax ID, and `category=dining` decide business eligibility.
- Date and amount must be clear and safely normalizable, but their display format does not decide business eligibility.
- A single attachment containing multiple invoices is never auto-cropped or auto-split.
- Same-month equal-amount originals use `<amount>.<ext>`, `<amount>-2.<ext>`, `<amount>-3.<ext>` and the smallest available sequence.
- Same SHA-256 is existing; different content is never overwritten.
- Feishu and WeChat use one decision function, writer, and receipt.
- No new dependency, service, database, state version, Skill, Capability, model, permission, binding, or LaunchAgent.
- Formal `wechatEnabled=true`, Codex mode, Vault root, archive root, and PDF preparation boundaries remain unchanged.
- Tests must be red before implementation and the complete regression must be green before deployment.

---

## File Structure

**Component files modified**

- `src/capabilities/invoice/decision-validator.mjs` — retain exact extraction validation; derive approved eligibility and normalize storage date/amount.
- `src/capabilities/invoice/archive-writer.mjs` — scan same-month amount candidates, perform hash idempotency, and choose the smallest sequential filename.
- `src/capabilities/invoice/receipt.mjs` — remove obsolete format-gate wording and provide the approved multi-invoice and unreadable-storage replies.
- `test/invoice-capability.test.mjs` — business-gate, normalization, writer-call, and receipt behavior.
- `test/invoice-archive-writer.test.mjs` — sequential names, cross-month reset, cross-extension occupancy, idempotency, race, and no-overwrite.
- `test/dispatcher.test.mjs` — Feishu/WeChat equivalence with Chinese date and currency-symbol amount.
- `test/filing-invoices-skill-contract.test.mjs` — versioned Skill boundary assertions.
- `docs/superpowers/plans/2026-07-24-v363-invoice-minimal-eligibility.md` — this implementation record.

**Skill files modified**

- `.agents/skills/filing-invoices/SKILL.md` — approved responsibilities, gates, normalization, multi-invoice reply, and naming.
- `.agents/skills/filing-invoices/evals/cases.jsonl` — positive display-format case and single-attachment/multiple-invoice boundary.

**Documents modified after acceptance**

- `.llw-system/SYSTEM_MAP.md` — deployed component/Skills commits, test total, formal WeChat state, rollback evidence, and acceptance result.

**Files explicitly unchanged**

- `.agents/skills/filing-invoices/references/output-schema.json`
- `src/capabilities/invoice/capability.mjs`
- `src/core/dispatcher.mjs`
- all Feishu/WeChat protocol adapters
- `src/state-store.mjs`
- production configuration shape and state version

---

### Task 1: Establish Isolated Execution and Baseline Evidence

**Files:**
- Read: `/Users/ccrt/Downloads/LLW_PERSONAL_AI_SKILL_PLATFORM_MASTER_CONSTRUCTION_BASELINE_V3_6_3.md`
- Read: `.llw-system/README.md`
- Create worktree: `/private/tmp/llw-v363-invoice-minimal-eligibility`
- Create branch: `fix/v363-invoice-minimal-eligibility`

**Interfaces:**
- Consumes: production component HEAD, Skills HEAD, config version 4, `wechatEnabled=true`.
- Produces: isolated clean worktree and a recorded green baseline.

- [ ] **Step 1: Re-read mandatory boundaries and component instructions**

Run:

```bash
cat .llw-system/README.md
cat /Users/ccrt/Downloads/LLW_PERSONAL_AI_SKILL_PLATFORM_MASTER_CONSTRUCTION_BASELINE_V3_6_3.md
find "/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work" -name AGENTS.md -print
```

Expected: V3.6.3 identifies Section 16 as the current task; no component `AGENTS.md` is skipped.

- [ ] **Step 2: Capture only non-sensitive production facts**

Run:

```bash
node --input-type=module - \
"/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/src/config.mjs" \
"/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/src/state-store.mjs" \
"/Users/ccrt/Library/Application Support/LLW Assistant/state/feishu-daily-work/config.json" <<'NODE'
import {readFile} from "node:fs/promises";
import {pathToFileURL} from "node:url";
const [configModule,stateModule,configPath]=process.argv.slice(2);
const {loadConfig}=await import(pathToFileURL(configModule));
const {StateStore}=await import(pathToFileURL(stateModule));
const config=await loadConfig(configPath);
const state=await StateStore.open(config.stateFile);
const model=(await readFile(config.modelStateFile,"utf8")).trim();
console.log(JSON.stringify({
  configVersion:config.version,
  stateVersion:state.version(),
  wechatEnabled:config.wechatEnabled,
  model,
  unreplied:state.unreplied().length
}));
NODE
```

Expected exact values:

```json
{"configVersion":4,"stateVersion":4,"wechatEnabled":true,"model":"codex","unreplied":0}
```

Then run:

```bash
git -C "/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work" status --short
git -C "/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work" rev-parse HEAD
git -C "/Volumes/ZHUTONG/LLW的私人助手/LLW/.agents/skills" status --short
git -C "/Volumes/ZHUTONG/LLW的私人助手/LLW/.agents/skills" rev-parse HEAD
launchctl print gui/501/com.llw.feishu-daily-work
```

Expected: both repositories are clean, the service is running, and no secret, message, invoice value, or platform identifier is printed.

- [ ] **Step 3: Run the existing complete regression before changes**

Run:

```bash
npm test
```

Expected: all current tests pass; record the exact total in the protected baseline facts.

- [ ] **Step 4: Create the isolated worktree**

Run from the component repository:

```bash
git worktree add -b fix/v363-invoice-minimal-eligibility /private/tmp/llw-v363-invoice-minimal-eligibility production/v32-phase4-wechat
```

Expected: `/private/tmp/llw-v363-invoice-minimal-eligibility` is clean and starts at the approved V3.6.3 design commit.

---

### Task 2: Lock the Skill Contract Before Runtime Changes

**Files:**
- Modify: `/Volumes/ZHUTONG/LLW的私人助手/LLW/.agents/skills/filing-invoices/SKILL.md`
- Modify: `/Volumes/ZHUTONG/LLW的私人助手/LLW/.agents/skills/filing-invoices/evals/cases.jsonl`
- Modify: `/private/tmp/llw-v363-invoice-minimal-eligibility/test/filing-invoices-skill-contract.test.mjs`
- Unchanged: `/Volumes/ZHUTONG/LLW的私人助手/LLW/.agents/skills/filing-invoices/references/output-schema.json`

**Interfaces:**
- Consumes: the current extraction-only `InvoiceExtraction`.
- Produces: a versioned contract stating that only buyer name, buyer tax ID, and dining category decide eligibility; date and amount are storage inputs.

- [ ] **Step 1: Add failing Skill contract assertions**

Add these assertions:

```js
assert.match(skill,/购买方名称、.*统一社会信用代码.*餐饮.*唯一.*入库资格/s);
assert.match(skill,/日期.*只用于.*月份文件夹/s);
assert.match(skill,/金额.*只用于.*文件名/s);
assert.match(skill,/`¥`.*`￥`.*规范化/s);
assert.match(skill,/金额.*金额-2.*金额-3/s);
assert.match(skill,/一次只发送一张.*发票/s);
assert.match(skill,/发票号码.*不.*入库门槛/s);
assert.deepEqual(schema.required,["invoice","field_quality","category","document_verification"]);
```

- [ ] **Step 2: Run the contract test and verify RED**

Run:

```bash
LLW_SKILLS_ROOT="/Volumes/ZHUTONG/LLW的私人助手/LLW/.agents/skills" \
node --test test/filing-invoices-skill-contract.test.mjs
```

Expected: FAIL only because the newly approved V3.6.3 wording is absent.

- [ ] **Step 3: Update the existing Skill without changing the Schema**

Replace the Skill's business-invariant and storage-naming paragraphs with these exact requirements:

```text
AI: one clear complete invoice, raw facts, field quality, dining semantics
Node business gate: buyer_name + buyer_tax_id + category
Node storage preparation: normalize clear issue_date + total_with_tax
Multiple invoices in one attachment: no split, ask for one invoice
Naming: amount, amount-2, amount-3 per month
invoice_number/seller/item formats: not independent eligibility gates
```

Update `evals/cases.jsonl` with:

```json
{"id":"invoice-positive-display-formats","kind":"positive","task":"invoice.visual","input":{"document":{"format":"png","page_count":1,"evidence":"一张清晰完整餐饮发票，购买方匹配，日期使用中文年月日，价税合计带人民币符号"}},"expected":{"field_quality":"required_storage_and_identity_clear","category":"dining","document_verification":"single_invoice"}}
```

Keep the existing multiple-invoice boundary case and change its evidence expectation to one fixed outcome: ask the user to send one invoice per attachment.

- [ ] **Step 4: Validate the Skill and contract**

Run:

```bash
LLW_SKILLS_ROOT="/Volumes/ZHUTONG/LLW的私人助手/LLW/.agents/skills" \
node --test test/filing-invoices-skill-contract.test.mjs
python3 "/Users/ccrt/.codex/skills/.system/skill-creator/scripts/quick_validate.py" \
"/Volumes/ZHUTONG/LLW的私人助手/LLW/.agents/skills/filing-invoices"
```

Expected: contract PASS and `Skill is valid!`.

- [ ] **Step 5: Commit the Skill contract**

Run in the Skills repository:

```bash
git add filing-invoices/SKILL.md filing-invoices/evals/cases.jsonl
git commit -m "docs: simplify invoice eligibility and storage rules"
```

Expected: one Skills commit containing no component code and no secrets.

---

### Task 3: Normalize Clear Date and Amount Without Expanding Business Eligibility

**Files:**
- Modify: `src/capabilities/invoice/decision-validator.mjs`
- Modify: `test/invoice-capability.test.mjs`

**Interfaces:**
- Consumes: `deriveInvoiceRuleDecision(extraction: InvoiceExtraction)`.
- Produces: unchanged decision union, with `archive_dining/eligible.invoice.issue_date` as `YYYY-MM-DD` and `.total_with_tax` as a two-decimal string.

- [ ] **Step 1: Add failing eligibility and normalization tests**

Add table-driven tests for:

```js
[
  ["2026年07月21日","￥498.00","2026-07-21","498.00"],
  ["2026-7-21","¥498.0","2026-07-21","498.00"],
  ["2026/07/21","1,498元","2026-07-21","1498.00"],
  ["2026.7.21","1498","2026-07-21","1498.00"]
]
```

For each case assert:

```js
const raw=extraction({invoice:{issue_date:inputDate,total_with_tax:inputAmount}});
const before=structuredClone(raw);
const decision=deriveInvoiceRuleDecision(raw);
assert.equal(decision.action,"archive_dining");
assert.equal(decision.reasonCode,"eligible");
assert.equal(decision.invoice.issue_date,expectedDate);
assert.equal(decision.invoice.total_with_tax,expectedAmount);
assert.deepEqual(raw,before);
```

Add non-gating tests:

```js
for (const field of ["invoice_number","seller_name","item_name"]) {
  const raw=extraction({invoice:{[field]:""},field_quality:{[field]:"missing"}});
  assert.equal(deriveInvoiceRuleDecision(raw).action,"archive_dining");
}
```

Add safe failure cases:

```js
[
  ["2026-02-30","498.00","issue_date_invalid"],
  ["2026年7月","498.00","issue_date_invalid"],
  ["2026-07-21","-498.00","total_invalid"],
  ["2026-07-21","1,49.00","total_invalid"],
  ["2026-07-21","4.98e2","total_invalid"]
]
```

- [ ] **Step 2: Run the target test and verify RED**

Run:

```bash
node --test test/invoice-capability.test.mjs
```

Expected: currency-symbol amount, added date forms, and ignored non-gating fields fail under the old rules.

- [ ] **Step 3: Implement the minimal decision changes**

Use only the four storage/identity quality fields:

```js
const REQUIRED_CLEAR_FIELDS=[
  "buyer_name","buyer_tax_id","issue_date","total_with_tax"
];
```

Replace the all-field quality gate with:

```js
const requiredQualities=REQUIRED_CLEAR_FIELDS.map(
  field=>extraction.field_quality[field]
);
if (requiredQualities.includes("missing")) return clarify("required_field_missing");
if (requiredQualities.includes("unclear")) return clarify("required_field_unclear");
```

Implement date normalization with four exact separators and one/two-digit month/day:

```js
function normalizeIssueDate(value) {
  const text=value.trim();
  const match=/^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text) ||
    /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(text) ||
    /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/.exec(text) ||
    /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(text);
  if (!match) return null;
  const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]);
  if (year<1000||year>9999) return null;
  const date=new Date(Date.UTC(year,month-1,day));
  if (date.getUTCFullYear()!==year||
      date.getUTCMonth()!==month-1||
      date.getUTCDate()!==day) return null;
  return `${match[1]}-${match[2].padStart(2,"0")}-${match[3].padStart(2,"0")}`;
}
```

Implement decimal-string normalization without `Number`:

```js
function normalizeAmount(value) {
  const match=/^[¥￥]?((?:0|[1-9][0-9]*|[1-9][0-9]{0,2}(?:,[0-9]{3})+)(?:\.[0-9]{1,2})?)元?$/.exec(value.trim());
  if (!match) return null;
  const [integer,fraction=""]=match[1].replaceAll(",","").split(".");
  if (integer==="0"&&!/[1-9]/.test(fraction)) return null;
  return `${integer}.${fraction.padEnd(2,"0")}`;
}
```

Create the eligible candidate only after both normalizers succeed:

```js
const issueDate=normalizeIssueDate(extraction.invoice.issue_date);
if (!issueDate) return clarify("issue_date_invalid");
const amount=normalizeAmount(extraction.invoice.total_with_tax);
if (!amount) return clarify("total_invalid");
return {
  action:"archive_dining",
  reasonCode:"eligible",
  invoice:{
    ...structuredClone(extraction.invoice),
    issue_date:issueDate,
    total_with_tax:amount
  }
};
```

- [ ] **Step 4: Run the target test and verify GREEN**

Run:

```bash
node --test test/invoice-capability.test.mjs
```

Expected: all invoice capability tests pass, including original extraction immutability.

- [ ] **Step 5: Commit the decision change**

Run:

```bash
git add src/capabilities/invoice/decision-validator.mjs test/invoice-capability.test.mjs
git commit -m "fix: separate invoice eligibility from storage formats"
```

---

### Task 4: Replace Invoice-Number Fallback With Same-Month Sequential Naming

**Files:**
- Modify: `src/capabilities/invoice/archive-writer.mjs`
- Modify: `test/invoice-archive-writer.test.mjs`

**Interfaces:**
- Consumes: `InvoiceArchiveWriter.archive({transactionId,source,invoice,extension})`, where invoice has normalized `issue_date` and `total_with_tax`.
- Produces: unchanged `{status:"committed"|"existing",relativePath}` with deterministic amount sequence names.

- [ ] **Step 1: Replace old fallback tests with failing sequence tests**

Assert:

```js
290.00.png
290.00-2.png
290.00-3.png
```

Add a cross-extension occupancy case:

```js
await writeFile(join(h.month,"290.00.pdf"),Buffer.from("other-pdf"));
const result=await h.writer.archive({
  transactionId:"cross-extension",
  source:h.source,
  invoice,
  extension:"png"
});
assert.equal(result.relativePath.endsWith("290.00-2.png"),true);
```

Add cross-month reset using `issue_date:"2026-08-01"` and expect `2026年08月/290.00.png`.

Retain and update the race test to expect `290.00-2.png`, and assert the primary file bytes remain unchanged.

- [ ] **Step 2: Run the writer test and verify RED**

Run:

```bash
node --test test/invoice-archive-writer.test.mjs
```

Expected: old `_INV123` fallback and two-candidate exhaustion fail the new requirements.

- [ ] **Step 3: Implement deterministic candidate scanning**

Import `readdir` and define:

```js
const ARCHIVE_EXTENSIONS=new Set(["jpg","jpeg","png","webp","pdf"]);
```

Change `validateInput` so `invoice_number` is not a writer input gate. Keep normalized date, normalized amount, transaction ID, source extension, Vault, and regular-file checks.

Implement a same-month scanner:

```js
async selectTarget(month,amount,extension,sourceHash) {
  const entries=await readdir(month,{withFileTypes:true});
  const occupied=new Set();
  for (const entry of entries) {
    const parsed=parseAmountCandidate(entry.name,amount);
    if (!parsed) continue;
    const target=join(month,entry.name);
    const state=await targetState(target,this.hashFile,sourceHash);
    if (state==="same") {
      return {status:"existing",relativePath:this.relativeArchivePath(month,entry.name)};
    }
    occupied.add(parsed.sequence);
  }
  let sequence=1;
  while (occupied.has(sequence)) sequence++;
  const base=sequence===1?amount:`${amount}-${sequence}`;
  return {status:"selected",fileName:`${base}.${extension}`};
}
```

`parseAmountCandidate(name,amount)` must:

- accept only supported archive extensions;
- map `<amount>.<ext>` to sequence 1;
- map `<amount>-N.<ext>` to integer sequence `N>=2`;
- reject leading-zero sequences, extra suffixes, directories, and unrelated names.

Keep `COPYFILE_EXCL`, transaction preparation, post-copy hash validation, and bounded race retry exactly as the safety boundary.

- [ ] **Step 4: Run writer and transaction tests**

Run:

```bash
node --test test/invoice-archive-writer.test.mjs test/state-store.test.mjs
```

Expected: all tests pass; no test expects invoice-number fallback or conflict clarification.

- [ ] **Step 5: Commit the writer change**

Run:

```bash
git add src/capabilities/invoice/archive-writer.mjs test/invoice-archive-writer.test.mjs
git commit -m "feat: sequence same-month equal-amount invoices"
```

---

### Task 5: Align Fixed Receipts and Channel Equivalence

**Files:**
- Modify: `src/capabilities/invoice/receipt.mjs`
- Modify: `test/invoice-capability.test.mjs`
- Modify: `test/dispatcher.test.mjs`

**Interfaces:**
- Consumes: approved `InvoiceRuleDecision` reason codes and committed/existing writer result.
- Produces: fixed Chinese replies identical across Feishu and WeChat.

- [ ] **Step 1: Add failing reply tests**

Assert the exact multi-invoice message contains:

```text
检测到一个附件包含多张发票，请一次只发送一张清晰完整的发票
```

Assert invalid storage values say they cannot be reliably used for archiving and ask for a clear complete original, without:

```text
AI 暂时不可用
购买方不匹配
```

Update the channel-equivalence eligible extraction to use:

```js
issue_date:"2026年07月21日"
total_with_tax:"￥290.00"
```

Assert both writer calls contain:

```js
issue_date:"2026-07-21"
total_with_tax:"290.00"
```

and both replies are identical.

- [ ] **Step 2: Run target tests and verify RED**

Run:

```bash
node --test test/invoice-capability.test.mjs test/dispatcher.test.mjs
```

Expected: old multi-invoice wording and old normalization assumptions fail.

- [ ] **Step 3: Make the minimal receipt changes**

Update reason-code text only:

```js
multiple_invoices:[
  "检测到一个附件包含多张发票。",
  "请一次只发送一张清晰完整的发票。"
]
```

Replace “格式不符合当前归档规则” for `issue_date_invalid` and `total_invalid` with wording that the clear value cannot be reliably converted for storage and asks for a clear complete original.

Remove the unreachable `archived.status==="awaiting_clarification"` branch for the old invoice-number conflict. `formatArchive` accepts only `committed` and `existing`.

- [ ] **Step 4: Run target tests and verify GREEN**

Run:

```bash
node --test test/invoice-capability.test.mjs test/dispatcher.test.mjs
```

Expected: all target tests pass and Feishu/WeChat replies are byte-identical.

- [ ] **Step 5: Commit receipt and equivalence**

Run:

```bash
git add src/capabilities/invoice/receipt.mjs test/invoice-capability.test.mjs test/dispatcher.test.mjs
git commit -m "fix: align invoice receipts with minimal eligibility"
```

---

### Task 6: Full Verification and Isolated Vault Acceptance

**Files:**
- Read: all changed files
- Create temporarily: `/private/tmp/llw-v363-test-vault-*`
- No production writes

**Interfaces:**
- Consumes: completed component and Skill commits.
- Produces: green target tests, green full regression, valid Skill, and isolated archive evidence.

- [ ] **Step 1: Run all targeted tests**

Run:

```bash
node --test \
  test/invoice-capability.test.mjs \
  test/invoice-archive-writer.test.mjs \
  test/dispatcher.test.mjs \
  test/filing-invoices-skill-contract.test.mjs
```

Expected: zero failures.

- [ ] **Step 2: Run the complete component regression**

Run:

```bash
npm test
```

Expected: zero failures; record the exact total.

- [ ] **Step 3: Validate the Skill**

Run:

```bash
python3 "/Users/ccrt/.codex/skills/.system/skill-creator/scripts/quick_validate.py" \
"/Volumes/ZHUTONG/LLW的私人助手/LLW/.agents/skills/filing-invoices"
```

Expected: `Skill is valid!`.

- [ ] **Step 4: Perform isolated Vault acceptance**

Create a fresh `mktemp -d /private/tmp/llw-v363-test-vault-XXXXXX` with:

```text
.obsidian/
.llw-system/SYSTEM_MAP.md
亚信工作/日常发票/餐饮发票/
```

Run this isolated acceptance from the feature worktree:

```bash
node --input-type=module - <<'NODE'
import {mkdtemp,mkdir,readFile,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {StateStore} from "./src/state-store.mjs";
import {InvoiceArchiveWriter,sha256File} from "./src/capabilities/invoice/archive-writer.mjs";

const root=await mkdtemp(join(tmpdir(),"llw-v363-test-vault-"));
try {
  const vault=join(root,"vault");
  await mkdir(join(vault,".obsidian"),{recursive:true});
  await mkdir(join(vault,".llw-system"),{recursive:true});
  await writeFile(join(vault,".llw-system","SYSTEM_MAP.md"),"test");
  await mkdir(join(vault,"亚信工作","日常发票","餐饮发票"),{recursive:true});
  const state=await StateStore.open(join(root,"state","state.json"));
  const writer=new InvoiceArchiveWriter({vaultRoot:vault,state});
  const sources=[
    ["a.png","A","2026-07-21","png"],
    ["b.png","B","2026-07-22","png"],
    ["c.pdf","C","2026-07-23","pdf"],
    ["d.png","D","2026-08-01","png"]
  ];
  const expected=[
    "亚信工作/日常发票/餐饮发票/2026年07月/498.00.png",
    "亚信工作/日常发票/餐饮发票/2026年07月/498.00-2.png",
    "亚信工作/日常发票/餐饮发票/2026年07月/498.00-3.pdf",
    "亚信工作/日常发票/餐饮发票/2026年08月/498.00.png"
  ];
  for (let index=0;index<sources.length;index++) {
    const [name,bytes,date,extension]=sources[index];
    const source=join(root,name);
    await writeFile(source,bytes);
    const result=await writer.archive({
      transactionId:`isolated-${index}`,
      source,
      invoice:{issue_date:date,total_with_tax:"498.00"},
      extension
    });
    if (result.status!=="committed"||result.relativePath!==expected[index]) {
      throw new Error(`unexpected_result:${index}`);
    }
    if (await sha256File(source)!==await sha256File(join(vault,result.relativePath))) {
      throw new Error(`hash_mismatch:${index}`);
    }
  }
  const repeat=await writer.archive({
    transactionId:"isolated-repeat",
    source:join(root,"a.png"),
    invoice:{issue_date:"2026-07-21",total_with_tax:"498.00"},
    extension:"png"
  });
  if (repeat.status!=="existing"||repeat.relativePath!==expected[0]) {
    throw new Error("idempotency_failed");
  }
  if (state.listInvoiceTransactions().some(item=>item.status!=="published")) {
    throw new Error("transaction_not_published");
  }
  console.log(JSON.stringify({isolatedVault:true,files:expected.length,idempotent:true}));
} finally {
  await rm(root,{recursive:true,force:true});
}
NODE
```

Expected:

```json
{"isolatedVault":true,"files":4,"idempotent":true}
```

- [ ] **Step 5: Review the diff for scope**

Run:

```bash
git diff production/v32-phase4-wechat...HEAD --check
git diff production/v32-phase4-wechat...HEAD --stat
git status --short
```

Expected: only the files listed in this plan changed; no config, state, protocol, secret, Vault content, dependency, or generated artifact is present.

---

### Task 7: Protected Rollback, Atomic Deployment, and Health

**Files:**
- Create protected directory: `/Users/ccrt/Library/Application Support/LLW Assistant/backups/baselines/v363-invoice-minimal-eligibility-pre-deploy-2026-07-24`
- Read/copy protected production component, Skills, config/state/model/WeChat/heartbeat/plist
- Modify production component and Skills only by fast-forward deployment

**Interfaces:**
- Consumes: verified isolated commits.
- Produces: restorable pre-deploy baseline and healthy V3.6.3 production.

- [ ] **Step 1: Create the protected rollback point**

Use mode `0700` for the directory and `0600` for files. Include:

```text
component.bundle
skills.bundle
three-skills.tar
config.json
state.json
model-state
wechat-state.json
heartbeat.json
com.llw.feishu-daily-work.plist
baseline-facts.txt
SHA256SUMS
```

`baseline-facts.txt` must record only commits, branch, config/state version, model, `wechatEnabled=true`, regression total, scope, and exclusions. It must not contain Keychain values, message text, invoice text, IDs, URLs, or logs.

- [ ] **Step 2: Perform a fresh `/private/tmp` restore rehearsal**

Restore bundles and snapshots into a fresh `mktemp -d`, verify:

```text
all SHA256SUMS pass
component and Skills commits match
config version = 4
state version = 4
model = codex
wechatEnabled = true
WeChat state structure is valid
plist passes plutil -lint
restored old regression passes
```

Delete only the fresh restore directory after verification.

- [ ] **Step 3: Push verified feature and Skills commits**

Run:

```bash
git push -u origin fix/v363-invoice-minimal-eligibility
git -C "/Volumes/ZHUTONG/LLW的私人助手/LLW/.agents/skills" push origin main
```

Expected: both remote refs equal local verified commits.

- [ ] **Step 4: Atomically deploy**

1. Stop `com.llw.feishu-daily-work`.
2. Fast-forward the production component branch to the verified feature commit.
3. Confirm production Skills HEAD equals the verified Skills commit.
4. Start the same existing LaunchAgent after macOS has released the stopped service.
5. Do not change formal config.

If startup fails, restore component, Skills, and exact config/state snapshots, then restart the original service.

- [ ] **Step 5: Verify production health**

Run:

```bash
node --input-type=module - \
"/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/src/config.mjs" \
"/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/src/state-store.mjs" \
"/Users/ccrt/Library/Application Support/LLW Assistant/state/feishu-daily-work/config.json" <<'NODE'
import {readFile} from "node:fs/promises";
import {pathToFileURL} from "node:url";
const [configModule,stateModule,configPath]=process.argv.slice(2);
const {loadConfig}=await import(pathToFileURL(configModule));
const {StateStore}=await import(pathToFileURL(stateModule));
const config=await loadConfig(configPath);
const state=await StateStore.open(config.stateFile);
const heartbeat=JSON.parse(await readFile(config.heartbeatFile,"utf8"));
const stamp=heartbeat.updatedAt??heartbeat.timestamp??heartbeat.at;
const ageSeconds=Math.round((Date.now()-Date.parse(stamp))/1000);
const model=(await readFile(config.modelStateFile,"utf8")).trim();
const result={
  configVersion:config.version,
  stateVersion:state.version(),
  wechatEnabled:config.wechatEnabled,
  model,
  unreplied:state.unreplied().length,
  heartbeatFresh:Number.isFinite(ageSeconds)&&ageSeconds>=0&&ageSeconds<=120
};
console.log(JSON.stringify(result));
if (JSON.stringify(result)!==JSON.stringify({
  configVersion:4,stateVersion:4,wechatEnabled:true,
  model:"codex",unreplied:0,heartbeatFresh:true
})) process.exitCode=1;
NODE
```

Also confirm one main Node process, the Feishu event child, no new LaunchAgent, and no new safe-log error category.

---

### Task 8: Real Acceptance, Documentation, and Branch Consolidation

**Files:**
- Modify: `/Volumes/ZHUTONG/LLW的私人助手/LLW/.llw-system/SYSTEM_MAP.md`
- Commit/push verified component and Skills refs

**Interfaces:**
- Consumes: healthy production V3.6.3.
- Produces: real archived original, exact reply, updated fact map, consolidated GitHub history.

- [ ] **Step 1: Ask the owner to resend the current invoice once**

Request one clear complete invoice through either formal WeChat or Feishu. Do not ask for both unless the first acceptance exposes a channel-specific infrastructure failure.

- [ ] **Step 2: Verify the real outcome without ordinary-content logging**

Read only structured state and filesystem facts. Confirm:

```text
capability = invoice
status = committed or existing
reply delivered = true
artifact count = 1
normalized month = expected month
normalized amount filename = expected two-decimal amount
transaction = published, or no new transaction for identical existing content
source and target SHA-256 equal when committed
unreplied = 0
invoice temp root empty
heartbeat fresh
wechatEnabled = true
Feishu listener healthy
```

Do not print message IDs, platform identifiers, token values, raw extracted JSON, or unrelated invoice fields.

- [ ] **Step 3: Update `SYSTEM_MAP.md`**

Record:

- V3.6.3 as current baseline;
- deployed component and Skills commits;
- exact regression total;
- protected rollback path and restore rehearsal result;
- formal WeChat enabled and healthy;
- real acceptance status;
- simplified eligibility and sequential naming facts;
- explicit non-changes: state v4, Codex, same LaunchAgent, same Vault root, no new dependency/service.

- [ ] **Step 4: Run final verification before completion**

Run:

```bash
npm test
git status --short
git log -1 --oneline
git -C "/Volumes/ZHUTONG/LLW的私人助手/LLW/.agents/skills" status --short
git -C "/Volumes/ZHUTONG/LLW的私人助手/LLW/.agents/skills" log -1 --oneline
launchctl print gui/501/com.llw.feishu-daily-work
```

Expected: zero test failures, clean versioned repositories, production service running, formal WeChat enabled.

- [ ] **Step 5: Consolidate only verified branches and push**

Merge the verified feature history into the long-lived branch using fast-forward or a normal non-destructive merge. Do not delete branches or worktrees until the merge and remote refs are confirmed. Push the long-lived branch and report:

```text
component branch and commit
Skills branch and commit
GitHub push result
test total
rollback point
production health
real acceptance result
```

Keep V3.6.2 and its rollback evidence unchanged.
