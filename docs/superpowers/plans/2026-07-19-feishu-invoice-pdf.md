# 飞书发票 PDF 自动处理实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 用户要求本次由当前会话统一执行，不派生子任务，不做中途编程汇报。

**Goal:** 在既有单消费者飞书助手中加入 PDF 发票的本地全页读取、Skill 语义核验、确定性归档和安全回执，同时保持图片发票与每日工作行为不变。

**Architecture:** 使用现有 invoice capability 扩展点增加 `pdf-preparer.mjs`，由固定本地 Poppler 提取有界文本并渲染全部页面；图片和 PDF 都规范化为统一 `AnalysisInput`，交给只读 Codex 依据 `$pdf` 与 `$filing-invoices` 输出严格 Schema。只有确定性验证器确认单张发票、购买方精确匹配、餐饮明确及所有字段完整后，现有 writer 才复制原始 PDF 并做 SHA-256 校验。

**Tech Stack:** Node.js 24 ESM、`node:test`、本机 lark-cli 1.0.68、Codex CLI、Poppler 26.05.0 (`pdfinfo`/`pdftotext`/`pdftoppm`)、macOS LaunchAgent、JSON Schema draft-07。

## Global Constraints

- 权威设计：`docs/superpowers/specs/2026-07-19-feishu-invoice-pdf-design.md`；其 PDF 规则覆盖原主设计中的“PDF 暂不支持”。
- 语义来源：PDF 读取方法只来自 `pdf` Skill；发票业务语义只来自 `.agents/skills/filing-invoices/SKILL.md` 及其输出 Schema。
- 单一事件消费者：不得新增 LaunchAgent、消息队列或第二个 `im.message.receive_v1` consumer。
- 只接收已绑定用户和 chat 的 P2P 图片/文件；群聊、其他用户和其他 chat 继续拒绝或忽略。
- 生产依赖不新增包、不访问云 OCR、不申请新凭证、不执行 `auth login`。
- PDF 输入上限固定 20 MiB，页数固定 1 至 10，文本固定最多 262,144 字节，渲染 PNG 总计固定最多 104,857,600 字节。
- PDF 准备超时固定 60,000 ms；AI 超时固定 120,000 ms。
- Poppler 工具路径固定为设计第 7.1 节的三个绝对路径，必须为当前用户可执行的普通文件且非符号链接。
- 全部页面必须渲染并验证；扫描件文本为空可以继续，缺页、加密、损坏、超限或渲染不完整必须停止。
- AI 只读且临时；不得获得归档写权限。确定性 writer 只归档下载的原始 PDF，不归档文本或 PNG。
- 只有 `document_verification=single_invoice` 加既有全部硬门槛通过才允许归档。
- 归档继续执行同名 SHA-256 判重、fallback 命名、防覆盖和复制后 SHA-256 校验。
- 临时目录权限 `0700`，配置/状态 `0600`；普通日志不得包含票面全文、附件内容、飞书 ID、密钥、完整哈希或临时路径。
- 不修改 `日常生活/`，不移动用户文件；U 盘只新增设计、计划、Skill Schema 和最终系统地图变更。
- 用户明确禁止 `git commit` 和 `git push`。本计划中每个“检查点”只记录测试证据，不进行 Git 操作。
- 所有生产修改先在新的本机隔离副本 `/private/tmp/llw-feishu-assistant-pdf-dev` 完成；部署前不得编辑运行中的组件。

---

## File Map

### Workspace files to modify

- `.agents/skills/filing-invoices/references/output-schema.json`：增加 `pdf` 和必填 `document_verification`。
- `.llw-system/SYSTEM_MAP.md`：只在真实验收结束后记录 PDF 实际状态、工具和维护命令。

### Isolated component files to create

- `/private/tmp/llw-feishu-assistant-pdf-dev/src/capabilities/invoice/pdf-preparer.mjs`：固定 Poppler 进程、页数/加密/输出/大小/路径验证。
- `/private/tmp/llw-feishu-assistant-pdf-dev/test/invoice-pdf-preparer.test.mjs`：假的 Poppler 单元测试与失败矩阵。
- `/private/tmp/llw-feishu-assistant-pdf-dev/test/invoice-pdf-poppler-integration.test.mjs`：真实 bundled Poppler 的本地集成测试。
- `/private/tmp/llw-feishu-assistant-pdf-dev/test/fixtures/fake-poppler.mjs`：根据固定参数形状和环境变量模拟三个 Poppler 子命令，永不访问网络。
- `/private/tmp/llw-feishu-assistant-pdf-dev/src/migrate-config-v4.mjs`：受保护配置的原子、无输出 v3→v4 迁移入口。
- `/private/tmp/llw-feishu-assistant-pdf-dev/test/migrate-config-v4.test.mjs`：配置迁移保留字段、权限与无敏感输出测试。

### Isolated component files to modify

- `src/config.mjs`：version 4 exact schema、PDF 数值和工具路径验证。
- `src/capabilities/invoice/decision-client.mjs`：统一 `AnalysisInput`、重复 `--image`、PDF 文本提示。
- `src/capabilities/invoice/decision-validator.mjs`：`pdf` 格式和文档完整性门槛。
- `src/capabilities/invoice/capability.mjs`：图片规范化、PDF prepare、共同 AI/validator/writer 流程。
- `src/capabilities/invoice/archive-writer.mjs`：归档输入允许 `pdf`。
- `src/capabilities/invoice/receipt.mjs`：PDF 失败和文档边界回执。
- `src/main.mjs`：注入 PDF preparer 和 version 4 配置。
- `test/config.test.mjs`、`test/invoice-decision-client.test.mjs`、`test/invoice-decision-validator.test.mjs`、`test/invoice-capability.test.mjs`、`test/invoice-archive-writer.test.mjs`、`test/privacy.test.mjs`：TDD 回归和新增矩阵。
- `test/fixtures/fake-codex.mjs`：仅在现有夹具不能记录重复 `--image` 时做最小调整。

