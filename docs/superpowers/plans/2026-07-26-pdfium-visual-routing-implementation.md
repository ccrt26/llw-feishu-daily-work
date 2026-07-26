# PDFium PDF 内容路由实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用一个受保护的 PDFium 5.11.0 子进程替换生产 Poppler，并让飞书/微信 PDF 在安全下载、检查和全页渲染后由统一 `router.visual` 按实际内容路由，再复用同一准备结果进入现有发票规则与归档链路。

**Architecture:** 入口先完成身份、安全和幂等，再由一个通用 `PreparedVisual` runner 对图片或 PDF 只下载、检查和准备一次。PDFium 子进程一次完成 PDF 结构、加密、页数、文本和全页 PNG；Node.js 复核严格清单。`router.visual` 只选择唯一 Capability，路由为 `invoice/high` 后现有 `invoice.visual`、确定性规则和 writer 复用同一 `AnalysisInput`，最后统一清理临时目录。

**Tech Stack:** Node.js 24 ESM、`node:test`、Python 3 系统启动器、pypdfium2/PDFium 5.11.0、Codex CLI、macOS LaunchAgent、Git。

## Global Constraints

- 生产只保留一个 PDF 引擎 PDFium；不得保留 Poppler 正常路径、回退路径或第二次尝试。
- pypdfium2 版本固定为 `5.11.0`；PDFium 原生库必须通过受保护 manifest 的 SHA-256 校验。
- PDF 最多 10 页；文本最多 262,144 字节；PNG 合计最多 100 MiB；页面最大边固定为 3,508 像素；子进程总时限 60 秒。
- PDF 必须在安全下载、普通文件/符号链接/大小/文件头检查和 PDFium 成功后才进入 `router.visual`。
- `router.visual` 查看 1 至 10 张按页码排列的准备页面，只输出路由结果，不提取票面字段。
- 路由为 `invoice/high` 时，同一准备结果进入 `invoice.visual`；下载和 PDFium 均不得重复。
- `filing-invoices` 七字段合同、Codex `medium`、DeepSeek 发票禁止、Node.js 购买方/税号/餐饮规则、日期/金额存储规则和 writer 不变。
- 成功归档对象始终是用户发送的原始 PDF；文本、PNG、manifest 和重新生成文件绝不归档。
- 飞书与微信共用一个 Dispatcher、Router、invoice Capability 和 writer；不按入口分叉。
- 不新增 OCR、第二模型、第二 PDF 引擎、自动修复、OFD 支持、新发票分类、动态 Skill 或 Provider。
- 真实发票不得进入 Git、测试夹具、普通日志或维护文档；测试只用完全虚构数据。
- 所有新增行为严格执行 RED → GREEN；部署前完整回归、测试 Vault、回滚点和 `/private/tmp` 恢复演练必须通过。

---

### Task 1: 固定 PDFium 子进程与 Node.js 输出复核

**Files:**
- Create: `src/capabilities/invoice/pdfium-processor.py`
- Create: `test/fixtures/fake-pdfium-processor.mjs`
- Modify: `src/capabilities/invoice/pdf-preparer.mjs`
- Modify: `test/invoice-pdf-preparer.test.mjs`
- Delete: `test/fixtures/fake-poppler.mjs`

**Interfaces:**
- Consumes: `prepareInvoicePdf({file,pdfProcessorPath,maxPages,maxTextBytes,maxRenderBytes,timeoutMs,environment})`
- Produces: `AnalysisInput = {originalFile,detectedFormat:"pdf",archiveExtension:"pdf",pageImages:string[],extractedText:string,documentFacts:{pageCount:number,textAvailable:boolean}}`
- Processor argv: `--input <absolute PDF> --output <new empty analysis dir> --max-pages 10 --max-text-bytes 262144 --max-render-bytes 104857600 --max-dimension 3508`
- Processor success files: `manifest.json`, `extracted.txt`, `page-1.png` … `page-N.png`
- Processor exit mapping: `20→pdf_encrypted`, `21→pdf_structure_invalid`, `22→pdf_page_limit`, `23→pdf_text_invalid`, `24→pdf_render_invalid`

- [ ] **Step 1: Replace Poppler unit fixtures with failing single-process contract tests**

  In `test/invoice-pdf-preparer.test.mjs`, make the fake processor record one invocation and generate a strict version-1 manifest. Assert ordered pages, original PDF source, empty text support, 10-page acceptance, 11-page rejection, encrypted/structure/text/render mappings, malformed/unknown/extra manifest fields, missing/duplicate/extra pages, bad UTF-8, bad PNG, size limits, symlink/directory outputs, pre-existing `analysis`, non-zero exit and one 60-second-equivalent timeout.

- [ ] **Step 2: Run the focused test and verify RED**

  Run:

  ```bash
  node --test test/invoice-pdf-preparer.test.mjs
  ```

  Expected: FAIL because `prepareInvoicePdf` still requires three Poppler paths and does not consume one manifest-producing processor.

- [ ] **Step 3: Implement the minimal processor and Node.js verifier**

  `pdfium-processor.py` must set `sys.dont_write_bytecode = True` before importing pypdfium2, catch all processing exceptions without traceback, keep stdout/stderr empty, initialize forms, check 1..N pages before rendering, extract every text page, enforce UTF-8 and byte limits, render white-background PNG pages with forms/annotations, release each page/bitmap before the next, and atomically write this exact manifest:

  ```json
  {"version":1,"pageCount":1,"textFile":"extracted.txt","pageFiles":["page-1.png"]}
  ```

  `pdf-preparer.mjs` must create one new `analysis` directory, spawn only `pdfProcessorPath`, enforce one overall timer, map only the fixed exit codes, and independently validate ownership, mode, regular-file/no-link status, exact directory contents, exact manifest Schema, UTF-8, ordered PNG names/signatures and byte limits.

- [ ] **Step 4: Run focused tests and verify GREEN**

  Run:

  ```bash
  node --test test/invoice-pdf-preparer.test.mjs
  ```

  Expected: all focused tests pass with one processor invocation per successful or processor-rejected PDF.

- [ ] **Step 5: Commit**

  ```bash
  git add src/capabilities/invoice/pdfium-processor.py src/capabilities/invoice/pdf-preparer.mjs test/fixtures/fake-pdfium-processor.mjs test/invoice-pdf-preparer.test.mjs test/fixtures/fake-poppler.mjs
  git commit -m "feat: replace Poppler with one PDFium processor"
  ```

### Task 2: 受保护 PDFium 运行件、manifest 与真实集成

**Files:**
- Create: `src/capabilities/invoice/pdfium-runtime.mjs`
- Create: `scripts/install-pdfium-runtime.mjs`
- Create: `test/pdfium-runtime.test.mjs`
- Create: `test/invoice-pdfium-integration.test.mjs`
- Delete: `test/invoice-pdf-poppler-integration.test.mjs`

**Interfaces:**
- Produces: `installPdfiumRuntime({sourceRoot,processorSource,destinationRoot})`
- Produces: `validatePdfiumRuntime(pdfProcessorPath)`
- Runtime root contains only processor source, pypdfium2 runtime packages, licenses and `runtime-manifest.json`; files are `0600`, directories `0700`, processor is `0700`.
- Manifest contains version `1`, pypdfium2 version `5.11.0`, PDFium build identity, and SHA-256 for every runtime file except the manifest itself.

- [ ] **Step 1: Write failing runtime integrity tests**

  Cover exact version, owner/mode, symlink rejection, missing/extra file rejection, changed processor/native library/module hash rejection, malformed manifest, and an installer that never uses the network or package manager.

- [ ] **Step 2: Run runtime tests and verify RED**

  Run:

  ```bash
  node --test test/pdfium-runtime.test.mjs
  ```

  Expected: FAIL because installer and runtime validator do not exist.

- [ ] **Step 3: Implement atomic offline installation and validation**

  Copy only the pre-validated pypdfium2 runtime tree from an explicit local source into a new sibling staging directory, remove all `__pycache__`/`.pyc`, copy the processor source, generate the exact manifest, fsync files, set modes, rename atomically, then verify the installed tree. Never download, invoke pip, or overwrite a live destination in place.

- [ ] **Step 4: Write failing real PDFium integration tests**

  Use generated non-sensitive PDFs to cover digital text, scan-only, rotated page, AcroForm, 1/2/10/11 pages, encrypted, empty/fake/truncated input, text limit and ordered PNG output. Include a fully virtual Chinese dining invoice using an unembedded `STSong-Light` CID font and assert its rendered page retains the expected visual regions.