### Deployment targets

- `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/`
- `/Users/ccrt/Library/Application Support/LLW Assistant/state/feishu-daily-work/config.json`
- `/Users/ccrt/Library/Application Support/LLW Assistant/backups/components/`
- LaunchAgent `com.llw.feishu-daily-work`

---

### Task 1: 建立隔离副本和不可变基线

**Files:**
- Source: `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/`
- Create: `/private/tmp/llw-feishu-assistant-pdf-dev/`

**Interfaces:**
- Consumes: 当前已部署且 91 项测试通过的 version 3 组件。
- Produces: 与部署组件内容一致、可写且不影响服务的开发副本；基线测试证据。

- [ ] **Step 1: 确认服务仍在运行且组件没有组件级 `AGENTS.md`**

Run:

```bash
launchctl print gui/501/com.llw.feishu-daily-work
find '/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work' -name AGENTS.md -print
```

Expected: LaunchAgent state 为 running；第二条无输出，因此工作区根 `AGENTS.md` 是适用规则。

- [ ] **Step 2: 创建全新隔离目录**

先只读检查目标不存在。若目标是本任务早先创建且可识别的隔离副本，移动到 `/private/tmp/llw-feishu-assistant-pdf-dev-stale-<timestamp>`，不得递归删除未知目录。然后运行：

```bash
mkdir -m 700 /private/tmp/llw-feishu-assistant-pdf-dev
rsync -a --exclude .git/ '/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/' /private/tmp/llw-feishu-assistant-pdf-dev/
```

Expected: `src/`、`test/`、`package.json` 存在，隔离副本无 `.git`，运行组件未改变。

- [ ] **Step 3: 运行旧测试作为基线**

Run:

```bash
/usr/local/bin/npm test
```

Working directory: `/private/tmp/llw-feishu-assistant-pdf-dev`

Expected: 91 tests passed, 0 failed。若数量与 91 不同，先记录实际测试清单并确认全部通过；任何失败都先用 `systematic-debugging` 找到基线原因，禁止进入实现。

- [ ] **Step 4: 验证固定工具，不安装依赖**

Run three `-v` commands and `stat -f '%HT %Sp %Su'` for the exact paths from Global Constraints.

Expected: 三个版本均为 26.05.0，均为当前用户可执行普通文件。若任一路径缺失，停止部署设计并寻找 bundled runtime 的同版本工具；不得 `brew install`。

- [ ] **Step 5: 检查点**

保存基线测试总数、工具版本和隔离目录路径到当前任务工作记录；不执行任何 Git 命令。

---

### Task 2: 先扩展 Skill 输出契约和确定性验证器

**Files:**
- Modify: `.agents/skills/filing-invoices/references/output-schema.json`
- Modify: `/private/tmp/llw-feishu-assistant-pdf-dev/src/capabilities/invoice/decision-validator.mjs`
- Modify: `/private/tmp/llw-feishu-assistant-pdf-dev/test/invoice-decision-validator.test.mjs`

**Interfaces:**
- Consumes: 现有 `validateInvoiceDecision(decision, {detectedFormat})`。
- Produces: 同签名验证器；合法输出新增 `decision.document_verification`，格式允许 `jpeg|png|webp|pdf`。

- [ ] **Step 1: 写失败测试**

在 `validDecision()` 顶层增加 `document_verification:"single_invoice"`，然后增加：

```js
test("pdf archive requires exactly one consistent invoice", () => {
  const pdf=validDecision();
  pdf.invoice.file_format="pdf";
  assert.equal(validateInvoiceDecision(pdf,{detectedFormat:"pdf"}).document_verification,"single_invoice");
  for (const state of ["multiple_invoices","conflicting_fields","unclear"]) {
    const unsafe=structuredClone(pdf);
    unsafe.document_verification=state;
    assert.throws(() => validateInvoiceDecision(unsafe,{detectedFormat:"pdf"}),/unsafe_document_verification/);
  }
});

test("document verification is required, exact and action-compatible", () => {
  const missing=validDecision(); delete missing.document_verification;
  assert.throws(() => validateInvoiceDecision(missing,{detectedFormat:"png"}),/missing_decision_field/);
  const extra=validDecision(); extra.document_verification="invented";
  assert.throws(() => validateInvoiceDecision(extra,{detectedFormat:"png"}),/invalid_document_verification/);
  for (const state of ["multiple_invoices","conflicting_fields","unclear"]) {
    const clarify=validDecision();
    clarify.action="needs_clarification"; clarify.confidence="low";
    clarify.document_verification=state; clarify.question="请重新发送一张发票一个文件的完整原件。";
    assert.equal(validateInvoiceDecision(clarify,{detectedFormat:"png"}).action,"needs_clarification");
  }
});
```

更新全部既有测试构造器，使旧图片决策明确为 `single_invoice`；这不是放宽，而是迁移到新 exact schema。

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
node --test test/invoice-decision-validator.test.mjs
```

Expected: FAIL，至少包含 `unknown_decision_field` 或 PDF format mismatch，证明生产验证器尚未实现新契约。

- [ ] **Step 3: 最小实现验证器**

将常量精确改为：

```js
const TOP_FIELDS=new Set(["action","confidence","reason","question","invoice","buyer_verification","category","document_verification"]);
const DOCUMENT_RESULTS=new Set(["single_invoice","multiple_invoices","conflicting_fields","unclear"]);
const FORMATS=new Set(["jpeg","png","webp","pdf"]);
```

在通用枚举验证处加入：

```js
if (!DOCUMENT_RESULTS.has(decision.document_verification)) throw new Error("invalid_document_verification");
```

在 `archive_dining` 分支第一组门槛加入：

```js
if (decision.document_verification !== "single_invoice") throw new Error("unsafe_document_verification");
```

非归档动作允许四种合法枚举，但仍受 question/action 既有规则约束。

- [ ] **Step 4: 修改 Skill Schema**

顶层 `required` 增加 `document_verification`；顶层 properties 增加：

```json
"document_verification": {
  "type": "string",
  "enum": ["single_invoice", "multiple_invoices", "conflicting_fields", "unclear"]
}
```

`invoice.file_format.enum` 改为 `["jpeg", "png", "webp", "pdf"]`。保持两个对象 `additionalProperties:false` 和全部既有 required 字段不变。

- [ ] **Step 5: 运行 GREEN 和 Skill JSON 自检**

Run:

```bash
node --test test/invoice-decision-validator.test.mjs
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));' '/Volumes/ZHUTONG/LLW的私人助手/LLW/.agents/skills/filing-invoices/references/output-schema.json'
```

Expected: validator tests PASS；Schema 解析退出码 0、无输出。

- [ ] **Step 6: 检查点**

扫描 Schema 与验证器枚举逐字一致；确认没有把餐饮关键词复制进 JS；不提交 Git。

---

### Task 3: 配置 version 4 和工具安全验证

**Files:**
- Modify: `/private/tmp/llw-feishu-assistant-pdf-dev/src/config.mjs`
- Modify: `/private/tmp/llw-feishu-assistant-pdf-dev/test/config.test.mjs`

**Interfaces:**
- Consumes: `loadConfig(file,{requireBinding})`、`saveConfig(file,config,{requireBinding})`。
- Produces: 相同公开签名；只接受 version 4 和精确 PDF 字段；导出 `validatePdfTools(invoiceConfig)` 供 `main.mjs` 启动前调用。

- [ ] **Step 1: 写 version 4 失败测试**

将测试 fixture 的 version 改为 4，并在 invoice 中加入设计规定的 7 个字段。增加：

```js
test("version 4 requires exact PDF limits and absolute tool paths", async () => {
  const config=validConfig();
  await assert.doesNotReject(() => saveConfig(file,config));
  for (const [field,value] of [
    ["maxPdfPages",11], ["maxPdfTextBytes",262143],
    ["maxPdfRenderBytes",104857599], ["pdfPrepareTimeoutMs",59999]
  ]) {
    const unsafe=validConfig(); unsafe.capabilities.invoice[field]=value;
    await assert.rejects(() => saveConfig(file,unsafe));
  }
  const relative=validConfig(); relative.capabilities.invoice.pdfInfoPath="pdfinfo";
  await assert.rejects(() => saveConfig(file,relative),/invalid_config_path/);
});
```

增加真实临时可执行文件、目录、符号链接、无执行位的 `validatePdfTools` 测试，要求只有 `mode & X_OK` 的普通非链接文件通过。

- [ ] **Step 2: 运行 RED**

Run: `node --test test/config.test.mjs`

Expected: FAIL `invalid_config_version` 或 `unknown_capability_field`，并且 `validatePdfTools` 尚未导出。

- [ ] **Step 3: 实现 exact schema**

把 `INVOICE_FIELDS` 增加七字段，把版本条件改为 4，加入精确常量检查：

```js
if (invoice.maxPdfPages !== 10) throw new Error("invalid_max_pdf_pages");
if (invoice.maxPdfTextBytes !== 262_144) throw new Error("invalid_max_pdf_text_bytes");
if (invoice.maxPdfRenderBytes !== 100 * 1024 * 1024) throw new Error("invalid_max_pdf_render_bytes");
if (invoice.pdfPrepareTimeoutMs !== 60_000) throw new Error("invalid_pdf_prepare_timeout");
```

三个工具字段调用现有 `absolute()`。

实现：

```js
export async function validatePdfTools(invoice) {
  for (const field of ["pdfInfoPath","pdfToTextPath","pdfToPpmPath"]) {
    const info=await lstat(invoice[field]);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`unsafe_pdf_tool:${field}`);
    await access(invoice[field],fsConstants.X_OK);
  }
}
```

从 `node:fs/promises` 导入 `access`，从 `node:fs` 导入 `constants as fsConstants`。错误不得包含配置内容。

- [ ] **Step 4: 运行 GREEN**

Run: `node --test test/config.test.mjs`

Expected: PASS。

- [ ] **Step 5: 检查点**

确认 config exact field 数量、工具路径和四个数值与设计逐字一致；不提交 Git。

---

### Task 4: 用假的 Poppler TDD 实现 PDF preparer

**Files:**
- Create: `/private/tmp/llw-feishu-assistant-pdf-dev/src/capabilities/invoice/pdf-preparer.mjs`
- Create: `/private/tmp/llw-feishu-assistant-pdf-dev/test/invoice-pdf-preparer.test.mjs`
- Create: `/private/tmp/llw-feishu-assistant-pdf-dev/test/fixtures/fake-poppler.mjs`

**Interfaces:**
- Produces:

```js
prepareInvoicePdf({
  file,
  pdfInfoPath,
  pdfToTextPath,
  pdfToPpmPath,
  maxPages:10,
  maxTextBytes:262144,
  maxRenderBytes:104857600,
  timeoutMs:60000,
  environment:process.env
}) -> Promise<{
  originalFile:string,
  detectedFormat:"pdf",
  archiveExtension:"pdf",
  pageImages:string[],
  extractedText:string,
  documentFacts:{pageCount:number,textAvailable:boolean}
}>
```

- Errors: `pdf_encrypted`, `pdf_page_limit`, `pdf_structure_invalid`, `pdf_text_invalid`, `pdf_render_invalid`, `pdf_prepare_timeout`；错误消息不含路径或 stderr。

- [ ] **Step 1: 创建 fake Poppler**

写一个可执行 Node ESM fixture：参数包含 `-layout` 时模拟 `pdftotext`，包含 `-png` 时模拟 `pdftoppm`，否则仅有输入 PDF 参数时模拟 `pdfinfo`；`FAKE_POPPLER_MODE` 控制结果。它只能在收到的目标路径创建 fixture 文件，PNG 使用精确 8 字节签名加少量数据；支持 `pages=N`、`encrypted`、`bad_info`、`text_oversize`、`missing_page`、`extra_page`、`bad_png`、`render_oversize`、`sleep`。它不打印输入文件内容。

- [ ] **Step 2: 写成功路径失败测试**

覆盖 1、2、10 页和空文本：

```js
test("prepares every PDF page in order and keeps original as archive source", async () => {
  const result=await prepareInvoicePdf(options({mode:"pages=2",text:"invoice text"}));
  assert.equal(result.originalFile,pdf);
  assert.equal(result.detectedFormat,"pdf");
  assert.equal(result.archiveExtension,"pdf");
  assert.deepEqual(result.pageImages.map(basename),["page-1.png","page-2.png"]);
  assert.equal(result.extractedText,"invoice text");
  assert.deepEqual(result.documentFacts,{pageCount:2,textAvailable:true});
});
```

断言 `analysis` 权限不向 group/other 开放。

- [ ] **Step 3: 运行 RED**

Run: `node --test test/invoice-pdf-preparer.test.mjs`

Expected: FAIL `ERR_MODULE_NOT_FOUND` for `pdf-preparer.mjs`。

- [ ] **Step 4: 实现受控子进程和基础成功路径**

实现私有 `runTool(command,args,{cwd,environment,timeoutMs,maxStdoutBytes})`：`spawn` 不设置 shell；stdout 超限立刻 SIGTERM 并以受控错误结束；stderr 只计数；timeout 先 SIGTERM；close/error 只 resolve/reject 一次。

实现 `pdfinfo` 唯一 `Pages:` 解析和 `Encrypted:` 检查，随后 `mkdir(join(dirname(file),"analysis"),{recursive:false,mode:0o700})`，再运行文本与渲染命令。返回契约必须完全匹配 Interfaces。

- [ ] **Step 5: 运行成功路径 GREEN**

Run: `node --test --test-name-pattern='prepares every|empty text|ten pages' test/invoice-pdf-preparer.test.mjs`

Expected: 选中的成功路径 PASS。

- [ ] **Step 6: 写结构和资源失败矩阵测试**

使用表驱动覆盖：加密→`pdf_encrypted`；0/11页→`pdf_page_limit`；重复/缺失 Pages、info stdout >64KiB、非零退出→`pdf_structure_invalid`；文本缺失/目录/链接/非 UTF-8/超限→`pdf_text_invalid`；渲染缺页/额外页/目录/链接/空/坏签名/总超限→`pdf_render_invalid`；三个阶段 sleep→`pdf_prepare_timeout`。

对每个失败断言错误字符串不含 PDF 路径、fixture 文本和 `secret`。

- [ ] **Step 7: 运行失败矩阵确认 RED**

Run: `node --test test/invoice-pdf-preparer.test.mjs`

Expected: 新增失败矩阵至少一项 FAIL；不能出现所有测试意外通过。

- [ ] **Step 8: 实现完整输出验证**

使用 `lstat` 拒绝链接和非普通文件；使用严格 UTF-8 `new TextDecoder("utf-8",{fatal:true})`；使用 `readdir(...,{withFileTypes:true})` 比较精确集合；逐页读 8 字节 PNG 签名；累计大小前检查 `Number.isSafeInteger`。用 `realpath` 证明 analysis 和每个输出都在 job 内。

对预处理分类错误设置稳定 `error.code`，例如：

```js
function pdfError(code) {
  return Object.assign(new Error(code),{code});
}
```

不得包含子进程原始错误消息。

- [ ] **Step 9: 运行完整 GREEN**

Run: `node --test test/invoice-pdf-preparer.test.mjs`

Expected: 全部 PASS，测试进程退出码 0，无遗留子进程。

- [ ] **Step 10: 检查点**

用 `rg 'shell:|exec\(|execFile|console\.|stderr'` 审计实现；允许 `spawn` 和 stderr 字节计数，不允许 shell、日志或动态命令；不提交 Git。

---

### Task 5: 统一图片/PDF AI 输入并保持只读

**Files:**
- Modify: `/private/tmp/llw-feishu-assistant-pdf-dev/src/capabilities/invoice/decision-client.mjs`
- Modify: `/private/tmp/llw-feishu-assistant-pdf-dev/test/invoice-decision-client.test.mjs`

**Interfaces:**
- Replaces: `invokeInvoiceDecision({...,file,format,...})`
- Produces:

```js
invokeInvoiceDecision({
  codexPath,workspaceRoot,skillRoot,
  analysisInput:{originalFile,detectedFormat,archiveExtension,pageImages,extractedText,documentFacts},
  environment,timeoutMs
}) -> Promise<object>
```

- [ ] **Step 1: 改写测试 fixture 并写重复图片 RED 测试**

构造 3 页 PDF `analysisInput`，断言参数中 `--image` 出现三次且后继值严格按 `page-1.png`、`page-2.png`、`page-3.png`。断言 prompt 包含 `$pdf`、`$filing-invoices`、`pdf`、`总页数：3`、`文本层：有`、不可信边界和测试文本；不含 sender/chat/message/file key 测试秘密。

图片 fixture 使用一张原图、空文本、pageCount 1，仍断言输出不变。

- [ ] **Step 2: 运行 RED**

Run: `node --test test/invoice-decision-client.test.mjs`

Expected: FAIL because old signature reads `file` and rejects `pdf`。

- [ ] **Step 3: 实现统一参数和提示**

先严格验证内部 `analysisInput`：格式枚举、非空绝对 pageImages、长度等于 pageCount、页数 1..10、布尔 textAvailable 与文本一致。构造参数：

```js
const imageArgs=analysisInput.pageImages.flatMap(image => ["--image",image]);
const args=[
  "exec","--ephemeral","--sandbox","read-only","--skip-git-repo-check","--color","never",
  "-c","model_reasoning_effort=\"medium\"",...imageArgs,
  "--output-schema",schema,"--output-last-message",output,"-"
];
```

PDF prompt 明确要求使用两个 Skill、检查全部页面与文档边界；图片 prompt 明确使用 `$filing-invoices` 并输出 `single_invoice`。两者都将文本置于 `--- BEGIN UNTRUSTED EXTRACTED TEXT ---` 和 `--- END ... ---` 内。决策临时目录 cleanup 保持 `finally`。

- [ ] **Step 4: 运行 GREEN 与隐私断言**

Run:

```bash
node --test test/invoice-decision-client.test.mjs
node --test test/privacy.test.mjs
```

Expected: PASS；fake Codex args 证明 sandbox 为 read-only，prompt 无飞书标识。

- [ ] **Step 5: 检查点**

确认 AI 参数没有原始 PDF 作为 `--image`，只传已验证页面 PNG；原始 PDF只保留在 `originalFile` 给 writer；不提交 Git。

---

### Task 6: 编排 PDF 和图片共同决策链

**Files:**
- Modify: `/private/tmp/llw-feishu-assistant-pdf-dev/src/capabilities/invoice/capability.mjs`
- Modify: `/private/tmp/llw-feishu-assistant-pdf-dev/src/capabilities/invoice/receipt.mjs`
- Modify: `/private/tmp/llw-feishu-assistant-pdf-dev/test/invoice-capability.test.mjs`

**Interfaces:**
- Consumes: `preparePdf(options)` from Task 4；`decide({analysisInput})` from Task 5。
- Produces: `createInvoiceCapability({download,inspect,preparePdf,decide,validate,writer,cleanup,parse})`。

- [ ] **Step 1: 更新决定 fixtures 并写 PDF RED 测试**

所有决策 fixtures 加 `document_verification:"single_invoice"`。harness 增加 `prepare` 计数和：

```js
preparePdf:async ({file}) => ({
  originalFile:file, detectedFormat:"pdf", archiveExtension:"pdf",
  pageImages:[`${file}.page-1.png`], extractedText:"text",
  documentFacts:{pageCount:1,textAvailable:true}
})
```

新增断言：PDF 调用 prepare、decide、writer 各一次；writer 收到 source 原 PDF、extension `pdf`；OFD/unsupported 三者都不调用。

- [ ] **Step 2: 写 PDF 失败和文档状态回执测试**

覆盖 prepare 抛 `pdf_encrypted`、`pdf_page_limit`、`pdf_structure_invalid`、`pdf_text_invalid`、`pdf_render_invalid`、`pdf_prepare_timeout`；断言对应回执安全且 AI/writer 为 0，cleanup 为 1。

覆盖 AI 的 `multiple_invoices`、`conflicting_fields`、`unclear`，断言 awaiting_clarification、writer 为 0、回执分别要求拆分/核对/清晰完整原件。

- [ ] **Step 3: 运行 RED**

Run: `node --test test/invoice-capability.test.mjs`

Expected: 旧 `kind:pdf` 测试或新 prepare 计数 FAIL。

- [ ] **Step 4: 实现统一 AnalysisInput**

在 inspect 后：

```js
let analysisInput;
if (inspected.kind === "supported_image") {
  analysisInput={
    originalFile:downloaded.file,
    detectedFormat:inspected.format,
    archiveExtension:inspected.extension,
    pageImages:[downloaded.file], extractedText:"",
    documentFacts:{pageCount:1,textAvailable:false}
  };
} else if (inspected.kind === "pdf") {
  stage="prepare_pdf";
  analysisInput=await preparePdf({file:downloaded.file});
} else {
  return formatUnsupported(inspected.kind);
}
stage="analyze";
const raw=await decide({analysisInput});
const decision=validate(raw,{detectedFormat:analysisInput.detectedFormat});
```

writer 使用 `analysisInput.originalFile` 和 `analysisInput.archiveExtension`。`finally` cleanup 保持唯一出口。

- [ ] **Step 5: 实现稳定错误映射**

`receipt.mjs` 新增 `failure("prepare_pdf",code)`，只按 allowlist code 返回第 11 节固定文案；未知 code 统一“PDF 页面无法完整呈现”。移除 PDF 暂不支持分支；OFD 固定文案保留。`formatNonArchive` 对三个 document state 优先使用固定安全文案，其他语义继续展示已经 Schema 约束的 reason/question。

- [ ] **Step 6: 运行 GREEN**

Run:

```bash
node --test test/invoice-capability.test.mjs
node --test test/invoice-decision-validator.test.mjs
```

Expected: PASS；PDF 进入 AI，OFD 不进入。

- [ ] **Step 7: 检查点**

断言每个 harness 的 cleanup 精确为一次；failure reply 不含抛入的 secret；不提交 Git。

---

### Task 7: 允许原始 PDF 进入现有防覆盖 writer

**Files:**
- Modify: `/private/tmp/llw-feishu-assistant-pdf-dev/src/capabilities/invoice/archive-writer.mjs`
- Modify: `/private/tmp/llw-feishu-assistant-pdf-dev/test/invoice-archive-writer.test.mjs`

**Interfaces:**
- Consumes: `writer.archive({transactionId,source,invoice,extension:"pdf"})`。
- Produces: 现有 committed/existing/awaiting_clarification 结果，不改变路径算法。

- [ ] **Step 1: 写 PDF RED 测试**

复用测试临时 Vault，写一个以 `%PDF-` 开头的 source。断言：首次生成 `290.00.pdf`；同内容再次为 existing；不同内容同金额生成 `290.00_INV123.pdf`；两者都不同则 awaiting_clarification；source/target 哈希一致。

- [ ] **Step 2: 运行 RED**

Run: `node --test test/invoice-archive-writer.test.mjs`

Expected: FAIL `invalid_archive_input` for extension pdf。

- [ ] **Step 3: 最小实现**

只把 `validateInput` 的扩展名 allowlist 改为：

```js
["jpg","jpeg","png","webp","pdf"].includes(extension)
```

不得按文件格式复制路径、命名或哈希算法。

- [ ] **Step 4: 运行 GREEN**

Run: `node --test test/invoice-archive-writer.test.mjs`

Expected: PASS，PDF 和既有图片矩阵均通过。

- [ ] **Step 5: 检查点**

用 `rg 'copyFile|COPYFILE_EXCL|sha256|fallback'` 确认防覆盖和校验逻辑未删改；不提交 Git。

---

### Task 8: 主进程组合、迁移工具和真实 Poppler 集成

**Files:**
- Modify: `/private/tmp/llw-feishu-assistant-pdf-dev/src/main.mjs`
- Create: `/private/tmp/llw-feishu-assistant-pdf-dev/src/migrate-config-v4.mjs`
- Create: `/private/tmp/llw-feishu-assistant-pdf-dev/test/migrate-config-v4.test.mjs`
- Create: `/private/tmp/llw-feishu-assistant-pdf-dev/test/invoice-pdf-poppler-integration.test.mjs`

**Interfaces:**
- Consumes: `validatePdfTools`, `prepareInvoicePdf`, version 3 protected config。
- Produces: version 4 runtime composition and silent one-shot migration.

- [ ] **Step 1: 写 main 组合静态检查和迁移 RED 测试**

迁移测试创建权限 `0600` 的 v3 fixture，运行 migrator 后断言：version 为 4；所有旧 JSON 值深度相等；只增加七字段；权限仍 `0600`；stdout/stderr 为空。v2、v4、未知字段、链接和宽权限输入必须拒绝且原文件字节不变。

- [ ] **Step 2: 运行 RED**

Run: `node --test test/migrate-config-v4.test.mjs`

Expected: FAIL `ERR_MODULE_NOT_FOUND`。

- [ ] **Step 3: 实现无输出原子迁移**

`migrate-config-v4.mjs` 接受 `process.argv[2]` 配置路径，并从 `LLW_PDFINFO_PATH`、`LLW_PDFTOTEXT_PATH`、`LLW_PDFTOPPM_PATH` 读取三个固定工具路径；先 `lstat` 现有配置、验证 owner/mode、解析 v3 exact 基础结构，再构造 v4，通过 `saveConfig` 写临时文件和 rename。成功退出 0 且不打印。异常只以稳定 code 退出，不打印配置、路径和 JSON。

为避免 v4 loader 无法读取 v3，migrator 内部定义只用于旧结构的 exact allowlist；不得让正常 `loadConfig` 接受 v3。

- [ ] **Step 4: 修改 main 组合**

导入 `validatePdfTools` 和 `prepareInvoicePdf`。在打开 state 和 listener 前：

```js
await validatePdfTools(invoiceConfig);
```

注入：

```js
preparePdf:({file}) => prepareInvoicePdf({
  file,
  pdfInfoPath:invoiceConfig.pdfInfoPath,
  pdfToTextPath:invoiceConfig.pdfToTextPath,
  pdfToPpmPath:invoiceConfig.pdfToPpmPath,
  maxPages:invoiceConfig.maxPdfPages,
  maxTextBytes:invoiceConfig.maxPdfTextBytes,
  maxRenderBytes:invoiceConfig.maxPdfRenderBytes,
  timeoutMs:invoiceConfig.pdfPrepareTimeoutMs
})
```

decision injection 改为接收 `analysisInput`。不得改变 listener、daily service、dispatcher 或 heartbeat 组合。

- [ ] **Step 5: 运行迁移 GREEN 和主模块语法检查**

Run:

```bash
node --test test/migrate-config-v4.test.mjs
node --check src/main.mjs
node --check src/migrate-config-v4.mjs
```

Expected: PASS，两个 syntax check 退出 0。

- [ ] **Step 6: 写真实 Poppler 集成测试**

测试使用 bundled Python/reportlab 在测试临时目录生成 1 页和 2 页数字文本 PDF，再调用生产 `prepareInvoicePdf` 的三个真实工具路径。断言文本含 fixture 的非敏感标记，PNG 数量等于页数且签名正确。另生成一张无文字的纯图形 PDF，断言 `textAvailable=false` 且页面仍渲染。

测试必须由 `test.skip` 条件明确检查固定工具存在；部署 Mac 上工具已存在，因此实际运行不得 skip。

- [ ] **Step 7: 运行真实集成 GREEN**

Run: `node --test test/invoice-pdf-poppler-integration.test.mjs`

Expected: 3 tests PASS, 0 skipped, 0 failed；临时目录在 finally 中清理。

- [ ] **Step 8: 检查点**

确认生产源码没有 import Python/reportlab；Python 只用于测试夹具生成；不提交 Git。

---

### Task 9: 全量回归、隐私和需求逐条审计

**Files:**
- Modify: `/private/tmp/llw-feishu-assistant-pdf-dev/test/privacy.test.mjs`
- Audit: all `/private/tmp/llw-feishu-assistant-pdf-dev/src/**/*.mjs`

**Interfaces:**
- Produces: 可部署的零失败证据和 spec traceability audit。

- [ ] **Step 1: 运行 invoice 分组测试**

Run:

```bash
node --test test/invoice-*.test.mjs test/lark-resource-downloader.test.mjs test/config.test.mjs test/privacy.test.mjs
```

Expected: 0 failed, 0 skipped；真实 Poppler 集成包含在结果中。

- [ ] **Step 2: 修复任何失败时遵守 RED-GREEN**

每个失败先单独复现，读取断言和生产路径，写或收紧能说明根因的最小测试，再改最小实现。禁止批量放宽断言、删除旧测试或把错误吞掉。每次修复后先跑单文件，再跑 Step 1。

- [ ] **Step 3: 运行全量套件**

Run: `/usr/local/bin/npm test`

Expected: 新总数大于 91，passed 等于 total，failed 0，skipped 0。

- [ ] **Step 4: 安全静态扫描**

Run targeted `rg` scans for:

```text
console.log|console.error|shell:true|child_process.exec|auth login
sender_id|chat_id|message_id|file_key
餐费|餐饮服务
http://|https://
```

Expected: 业务关键词只允许出现在测试 fixture、Skill 和回执类别文字；生产 PDF preparer/validator 不含餐饮关键词分类逻辑。网络 URL 不出现在新增生产代码。飞书字段只存在既有事件适配和测试，不进入 invoice AI prompt/log。

- [ ] **Step 5: 逐条审计设计完成标准**

建立 12 行内部检查表，对设计第 16 节每项标记实现文件、测试名或部署后证据。部署前允许第 10、11 项仍 pending；其他项必须 pass。

- [ ] **Step 6: 检查点**

记录测试总数、耗时、0 failed、0 skipped 和静态审计结论；不提交 Git。

---

### Task 10: 受保护备份、部署和 version 4 迁移

**Files:**
- Backup: `/Users/ccrt/Library/Application Support/LLW Assistant/backups/components/feishu-assistant-pdf-before-<timestamp>/`
- Replace: `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/`
- Migrate: `/Users/ccrt/Library/Application Support/LLW Assistant/state/feishu-daily-work/config.json`

**Interfaces:**
- Consumes: Task 9 verified isolated component。
- Produces: version 4 deployed component, rollback-ready local backup, running single consumer.

- [ ] **Step 1: 只读捕获部署前状态**

记录 LaunchAgent PID/状态、心跳时间、组件文件清单与 SHA-256、配置和状态 mode/owner，不打印配置内容。确认 temp root 无活跃 job 或只属于当前 listener。

- [ ] **Step 2: 创建受保护本机备份**

在时间戳目录中复制当前组件、config、state 和 plist；备份根权限 `0700`，config/state 文件 `0600`。生成仅含相对路径和 SHA-256 的 manifest；manifest 不包含文件内容或飞书标识。

- [ ] **Step 3: 停止唯一 LaunchAgent**

Run: `launchctl remove com.llw.feishu-daily-work`

Expected: label 不再存在，旧主进程及其 lark-cli event child 均退出。若仍有子进程，先确认 PID 属于该服务再正常 TERM，不使用宽泛 kill pattern。

- [ ] **Step 4: 部署已验证源码**

使用 `rsync -a --delete` 只在已解析的组件目标路径内同步隔离副本，但排除任何 `.git`、测试临时产物和本地 fixture 输出。同步后比较所有生产文件与隔离副本 SHA-256 一致。

- [ ] **Step 5: 原子迁移配置**

用部署组件的 `src/migrate-config-v4.mjs` 对受保护 config 执行一次，三个工具路径通过只为该命令设置的 `LLW_PDFINFO_PATH`、`LLW_PDFTOTEXT_PATH`、`LLW_PDFTOPPM_PATH` 传入。Expected: exit 0、stdout/stderr 为空、mode 仍 0600。随后用 `loadConfig` 和 `validatePdfTools` 只输出 `config_v4_ok`，不得输出 JSON。

- [ ] **Step 6: 部署目录全量复测**

Working directory: deployed component。

Run: `/usr/local/bin/npm test`

Expected: 与 Task 9 相同的 total/passed，0 failed，0 skipped。

- [ ] **Step 7: 启动服务**

使用现有 plist bootstrap/launchctl 方式恢复 `com.llw.feishu-daily-work`。不修改 label，不新增 plist。

- [ ] **Step 8: 健康检查**

在 60 秒内确认：LaunchAgent running；heartbeat 更新；主进程稳定；恰好一个 `lark-cli event consume im.message.receive_v1`；stderr 无崩溃循环；temp scavenger 结束；state 可读且权限 0600。

- [ ] **Step 9: 回滚条件**

若复测或启动健康失败：停止新服务，恢复备份组件/config/state/plist，恢复原权限，重新启动并确认旧健康。不得删除任何已通过哈希校验的归档发票。用 `systematic-debugging` 在隔离副本修复后重新执行 Task 9 和 Task 10。

- [ ] **Step 10: 检查点**

只有健康全部通过才进入真实验收；不提交 Git。

---

### Task 11: 一张真实 PDF 的有界端到端验收

**Files:**
- Runtime state/logs: protected Mac directories only
- Possible archive: `亚信工作/日常发票/餐饮发票/YYYY年MM月/<amount>.pdf`

**Interfaces:**
- Consumes: 用户在部署健康后重新发送的一个 PDF 新消息。
- Produces: 事件→下载→读取→AI/Skill→门槛→归档/拒绝→回执→清理的逐步证据。

- [ ] **Step 1: 请求唯一必要的用户动作**

仅在 Task 10 全部健康后，请用户“现在在飞书私聊机器人重新发送一张原始 PDF 发票，不附带文字也可以”。明确旧 message outcome 不会修改，新发送用于新的幂等键。

- [ ] **Step 2: 有界等待新 outcome**

在限定时间内观察脱敏状态变化和 heartbeat，不打印 event payload。只识别新 outcome 的 capability/status/stage counters；不得把 message ID、file key、sender/chat 抄入工作区或普通报告。

- [ ] **Step 3: 验证九段证据**

按设计第 15.3 节逐项确认：唯一消费者收到；下载成功；实际 PDF/大小；页数/未加密；文本状态；所有页面渲染数；Schema 和 document verification；购买方/税号/餐饮门槛；writer 结果；飞书 receipt；临时清理；服务回归。

- [ ] **Step 4: 验证归档时的文件系统证据**

若状态 committed/existing：由 outcome artifact 得到受限相对路径，解析后确认它仍位于 archive root；文件名严格 `<amount>.pdf` 或 `<amount>_<invoiceNo>.pdf`；目标为普通非链接文件；重新比较源下载证据记录的 SHA-256 与目标一致。因 job 已清理，服务必须在归档 transaction 中已保存复制校验结果；不得为复核保留临时源附件。

- [ ] **Step 5: 正确处理业务拒绝**

若真实票面不满足购买方、餐饮或单发票门槛，确认 writer 调用为 0，飞书回执明确原因，系统无新归档文件。此时技术 E2E 通过但“真实归档”未完成；只再请求一张确实满足规则的 PDF，不放宽规则。

- [ ] **Step 6: 无响应或重复阻塞规则**

若用户未发送，保持服务运行并停止主动改动。只有同一“缺少真实 PDF”条件在恢复后的三个连续 goal turns 重复，才把 goal 标记 blocked。若发送后故障，先执行 read-only 诊断和可逆修复，不立即要求用户反复发送。

- [ ] **Step 7: 检查点**

记录九段步骤的 pass/fail 和安全摘要；不记录票面全文、税号、任何飞书 ID 或完整哈希；不提交 Git。

---

### Task 12: 文档收口与完成前验证

**Files:**
- Modify: `.llw-system/SYSTEM_MAP.md`
- Verify: both design documents and both implementation plans

**Interfaces:**
- Consumes: 真实 E2E 和服务健康证据。
- Produces: 准确的维护入口和最终报告。

- [ ] **Step 1: 只在真实 E2E 后更新系统地图**

将“飞书私聊文字工作记录助手”改为“可扩展飞书私人助手”，记录：单消费者；daily-work + invoice；PDF 支持 1..10 页、20 MiB；本地 Poppler 26.05.0；Skill 边界；version 4；部署测试总数；LaunchAgent 和维护测试命令；OFD/群聊仍未启用；最小 bot scope 已验证。不得写完整工具输出、配置 JSON、绑定标识、消息标识或发票字段。

- [ ] **Step 2: 运行最终验证 Skill 流程**

重新读取 `superpowers:verification-before-completion`，然后在部署组件运行全量测试，检查 heartbeat、新旧能力、单消费者、配置/状态权限、temp root、归档 transaction 和真实 E2E outcome。所有成功声明必须引用这一次的新输出，不能复用早先结果。

- [ ] **Step 3: 文档一致性扫描**

Run `rg` across four docs for the placeholder words formed by `TB[D]`、`TO[DO]`、`待`+`定`, plus `PDF.*暂不支持|PDF.*非目标`。旧主设计中的历史句子只允许在顶部增量覆盖声明下保留；系统地图必须反映实际状态。确认 PDF 增量文档和本计划没有占位符。

- [ ] **Step 4: 最终报告**

用面向非编程用户的中文报告：

- 最终能力和不会处理的范围。
- 测试总数、0 failed、真实 Poppler 结果。
- 部署/配置/LaunchAgent/单消费者健康。
- 真实 PDF 九段 E2E 每步结果。
- 若归档：类别、日期、金额和可点击相对文件路径；若拒绝：明确门槛原因。
- 安全边界、备份路径和无 Git commit/push 声明。

不列出实现细节堆栈，不要求用户执行编程命令。

---

## Execution Stop Conditions

以下任一条件出现时停止部署或归档，但继续做安全只读诊断：

1. 既有 91 项基线测试失败。
2. bundled Poppler 任一工具不存在、不安全或真实集成测试 skip/fail。
3. 新全量测试任一失败或 skip。
4. 需要新增 bot scope；只报告精确 scope 和飞书后台入口，不扩大权限、不执行 bot auth login。
5. 配置/状态权限不是 0600，或备份校验失败。
6. LaunchAgent 无法稳定运行、heartbeat 超时或事件消费者不等于一个。
7. PDF 页面无法全部呈现、加密、损坏、超过 10 页或资源超限。
8. AI Schema 无效，或 `document_verification` 不是 `single_invoice`。
9. 购买方、税号、餐饮项目或任何必填字段缺失/模糊/不匹配。
10. 归档目标冲突、路径逃逸、符号链接、复制或 SHA-256 校验失败。
11. 完成真实 E2E 需要用户重新发送 PDF；这时只请求该动作，不要求用户参与编程。

## Traceability Matrix

| PDF 设计要求 | 实施任务 |
|---|---|
| Skill 唯一语义来源 | Tasks 2, 5, 9 |
| 20 MiB、1..10 页、文本/渲染上限 | Tasks 3, 4 |
| 本地 Poppler、无新依赖 | Tasks 1, 4, 8 |
| 全页渲染 + 可选文本层 | Tasks 4, 8 |
| 统一 AnalysisInput | Tasks 5, 6 |
| `document_verification` 严格 Schema | Tasks 2, 5, 6 |
| 购买方/税号/餐饮全部硬门槛 | Tasks 2, 6, 9 |
| 原始 PDF、防覆盖、SHA-256 | Task 7 |
| 安全回执和失败隔离 | Task 6 |
| version 4 原子迁移 | Tasks 3, 8, 10 |
| 图片与每日工作不回归 | Tasks 6, 9 |
| 单消费者和服务健康 | Task 10 |
| 真实 PDF 九段验收 | Task 11 |
| 系统地图和最终新鲜证据 | Task 12 |
| 无 Git commit/push | Global Constraints and every checkpoint |