- [ ] **Step 5: Run integration tests and verify RED or missing-runtime precondition**

  Run with the isolated verified vendor tree:

  ```bash
  LLW_PDFIUM_VENDOR=/private/tmp/llw-pdf-debug.Ryokuf/pdfium-vendor node --test test/invoice-pdfium-integration.test.mjs
  ```

  Expected before implementation: FAIL because the processor contract is not yet connected to the real runtime.

- [ ] **Step 6: Complete the real processor path and verify GREEN**

  Run:

  ```bash
  node --test test/pdfium-runtime.test.mjs
  LLW_PDFIUM_VENDOR=/private/tmp/llw-pdf-debug.Ryokuf/pdfium-vendor node --test test/invoice-pdfium-integration.test.mjs
  ```

  Expected: all runtime and integration cases pass; no Poppler executable is invoked.

- [ ] **Step 7: Commit**

  ```bash
  git add src/capabilities/invoice/pdfium-runtime.mjs scripts/install-pdfium-runtime.mjs test/pdfium-runtime.test.mjs test/invoice-pdfium-integration.test.mjs test/invoice-pdf-poppler-integration.test.mjs
  git commit -m "feat: add protected PDFium runtime"
  ```

### Task 3: 配置 version 4 原子迁移到单一路径

**Files:**
- Modify: `src/config.mjs`
- Create: `src/migrate-config-pdfium.mjs`
- Modify: `test/config.test.mjs`
- Create: `test/migrate-config-pdfium.test.mjs`

**Interfaces:**
- Old invoice fields: `pdfInfoPath`, `pdfToTextPath`, `pdfToPpmPath`
- New invoice field: `pdfProcessorPath`
- Config version remains exactly `4`; all unrelated fields and protected values remain unchanged.

- [ ] **Step 1: Write failing config and migration tests**

  Assert new config accepts only one absolute `pdfProcessorPath`; all three Poppler fields and mixed old/new forms are rejected. The migration must accept one exact old version-4 shape, preserve every unrelated scalar/object byte-for-value, add only `pdfProcessorPath`, remove only the three Poppler fields, write mode `0600` atomically, reject symlinks/broad modes/already-migrated/unknown shapes, and print no protected values.

- [ ] **Step 2: Run focused tests and verify RED**

  Run:

  ```bash
  node --test test/config.test.mjs test/migrate-config-pdfium.test.mjs
  ```

  Expected: FAIL because current config requires all three Poppler fields.

- [ ] **Step 3: Implement minimal config and migration changes**

  Replace the three fields in `INVOICE_FIELDS`, protected path comparisons and startup validation with `pdfProcessorPath`. Keep every numerical limit and config/state version unchanged. Implement a separate one-shot migration command; do not broaden the existing v3→v4 migrator.

- [ ] **Step 4: Run focused tests and verify GREEN**

  Run:

  ```bash
  node --test test/config.test.mjs test/migrate-config-pdfium.test.mjs
  ```

  Expected: all config/migration cases pass.

- [ ] **Step 5: Commit**

  ```bash
  git add src/config.mjs src/migrate-config-pdfium.mjs test/config.test.mjs test/migrate-config-pdfium.test.mjs
  git commit -m "feat: migrate config to one PDF processor"
  ```

### Task 4: 通用 PreparedVisual 与 PDF 先准备后路由

**Files:**
- Create: `src/core/prepared-visual.mjs`
- Create: `test/prepared-visual.test.mjs`
- Modify: `src/core/dispatcher.mjs`
- Modify: `src/capabilities/invoice/capability.mjs`
- Modify: `test/dispatcher.test.mjs`
- Modify: `test/invoice-capability.test.mjs`
- Delete: `src/core/prepared-image.mjs`
- Delete: `test/prepared-image.test.mjs`

**Interfaces:**
- Produces: `createPreparedVisualRunner({parse,download,inspect,preparePdf,cleanup})`
- Prepared result:

  ```js
  {
    tempDir,
    resourceType: "image" | "file",
    analysisInput: {
      originalFile,
      detectedFormat,
      archiveExtension,
      pageImages,
      extractedText,
      documentFacts
    }
  }
  ```

- Dispatcher injects it as `withPreparedVisual(message, operation)`.
- invoice Capability accepts `{preparedVisual}` and reuses `preparedVisual.analysisInput`.

- [ ] **Step 1: Write failing common-runner tests**

  Assert image and PDF each call parse/download/inspect once; PDF additionally calls preparePdf once; operation sees the exact result; cleanup runs once after route/business success, clarify, unsupported and every failure; OFD/unsupported never enters visual routing.

- [ ] **Step 2: Write failing Dispatcher and Capability tests**

  Replace the old assertion “PDF keeps text router” with:

  - PDF download/inspect/PDFium finish before `router.visual`;
  - all PDF pages reach the router in order;
  - `clarify/unsupported` calls no Capability/writer;
  - `invoice/high` calls the invoice Capability once with the same object;
  - Capability performs zero download/inspect/PDFium/cleanup when given that object;
  - Feishu and WeChat produce the same call order;
  - technical preparation failures use existing safe PDF error semantics;
  - DeepSeek visual prohibition remains explicit and performs zero download.

- [ ] **Step 3: Run focused tests and verify RED**

  Run:

  ```bash
  node --test test/prepared-visual.test.mjs test/dispatcher.test.mjs test/invoice-capability.test.mjs
  ```

  Expected: FAIL because PDF still uses `router.text` and image-only preparation.

- [ ] **Step 4: Implement the minimal common path**

  Detect only one `image` or one extension-`pdf` attachment as visual input. Keep security, model command and idempotency order unchanged. The runner owns temporary cleanup around both router and selected Capability. `invoice` validates the prepared resource type and exact `AnalysisInput` shape before use.

- [ ] **Step 5: Run focused tests and verify GREEN**

  Run the same command; expected all focused tests pass.

- [ ] **Step 6: Commit**

  ```bash
  git add src/core/prepared-visual.mjs src/core/prepared-image.mjs src/core/dispatcher.mjs src/capabilities/invoice/capability.mjs test/prepared-visual.test.mjs test/prepared-image.test.mjs test/dispatcher.test.mjs test/invoice-capability.test.mjs
  git commit -m "feat: prepare PDFs before unified visual routing"
  ```

### Task 5: `router.visual` 多页 PDF 合同与 Skill

**Files:**
- Modify: `src/core/intent-router-client.mjs`
- Modify: `src/core/semantic-tasks.mjs`
- Modify: `test/intent-router-client.test.mjs`
- Modify: `test/semantic-tasks.test.mjs`
- Modify: `test/intent-routing-skill-contract.test.mjs`
- Modify in Skills repository: `.agents/skills/feishu-intent-router/SKILL.md`
- Modify in Skills repository: `.agents/skills/feishu-intent-router/evals/visual-cases.jsonl`

**Interfaces:**
- `invokeIntentRouter({...,imageFiles})` accepts 1..10 unique absolute verified image paths for visual mode.
- `createRouterVisualTask` passes `preparedVisual.analysisInput.pageImages` and message type `image` or `file`.
- All page images become ordered `--image <path>` pairs in one Codex call.

- [ ] **Step 1: Write failing multi-page client and semantic-task tests**

  Assert 1-page image compatibility, 2/10-page PDF order, empty/11/duplicate/relative path rejection, message type/capability `accepts` consistency, no platform metadata/text/path in stdin, and the fixed no-extraction/no-write prompt.

- [ ] **Step 2: Write failing Skill contract tests and eval cases**

  Extend `router.visual` contract from one checked image to 1..10 checked image/PDF pages. Add at least one synthetic PDF-page positive route and one unrelated-document negative case using existing non-sensitive fixtures; keep the same strict output Schema and Codex `low`.

- [ ] **Step 3: Run focused tests and verify RED**

  Run:

  ```bash
  node --test test/intent-router-client.test.mjs test/semantic-tasks.test.mjs test/intent-routing-skill-contract.test.mjs
  ```

  Expected: FAIL because the client accepts only one image and the Skill forbids PDF page sets.

- [ ] **Step 4: Implement the minimal multi-page visual boundary**

  Do not pass extracted PDF text into the router. Update prompt wording to “全部已验证页面的实际像素”; retain prompt-injection, Vault, output and privacy prohibitions.

- [ ] **Step 5: Run focused tests and verify GREEN**

  Run the same command; expected all focused tests pass.

- [ ] **Step 6: Commit component and Skill repositories separately**

  Component:

  ```bash
  git add src/core/intent-router-client.mjs src/core/semantic-tasks.mjs test/intent-router-client.test.mjs test/semantic-tasks.test.mjs test/intent-routing-skill-contract.test.mjs
  git commit -m "feat: route prepared PDF pages visually"
  ```

  Skills:

  ```bash
  git add .agents/skills/feishu-intent-router/SKILL.md .agents/skills/feishu-intent-router/evals/visual-cases.jsonl
  git commit -m "feat: extend visual router to PDF pages"
  ```

### Task 6: 生产组合、单一路径和回归

**Files:**
- Modify: `src/main.mjs`
- Modify: `test/main-composition.test.mjs`
- Modify: `test/privacy.test.mjs`
- Modify: `test/ai-input-guard.test.mjs` only if the exact prepared visual shape requires a guard assertion

**Interfaces:**
- Startup calls `validatePdfiumRuntime(invoiceConfig.pdfProcessorPath)` before state/listeners.
- `createPreparedVisualRunner` receives the same downloader/inspector/PDF preparer used by invoice.
- Dispatcher receives `withPreparedVisual`; invoice Capability receives already-prepared results only after visual route.

- [ ] **Step 1: Write failing composition and privacy tests**

  Assert no Poppler import/config/tool validation remains; one PDFium validator and processor path are injected; one common runner is injected into one Dispatcher; no PDF text, page path, resource key, platform ID or real field enters router JSON/log/state.

- [ ] **Step 2: Run focused tests and verify RED**

  Run:

  ```bash
  node --test test/main-composition.test.mjs test/privacy.test.mjs test/ai-input-guard.test.mjs
  ```

  Expected: FAIL because `main.mjs` still composes Poppler and image-only preparation.

- [ ] **Step 3: Implement composition changes**

  Preserve one LaunchAgent, one Node process, one lark consumer, the existing WeChat listener, model state, reply ordering and heartbeat.

- [ ] **Step 4: Run all focused feature suites**

  Run:

  ```bash
  node --test \
    test/config.test.mjs \
    test/migrate-config-pdfium.test.mjs \
    test/pdfium-runtime.test.mjs \
    test/invoice-pdf-preparer.test.mjs \
    test/invoice-pdfium-integration.test.mjs \
    test/prepared-visual.test.mjs \
    test/dispatcher.test.mjs \
    test/invoice-capability.test.mjs \
    test/intent-router-client.test.mjs \
    test/semantic-tasks.test.mjs \
    test/intent-routing-skill-contract.test.mjs \
    test/main-composition.test.mjs \
    test/privacy.test.mjs
  ```

  Expected: all feature suites pass.

- [ ] **Step 5: Run full regression**

  Run outside the restricted loopback sandbox:

  ```bash
  npm test
  ```

  Expected: all tests pass, zero failure/cancel/skip.

- [ ] **Step 6: Commit**

  ```bash
  git add src/main.mjs test/main-composition.test.mjs test/privacy.test.mjs test/ai-input-guard.test.mjs
  git commit -m "feat: compose one PDFium visual pipeline"
  ```

### Task 7: 回滚点、隔离恢复与原子生产部署

**Files:**
- Create protected backup under: `~/Library/Application Support/LLW Assistant/backups/baselines/v363-pdfium-pre-deploy-2026-07-26/`
- Install runtime under: `~/Library/Application Support/LLW Assistant/runtimes/pdfium-5.11.0/`
- Modify atomically: `~/Library/Application Support/LLW Assistant/state/feishu-daily-work/config.json`
- Deploy component atomically to: `~/Library/Application Support/LLW Assistant/components/feishu-daily-work/`

**Interfaces:**
- Backup contains current component archive+bundle, Skills archive+bundle, config/state/model/heartbeat/plist snapshots, old Poppler dependency facts, manifest and restoration evidence.
- Backup excludes Vault data, ordinary logs, Keychain values, tokens, QR data and message/attachment content.

- [ ] **Step 1: Establish a protected pre-deploy rollback point**

  Stop no service yet. Resolve current production branch/commit/config/WeChat/model/heartbeat/LaunchAgent facts read-only, copy the allowed artifacts with `0700/0600`, create SHA-256 manifest, and verify every entry.

- [ ] **Step 2: Perform a clean `/private/tmp` recovery rehearsal**

  Restore the component, Skills and configuration into a new `mktemp -d` directory; verify manifest, Git commits, exact config version 4, old Poppler startup facts and full baseline tests. Delete only this explicit rehearsal directory after evidence is saved.

- [ ] **Step 3: Install and validate the protected PDFium runtime**

  Use the offline installer with `/private/tmp/llw-pdf-debug.Ryokuf/pdfium-vendor`, copy the committed processor, validate full manifest, pypdfium2 `5.11.0`, PDFium native hash and permissions. Do not modify the existing Poppler runtime; it remains only inside the rollback fact set until deployment succeeds.

- [ ] **Step 4: Prepare component and config deployment**

  Verify the feature branch is clean and full regression is fresh. Stop the single LaunchAgent, deploy one coherent component tree, run the one-shot config migration to `pdfProcessorPath`, then verify source/config/runtime identities before restarting.

- [ ] **Step 5: Restart once and perform health checks**

  Confirm one Node main process, one direct lark consumer, advancing heartbeat, zero startup error, config/state version 4, current model unchanged, formal WeChat enabled state unchanged, no pending reply and no second listener.

- [ ] **Step 6: Run test-Vault acceptance**

  Use only synthetic PDFs to prove: eligible dining archive, buyer mismatch rejection, unrelated PDF unsupported before business Skill, two-page order, 11-page rejection, encrypted/structure failure, same-content idempotency, same-month amount suffix, Feishu/WeChat call-order equivalence, source/target SHA-256 equality and complete temp cleanup.

- [ ] **Step 7: Roll back atomically on any failed gate**

  If startup, health or test-Vault acceptance fails, stop the service and restore component, config and old Poppler dependency facts from the new rollback point as one unit; restart and verify the old baseline. Do not mix old config with new component.

### Task 8: 真实验收、当前状态文档和 GitHub 收口

**Files:**
- Modify after successful production evidence: `/Volumes/ZHUTONG/LLW的私人助手/LLW/.llw-system/SYSTEM_MAP.md`
- Modify if version ledger exists: the current V3.6.3 status document only

- [ ] **Step 1: Execute one bounded real-channel acceptance**

  Reuse only a newly sent user PDF event. Confirm sanitized counters: one download, one PDFium preparation, one `router.visual`, route `invoice/high`, one `invoice.visual`, deterministic result, at most one writer, one reply, no pending outcome and temp cleanup. Never record ticket values or attachment bytes.

- [ ] **Step 2: Verify successful archive when the invoice is eligible**

  If the real PDF is eligible, confirm original PDF target, correct month/amount name, source/target SHA-256 equality, transaction `published` and repeat `existing`. If it is legitimately ineligible, report the correct deterministic reason and retain the synthetic eligible acceptance as writer proof.

- [ ] **Step 3: Update current-state documentation**

  Record exact production component/Skills commits, runtime version/hash, config shape, full test counts, test-Vault results, rollback path, recovery result, health facts and real acceptance outcome. Remove outdated claims that production uses Poppler, routes PDF from metadata, or keeps formal WeChat disabled if current read-only facts show otherwise.

- [ ] **Step 4: Fresh final verification**

  Run:

  ```bash
  git diff --check
  npm test
  ```

  Also run the protected runtime validator, config loader, LaunchAgent health query, heartbeat advance check, sanitized pending-outcome check, Skills contract tests and one `/private/tmp` manifest restoration verification.

- [ ] **Step 5: Commit and push both repositories**

  Push the component feature branch and Skills branch only after all tests are green. Merge/integrate according to the existing production/main ancestry without force-push, then rerun full tests on the integrated commit and push the updated production/main branches required by the repository’s current branch policy.

- [ ] **Step 6: Report**

  Report exact commits/branches/push results, test counts, runtime and config facts, rollback/recovery evidence, production health and remaining manual real-message step only if the platform requires the owner to send a new PDF.
