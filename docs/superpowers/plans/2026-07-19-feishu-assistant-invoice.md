# LLW 可扩展飞书助手与发票归档实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task in the current session. Every production change follows `superpowers:test-driven-development`; every phase and final claim follows `superpowers:verification-before-completion`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变现有飞书每日工作行为的前提下，将单一事件服务重构为可扩展能力路由，并新增绑定用户 P2P 发票图片的安全下载、AI/Skill 识别、严格核验、幂等归档和飞书回执。

**Architecture:** 保留一个 `im.message.receive_v1` 消费者；事件经标准化、安全门禁、共享 outcome/outbox 和静态能力路由后，交给 `daily-work` 或 `invoice`。AI 只在只读沙箱内返回严格 Schema；确定性 adapter 和 writer 负责下载、路径、哈希、防覆盖、写入和回执。

**Tech Stack:** Node.js 24 ESM、`node:test`、`lark-cli` 1.0.68、Codex CLI、原子 JSON 状态、macOS LaunchAgent、SHA-256、Vault 文件系统。

## Global Constraints

- 设计规格唯一依据：`/Volumes/ZHUTONG/LLW的私人助手/LLW/docs/superpowers/specs/2026-07-19-feishu-assistant-architecture-invoice-design.md`。
- 业务语义唯一依据：`/Volumes/ZHUTONG/LLW的私人助手/LLW/.agents/skills/filing-invoices/SKILL.md`。
- 当前程序仓库：`/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/`。
- 程序、依赖、运行状态、临时文件和日志只留在 Mac；U 盘只保存用户文档、Skills 和维护文档。
- 不在工作区、Git 或日志保存密钥、token、真实飞书 ID、资源 key、消息正文、票面全文或附件内容。
- 不新增 npm 依赖；只使用 Node.js 24 标准库和现有 `lark-cli`、Codex。
- 只有已绑定 sender、已绑定 chat、`chat_type === "p2p"` 的事件可以下载附件或调用 AI。
- 首版自动识别格式仅为 JPEG、PNG、WebP，最大 20 MiB；PDF/OFD 只返回固定暂不支持回执。
- 购买方名称必须精确为 `亚信科技（成都）有限公司`，税号必须精确为 `91510100732356360H`。
- 只有 AI high confidence、购买方精确匹配、项目明确为餐饮且所有必填字段有效时才允许归档。
- 归档目录为 `亚信工作/日常发票/餐饮发票/YYYY年MM月/`，月份来自票面日期。
- 主文件名为 `<含税金额>.<原扩展名>`；异内容冲突使用 `<含税金额>_<发票号码>.<原扩展名>`；绝不覆盖。
- 复制前后必须校验 SHA-256；用户原始飞书附件不得删除；所有本机临时文件必须清理。
- 所有生产代码必须先有失败测试并观察到预期失败；每个 Green 后运行相关测试，阶段末运行完整测试。
- 当前对话未授权 Git commit、push 或 PR；计划中的检查点只运行测试、`git diff --check` 和只读 diff 审查。
- 只有缺少精确 bot scope 或需要用户发送真实测试发票时才暂停请求用户操作。

---

## File Map

### Existing files to modify

- `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/src/main.mjs`
- `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/src/config.mjs`
- `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/src/service.mjs`
- `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/src/lark-runtime.mjs`
- `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/src/state-store.mjs`
- `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/test/config.test.mjs`
- `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/test/service.test.mjs`
- `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/test/lark-runtime.test.mjs`
- `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/test/state-store.test.mjs`
- `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/test/fixtures/fake-lark-cli.mjs`
- `/Volumes/ZHUTONG/LLW的私人助手/LLW/.agents/skills/filing-invoices/SKILL.md`
- `/Volumes/ZHUTONG/LLW的私人助手/LLW/.llw-system/SYSTEM_MAP.md`

### New production files

- `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/src/core/event-normalizer.mjs`
- `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/src/core/security-gate.mjs`
- `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/src/core/capability-router.mjs`
- `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/src/core/dispatcher.mjs`
- `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/src/core/redaction.mjs`
- `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/src/adapters/lark-resource-downloader.mjs`
- `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/src/adapters/lark-reply.mjs`
- `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/src/capabilities/daily-work/capability.mjs`
- `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/src/capabilities/invoice/resource-marker.mjs`
- `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/src/capabilities/invoice/file-inspector.mjs`
- `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/src/capabilities/invoice/decision-client.mjs`
- `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/src/capabilities/invoice/decision-validator.mjs`
- `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/src/capabilities/invoice/archive-writer.mjs`
- `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/src/capabilities/invoice/receipt.mjs`
- `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/src/capabilities/invoice/capability.mjs`
- `/Volumes/ZHUTONG/LLW的私人助手/LLW/.agents/skills/filing-invoices/references/output-schema.json`

### New test files

- `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/test/core-routing.test.mjs`
- `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/test/dispatcher.test.mjs`
- `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/test/invoice-resource-marker.test.mjs`
- `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/test/lark-resource-downloader.test.mjs`
- `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/test/invoice-file-inspector.test.mjs`
- `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/test/invoice-decision-client.test.mjs`
- `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/test/invoice-decision-validator.test.mjs`
- `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/test/invoice-archive-writer.test.mjs`
- `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/test/invoice-capability.test.mjs`
- `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/test/privacy.test.mjs`

---

## Phase A — 可扩展底座重构，业务行为不变

### Task 1: 建立可恢复的本机开发副本和基线证据

**Files:**
- Read: `/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/`
- Create outside workspace: `/private/tmp/llw-feishu-assistant-dev/`
- Create backup at deployment time: `/Users/ccrt/Library/Application Support/LLW Assistant/backups/components/feishu-assistant-pre-invoice-20260719/`

**Interfaces:**
- Consumes: 当前本机组件、配置、状态、LaunchAgent 状态。
- Produces: 一个包含独立 `.git` 元数据但不执行 commit/push 的开发副本；基线测试、权限、服务和 Git clean 证据。

- [ ] **Step 1: 记录只读基线**

Run from the component repository:

```bash
git status --short
/usr/local/bin/npm test
launchctl print gui/501/com.llw.feishu-daily-work
```

Expected:

- `git status --short` 无输出。
- 37 tests、37 pass、0 fail。
- LaunchAgent state 为 running。

- [ ] **Step 2: 创建隔离开发副本**

Run:

```bash
mkdir -p /private/tmp/llw-feishu-assistant-dev
rsync -a --delete "/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work/" /private/tmp/llw-feishu-assistant-dev/
```

Expected: `/private/tmp/llw-feishu-assistant-dev/package.json` 存在；本机运行组件未改变。

- [ ] **Step 3: 在副本重跑基线**

Run:

```bash
/usr/local/bin/npm test
```

Working directory: `/private/tmp/llw-feishu-assistant-dev`

Expected: 37 pass、0 fail。

- [ ] **Step 4: 检查点**

Run:

```bash
diff -qr --exclude .git "/Users/ccrt/Library/Application Support/LLW Assistant/components/feishu-daily-work" /private/tmp/llw-feishu-assistant-dev
```

Expected: 无输出。

### Task 2: 状态 version 3、共享 outcomes 与无损迁移

**Files:**
- Modify: `/private/tmp/llw-feishu-assistant-dev/src/state-store.mjs`
- Modify: `/private/tmp/llw-feishu-assistant-dev/test/state-store.test.mjs`

**Interfaces:**
- Consumes: version 1/2 state JSON。
- Produces: `StateStore.open(file, {maxOutcomes})`；`getCapabilityState(name)`；`setCapabilityState(name,value)`；`hasOutcome(messageId)`；`saveOutcome(messageId,outcome)`；`unreplied()`；`markReplied(messageId)`。Retains `getConversation()`、`setConversation()`、`clearConversation()` as compatibility methods backed only by `capabilityState["daily-work"].conversation`。

- [ ] **Step 1: 写 version 2 → version 3 失败测试**

Add tests that create exact version-2 input and assert:

```js
test("migrates version 2 to version 3 without losing conversation or outcomes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llw-state-v3-"));
  const file = join(dir, "state.json");
  await writeFile(file, JSON.stringify({
    version: 2,
    conversation: {id: "c1", status: "open", turns: [{role: "user", text: "补充"}], candidateIds: []},
    outcomes: {m1: {status: "committed", reply: "已入库", recordIds: ["r1"], replied: true}}
  }));
  const state = await StateStore.open(file);
  assert.equal(state.version(), 3);
  assert.equal(state.getCapabilityState("daily-work").conversation.id, "c1");
  assert.equal(state.hasOutcome("m1"), true);
  const persisted = JSON.parse(await readFile(file, "utf8"));
  assert.equal(persisted.version, 3);
});
```

Add a second test for version 1 using the existing pending shape and assert it becomes `capabilityState["daily-work"].conversation`. Add a third test asserting more than 2000 outcomes removes only oldest replied outcomes and never removes unreplied outcomes.

- [ ] **Step 2: 运行并确认 RED**

Run:

```bash
node --test test/state-store.test.mjs
```

Expected: FAIL because `version()` and `getCapabilityState()` do not exist or persisted version remains 2。

- [ ] **Step 3: 实现最小 version-3 store**

Implement these exact normalization rules:

```js
function normalizeState(parsed) {
  if (parsed?.version === 3 && parsed.capabilityState && parsed.outcomes) return {data: parsed, migrated: false};
  if (parsed?.version === 2 && parsed.outcomes) {
    return {
      data: {
        version: 3,
        capabilityState: {"daily-work": {conversation: parsed.conversation || null}, invoice: {}},
        outcomes: Object.fromEntries(Object.entries(parsed.outcomes).map(([id, outcome]) => [id, {
          capability: "daily-work",
          status: outcome.status,
          reply: outcome.reply,
          artifacts: [],
          replied: outcome.replied === true,
          createdAt: "1970-01-01T00:00:00.000Z"
        }]))
      },
      migrated: true
    };
  }
  throw new Error("unsupported_state_version");
}
```

Add a version-1 branch that calls the existing `migratePending(parsed.pending)` and writes the returned conversation under `capabilityState["daily-work"]`; migrate its outcomes using the same function as version 2. Historical outcome `recordIds` are not Vault paths and must not be copied into `artifacts`; migrated historical outcomes use an empty artifacts array and are exempt from new OutcomeDraft artifact validation.

Expose `version()` and capability-state getters/setters using `structuredClone`. Keep atomic mode-0600 persistence. Eviction loops over insertion order and removes replied entries until count is at most `maxOutcomes`; if no replied entry exists, retain all entries.

- [ ] **Step 4: 运行并确认 GREEN**

Run:

```bash
node --test test/state-store.test.mjs
```

Expected: all state-store tests pass。

- [ ] **Step 5: 回归检查点**

Run:

```bash
/usr/local/bin/npm test
```

Expected: all tests pass；若旧测试依赖 version 2 shape，只更新断言，不改变业务结果。

### Task 3: 事件标准化、安全门禁和确定性路由

**Files:**
- Create: `/private/tmp/llw-feishu-assistant-dev/src/core/event-normalizer.mjs`
- Create: `/private/tmp/llw-feishu-assistant-dev/src/core/security-gate.mjs`
- Create: `/private/tmp/llw-feishu-assistant-dev/src/core/capability-router.mjs`
- Create: `/private/tmp/llw-feishu-assistant-dev/test/core-routing.test.mjs`

**Interfaces:**
- Produces: `normalizeEvent(raw): NormalizedEvent`；`checkSecurity(event,binding): {ok:true}|{ok:false,reason,notify:false}`；`routeCapability(event,context,capabilities): CapabilityDefinition|null`。

- [ ] **Step 1: 写失败测试**

Test exact normalized fields, rejection of invalid timestamps, silent rejection for another sender/group, one match, zero match, and route conflict:

```js
test("router returns exactly one capability and rejects overlap", () => {
  const event = normalizeEvent({event_id:"e1", message_id:"m1", sender_id:"u1", chat_id:"c1", chat_type:"p2p", message_type:"image", content:"![Image](img_abc)", create_time:"1784426400000"});
  const a = {name:"invoice", match:item => item.messageType === "image"};
  assert.equal(routeCapability(event, {}, [a]), a);
  assert.throws(() => routeCapability(event, {}, [a, {name:"other", match:() => true}]), /route_conflict/);
});
```

- [ ] **Step 2: 运行并确认 RED**

Run: `node --test test/core-routing.test.mjs`

Expected: FAIL with module-not-found for `src/core/event-normalizer.mjs`。

- [ ] **Step 3: 实现最小模块**

Implement `normalizeEvent` with explicit string checks and positive finite timestamp conversion. Implement `checkSecurity` in sender → chat → p2p order. Implement router by filtering capabilities whose `match` returns true; return null for zero, element for one, throw `route_conflict:<sorted-names>` for more than one.

- [ ] **Step 4: 运行并确认 GREEN**

Run: `node --test test/core-routing.test.mjs`

Expected: all tests pass。

### Task 4: 通用 dispatcher、先保存后回执和恢复

**Files:**
- Create: `/private/tmp/llw-feishu-assistant-dev/src/core/dispatcher.mjs`
- Create: `/private/tmp/llw-feishu-assistant-dev/test/dispatcher.test.mjs`

**Interfaces:**
- Consumes: normalized event, binding, StateStore, capability list, messenger。
- Produces: `Dispatcher.handleRawEvent(raw)`；`Dispatcher.resumeReplies()`。

- [ ] **Step 1: 写失败测试**

Use real StateStore in a temp directory and fake capability/messenger. Assert duplicate message runs capability once; state save failure sends nothing; send failure leaves one unreplied outcome; resume sends stored reply without re-running capability.

Core expected assertion:

```js
assert.deepEqual(order, ["handle", "save", "send", "mark"]);
```

- [ ] **Step 2: 运行并确认 RED**

Run: `node --test test/dispatcher.test.mjs`

Expected: FAIL with module-not-found for `src/core/dispatcher.mjs`。

- [ ] **Step 3: 实现最小 dispatcher**

Implement a serialized queue and this ordering:

```js
async dispatch(event) {
  const security = checkSecurity(event, this.binding);
  if (!security.ok) return {handled:false, reason:security.reason};
  if (event.messageType === "text" && !event.content.trim()) return {handled:false, reason:"empty_text"};
  if (this.state.hasOutcome(event.messageId)) return {handled:false, reason:"duplicate"};
  const capability = routeCapability(event, {state:this.state}, this.capabilities);
  const draft = capability
    ? await capability.handle(event, {state:this.state})
    : {status:"ignored", reply:"当前不支持此类消息，未下载、未交给 AI、未入库。", artifacts:[]};
  await this.state.saveOutcome(event.messageId, {capability:capability?.name || "core", ...draft});
  const capabilityName = capability?.name || "core";
  const idempotencyKey = capabilityName === "invoice" ? `invoice-reply:${event.messageId}` : `reply:${event.messageId}`;
  await this.messenger.send({capability:capabilityName, event, text:draft.reply, idempotencyKey});
  await this.state.markReplied(event.messageId);
  return {handled:true, status:draft.status};
}
```

Wrap capability exceptions as `failed` with a safe generic reply; never allow exception text into reply or logs.

- [ ] **Step 4: 运行并确认 GREEN**

Run: `node --test test/dispatcher.test.mjs`

Expected: all tests pass。

### Task 5: 将每日工作适配为 capability，不改变业务结果

**Files:**
- Create: `/private/tmp/llw-feishu-assistant-dev/src/capabilities/daily-work/capability.mjs`
- Modify: `/private/tmp/llw-feishu-assistant-dev/src/service.mjs`
- Modify: `/private/tmp/llw-feishu-assistant-dev/test/service.test.mjs`
- Modify: `/private/tmp/llw-feishu-assistant-dev/test/dispatcher.test.mjs`

**Interfaces:**
- Produces: `createDailyWorkCapability({service})` with name `daily-work`, text-only match, and `handle` returning OutcomeDraft。
- Changes: DailyWorkService no longer sends or stores shared outcome; it returns OutcomeDraft and only owns conversation/catalog/writer behavior。

- [ ] **Step 1: 修改测试形成 RED**

Change service harness expectations so `service.handleEvent(baseEvent)` returns:

```js
{
  status: "committed",
  reply: "已入库，整理内容如下：\n1. 完成方案评审。\n位置：亚信工作/每日工作/2026年07月19日/工作记录.md",
  artifacts: ["亚信工作/每日工作/2026年07月19日/工作记录.md"]
}
```

Assert service itself does not call send or `saveOutcome`; dispatcher integration calls each once.

- [ ] **Step 2: 运行并确认 RED**

Run: `node --test test/service.test.mjs test/dispatcher.test.mjs`

Expected: FAIL because current service sends and persists internally。

- [ ] **Step 3: 最小重构**

Extract shared delivery from `DailyWorkService.finish`. Keep `catalog`, `decide`, `writer`, conversation updates and all existing Chinese replies. Convert writer `files` to `artifacts`. Implement capability:

```js
export function createDailyWorkCapability({service}) {
  return {
    name: "daily-work",
    match: event => event.messageType === "text" && event.content.trim().length > 0,
    handle: event => service.handleEvent({
      message_id:event.messageId,
      create_time:event.createTimeMs,
      content:event.content,
      sender_id:event.senderId,
      chat_id:event.chatId,
      chat_type:event.chatType,
      message_type:event.messageType
    })
  };
}
```

- [ ] **Step 4: 运行相关测试 GREEN**

Run: `node --test test/service.test.mjs test/dispatcher.test.mjs`

Expected: all tests pass。

- [ ] **Step 5: Phase A 完整回归**

Run:

```bash
/usr/local/bin/npm test
git diff --check
```

Expected: all tests pass；`git diff --check` 无输出。此检查通过前不得开始 Phase B。

---

## Phase B — 发票能力 Red–Green–Refactor

### Task 6: 发票输出 Schema 和资源 marker 解析

**Files:**
- Create: `/Volumes/ZHUTONG/LLW的私人助手/LLW/.agents/skills/filing-invoices/references/output-schema.json`
- Create: `/private/tmp/llw-feishu-assistant-dev/src/capabilities/invoice/resource-marker.mjs`
- Create: `/private/tmp/llw-feishu-assistant-dev/test/invoice-resource-marker.test.mjs`

**Interfaces:**
- Produces: `parseInvoiceResource(event): {fileKey,type}`。
- Produces: strict JSON Schema with `additionalProperties:false` at every object level and all required fields from the design。

- [ ] **Step 1: 写 marker 失败测试**

Cover exact image marker, file attributes in either order, invalid prefixes, zero key, two keys, extra surrounding text and unsupported message type.

```js
assert.deepEqual(parseInvoiceResource({messageType:"image", content:"![Image](img_abc-123)"}), {fileKey:"img_abc-123", type:"image"});
assert.deepEqual(parseInvoiceResource({messageType:"file", content:'<file name="票.jpg" key="file_abc"/>'}), {fileKey:"file_abc", type:"file"});
assert.throws(() => parseInvoiceResource({messageType:"file", content:'x <file key="file_abc"/>"'}), /invalid_resource_marker/);
```

- [ ] **Step 2: 运行并确认 RED**

Run: `node --test test/invoice-resource-marker.test.mjs`

Expected: FAIL with module-not-found。

- [ ] **Step 3: 实现 parser 和 Schema**

Use an anchored image regex. For file content, require anchored `<file .../>`, collect every `key="..."` occurrence, require exactly one, then validate `^file_[A-Za-z0-9_-]+$`. Do not use `fromjson` or an XML parser dependency.

Schema action enum is `archive_dining|needs_clarification|reject`; confidence is `high|medium|low`; invoice object contains exactly invoice_number, issue_date, buyer_name, buyer_tax_id, seller_name, item_name, total_with_tax and file_format。

- [ ] **Step 4: 验证 GREEN 和 Schema 可解析**

Run:

```bash
node --test test/invoice-resource-marker.test.mjs
node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")); console.log("schema-ok")' "/Volumes/ZHUTONG/LLW的私人助手/LLW/.agents/skills/filing-invoices/references/output-schema.json"
```

Expected: tests pass and output `schema-ok`。

### Task 7: lark-cli 安全下载 adapter

**Files:**
- Create: `/private/tmp/llw-feishu-assistant-dev/src/adapters/lark-resource-downloader.mjs`
- Modify: `/private/tmp/llw-feishu-assistant-dev/test/fixtures/fake-lark-cli.mjs`
- Create: `/private/tmp/llw-feishu-assistant-dev/test/lark-resource-downloader.test.mjs`

**Interfaces:**
- Produces: `downloadLarkResource({cliPath,profile,messageId,fileKey,type,tempRoot,environment,timeoutMs,maxAttempts=3,retryDelayMs=500}): Promise<{tempDir,file}>`。

- [ ] **Step 1: 写 argv、cwd、权限和输出失败测试**

Fake CLI writes one minimal PNG into its cwd when invoked with `+messages-resources-download`. Assert exact argv contains bot identity, relative output `attachment`, and no absolute output. Run the success fixture with LaunchAgent 的受限 PATH `/usr/bin:/bin:/usr/sbin:/sbin`，证明 downloader 会补入 `/usr/local/bin`，否则 `#!/usr/bin/env node` 必然无法启动。Assert the child receives `LARK_CLI_NO_PROXY=1` and both notifier suppression variables. Add tests for zero output, two outputs, symlink output, exit nonzero, timeout, and one transient nonzero exit followed by success; the transient fixture must leave a partial file so the test also proves cleanup before retry.

- [ ] **Step 2: 运行并确认 RED**

Run: `node --test test/lark-resource-downloader.test.mjs`

Expected: FAIL with module-not-found。

- [ ] **Step 3: 实现最小 downloader**

Use `mkdir(tempRoot,{recursive:true,mode:0o700})`, `mkdtemp(join(tempRoot,"job-"))`, spawn with `cwd:tempDir`, args:

```js
["--profile",profile,"im","+messages-resources-download","--as","bot","--message-id",messageId,"--file-key",fileKey,"--type",type,"--output","attachment"]
```

Before spawn, prepend and deduplicate `/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` exactly as the event listener and reply adapters do, then force `LARK_CLI_NO_PROXY=1` and both lark-cli notifier suppression variables. Retry only `download_failed`, with at most 3 total attempts and delays of 500 ms then 1000 ms; clear incomplete job output before each retry. Do not retry timeout or unsafe-output failures. After exit 0, use `readdir({withFileTypes:true})`, require one regular file, `lstat` and reject symbolic links. On final failure, `rm(tempDir,{recursive:true,force:true})` before throwing a safe code.

- [ ] **Step 4: 运行并确认 GREEN**

Run: `node --test test/lark-resource-downloader.test.mjs`

Expected: all tests pass。

### Task 8: 文件头、扩展名、大小和 PDF/OFD 分流

**Files:**
- Create: `/private/tmp/llw-feishu-assistant-dev/src/capabilities/invoice/file-inspector.mjs`
- Create: `/private/tmp/llw-feishu-assistant-dev/test/invoice-file-inspector.test.mjs`

**Interfaces:**
- Produces: `inspectInvoiceFile(file,{maxBytes=20971520}): Promise<{kind:"supported_image"|"pdf"|"ofd"|"unsupported",format,extension,sizeBytes}>`。

- [ ] **Step 1: 写完整格式矩阵失败测试**

Create temp files with exact JPEG/PNG/WebP/PDF/ZIP headers. Assert correct image+extension passes; mismatched extension, no extension, empty, 20 MiB + 1 byte and executable double suffix reject; PDF/OFD return their non-AI kinds.

- [ ] **Step 2: 运行并确认 RED**

Run: `node --test test/invoice-file-inspector.test.mjs`

Expected: FAIL with module-not-found。

- [ ] **Step 3: 实现最小 inspector**

Read `lstat`, size and first 16 bytes. Detect signatures in JPEG → PNG → WebP → PDF → ZIP order. Map `.jpg` and `.jpeg` to format `jpeg`; require extension/header agreement. A ZIP is OFD only when extension is exactly `.ofd`; all other ZIP files are unsupported. Split the lowercase basename on dots and reject when any suffix before the final image suffix is one of `exe,com,bat,cmd,sh,js,mjs,app,dmg,pkg`. Never inspect content beyond what the selected format requires.

- [ ] **Step 4: 运行并确认 GREEN**

Run: `node --test test/invoice-file-inspector.test.mjs`

Expected: all tests pass。

### Task 9: Codex 图片决策客户端与严格安全验证器

**Files:**
- Create: `/private/tmp/llw-feishu-assistant-dev/src/capabilities/invoice/decision-client.mjs`
- Create: `/private/tmp/llw-feishu-assistant-dev/src/capabilities/invoice/decision-validator.mjs`
- Create: `/private/tmp/llw-feishu-assistant-dev/test/invoice-decision-client.test.mjs`
- Create: `/private/tmp/llw-feishu-assistant-dev/test/invoice-decision-validator.test.mjs`
- Modify: `/private/tmp/llw-feishu-assistant-dev/test/fixtures/fake-codex.mjs`

**Interfaces:**
- Produces: `invokeInvoiceDecision({codexPath,workspaceRoot,skillRoot,file,format,environment,timeoutMs,maxAttempts=2,retryDelayMs=1000}): Promise<InvoiceDecision>`。
- Produces: `validateInvoiceDecision(decision,{detectedFormat}): ValidatedDecision`。

- [ ] **Step 1: 写 Codex argv 和隐私 RED 测试**

Assert argv includes `--ephemeral`, `--sandbox read-only`, `--image <file>`, medium reasoning, output-schema under filing-invoices and output-last-message. Assert stdin includes `$filing-invoices` and does not contain `sender_id`, `chat_id`, `message_id`, `file_key` or fake ID values. Fake Codex 还必须支持“第一次非零退出、第二次写入合法结果”的模式，证明客户端只对瞬时非零退出自动重试一次。

- [ ] **Step 2: 写硬门槛 RED 测试**

Create a valid decision fixture, then mutate one field per subtest. Required cases: wrong buyer name, wrong tax ID, missing field, medium confidence, category non_dining, invalid invoice number, impossible date, zero/three-decimal amount, format mismatch, unexpected question and extra object field. Every mutation must throw; valid decision passes.

- [ ] **Step 3: 运行并确认 RED**

Run: `node --test test/invoice-decision-client.test.mjs test/invoice-decision-validator.test.mjs`

Expected: FAIL with missing modules。

- [ ] **Step 4: 实现 decision client**

Follow existing Codex child-process pattern but add `--image`. Use an ephemeral output directory, ignore stdout, count stderr bytes, SIGTERM at 120000 ms, parse output JSON, and always remove the output directory. 对非零退出执行最多 2 次总尝试、间隔 1000 ms，并在重试前删除残留 output；spawn 错误、超时、非法 JSON 和 validator 拒绝均不得重试。

- [ ] **Step 5: 实现唯一硬门槛 validator**

Put buyer constants only in this file. Explicitly enumerate top-level and invoice keys, reject unknown/missing fields, validate action combinations, calendar date with UTC reconstruction, amount regex plus numeric > 0, invoice number regex and detected format equality. `archive_dining` returns only when every design condition passes; other actions validate their question rules but never return an archive authorization.

- [ ] **Step 6: 运行并确认 GREEN**

Run: `node --test test/invoice-decision-client.test.mjs test/invoice-decision-validator.test.mjs`

Expected: all tests pass。

### Task 10: FAT32 防覆盖、持久事务恢复和 SHA-256 归档 writer

**Files:**
- Create: `/private/tmp/llw-feishu-assistant-dev/src/capabilities/invoice/archive-writer.mjs`
- Create: `/private/tmp/llw-feishu-assistant-dev/test/invoice-archive-writer.test.mjs`
- Modify: `/private/tmp/llw-feishu-assistant-dev/src/state-store.mjs`
- Modify: `/private/tmp/llw-feishu-assistant-dev/test/state-store.test.mjs`

**Interfaces:**
- Produces: `InvoiceArchiveWriter.archive({transactionId,source,invoice,extension}): Promise<{status:"committed"|"existing"|"awaiting_clarification",relativePath?:string,reason?:string}>` and `InvoiceArchiveWriter.recoverTransactions(): Promise<void>`。
- Produces StateStore methods: `prepareInvoiceTransaction(id,data)`、`updateInvoiceTransaction(id,status)`、`listInvoiceTransactions()`。

- [ ] **Step 1: 写路径与冲突矩阵 RED 测试**

Use a temporary fake Vault containing `.obsidian` and `.llw-system/SYSTEM_MAP.md`. Cover new primary, same-hash primary, different primary/new fallback, same-hash fallback, different-hash fallback, wrong Vault markers, symlink archive root, wrong issue month, path-safe invoice number, and `COPYFILE_EXCL` race via pre-created target.

- [ ] **Step 2: 写哈希校验 RED 测试**

Inject a hash function or copy hook that returns a different final hash and assert status is never committed, source remains untouched, target is not overwritten or automatically deleted, and transaction becomes `needs_inspection`. Add startup recovery tests for prepared+missing → aborted, prepared+same hash → published, and prepared+different hash → needs_inspection.

- [ ] **Step 3: 运行并确认 RED**

Run: `node --test test/invoice-archive-writer.test.mjs`

Expected: FAIL with module-not-found。

- [ ] **Step 4: 实现最小 writer**

Use `realpath`, `lstat`, SHA-256 streams and `copyFile(source,target,COPYFILE_EXCL)`. The actual U disk is FAT32, so do not call `link()` and do not validate U-disk chmod bits. Before copy, atomically persist a prepared transaction in the Mac mode-0600 state file. After copy, hash the final target and mark published only on equality. On `EEXIST`, re-run the collision state machine once. A present mismatched target becomes `needs_inspection` and is never deleted, renamed or overwritten automatically. `recoverTransactions()` applies the exact missing/same/different target matrix before the event listener starts.

- [ ] **Step 5: 运行并确认 GREEN**

Run: `node --test test/invoice-archive-writer.test.mjs test/state-store.test.mjs`

Expected: all tests pass。

### Task 11: 发票 capability 编排、固定回执和全路径清理

**Files:**
- Create: `/private/tmp/llw-feishu-assistant-dev/src/capabilities/invoice/receipt.mjs`
- Create: `/private/tmp/llw-feishu-assistant-dev/src/capabilities/invoice/capability.mjs`
- Create: `/private/tmp/llw-feishu-assistant-dev/test/invoice-capability.test.mjs`

**Interfaces:**
- Produces: `createInvoiceCapability(deps): CapabilityDefinition` with name `invoice`。
- Consumes: parser, downloader, inspector, decision client, validator and writer through injected functions/objects。

- [ ] **Step 1: 写端到端单元 RED 测试**

Use real parser/validator/receipt and fake downloader/AI/writer. Cover:

- committed → success receipt and one artifact
- existing → existing receipt and no copy
- buyer mismatch → rejected and writer calls 0
- category uncertain → awaiting_clarification and writer calls 0
- PDF/OFD/unsupported → fixed reply and AI/writer calls 0
- downloader/AI/writer exception → failed safe reply
- cleanup function runs exactly once on every branch
- two sequential attachments produce independent outcomes

- [ ] **Step 2: 运行并确认 RED**

Run: `node --test test/invoice-capability.test.mjs`

Expected: FAIL with module-not-found。

- [ ] **Step 3: 实现最小 capability**

Exact flow inside `handle`:

Import `createHash` from `node:crypto` at module scope, then execute:

```js
const resource = parseInvoiceResource(event);
const transactionId = createHash("sha256").update(`invoice:${event.messageId}:${resource.fileKey}`).digest("hex").slice(0,32);
let downloaded;
try {
  downloaded = await download({...resource, messageId:event.messageId});
  const inspected = await inspect(downloaded.file);
  if (inspected.kind !== "supported_image") return formatUnsupported(inspected.kind);
  const raw = await decide({file:downloaded.file, format:inspected.format});
  const decision = validate(raw, {detectedFormat:inspected.format});
  if (decision.action !== "archive_dining") return formatNonArchive(decision);
  const archived = await writer.archive({transactionId, source:downloaded.file, invoice:decision.invoice, extension:inspected.extension});
  return formatArchive(decision, archived);
} finally {
  if (downloaded?.tempDir) await cleanup(downloaded.tempDir);
}
```

Each exception maps to a fixed safe reply by controlled error code; never interpolate exception messages.

- [ ] **Step 4: 运行并确认 GREEN**

Run: `node --test test/invoice-capability.test.mjs`

Expected: all tests pass。

### Task 12: 配置 version 3、主进程组合和飞书 reply adapter

**Files:**
- Modify: `/private/tmp/llw-feishu-assistant-dev/src/config.mjs`
- Modify: `/private/tmp/llw-feishu-assistant-dev/src/main.mjs`
- Modify: `/private/tmp/llw-feishu-assistant-dev/src/lark-runtime.mjs`
- Create: `/private/tmp/llw-feishu-assistant-dev/src/adapters/lark-reply.mjs`
- Create: `/private/tmp/llw-feishu-assistant-dev/src/core/redaction.mjs`
- Modify: `/private/tmp/llw-feishu-assistant-dev/test/config.test.mjs`
- Modify: `/private/tmp/llw-feishu-assistant-dev/test/lark-runtime.test.mjs`
- Create: `/private/tmp/llw-feishu-assistant-dev/test/privacy.test.mjs`

**Interfaces:**
- Config exactly matches design version 3 and rejects unknown capability fields。
- Main constructs one listener, one dispatcher, daily-work capability and invoice capability。
- Messenger sends daily work by chat and invoice by source-message reply, both bot identity and stable idempotency keys。
- Produces: `safeLog({stage,code,messageId,durationMs,sizeBytes,stderrBytes,retryCount}): string` containing only allowlisted fields and a 12-hex correlation。

- [ ] **Step 1: 写配置和 argv RED 测试**

Assert exact version-3 fields, absolute paths, fixed 20 MiB and 120000 ms, no secret fields, unknown field rejection, and file mode 0600. Assert invoice reply argv equals:

```js
["--profile","llw-private","im","+messages-reply","--as","bot","--message-id","m1","--text","发票已归档","--idempotency-key","invoice-reply:m1"]
```

- [ ] **Step 2: 写隐私 RED 测试**

Feed fake identifiers, content, invoice number, buyer/seller, amount and token into controlled failures. Capture stdout/stderr and assert none of those exact strings appear; assert a 12-hex correlation and safe stage/error code are present.

- [ ] **Step 3: 运行并确认 RED**

Run: `node --test test/config.test.mjs test/lark-runtime.test.mjs test/privacy.test.mjs`

Expected: FAIL for missing version-3 config and reply adapter。

- [ ] **Step 4: 实现配置、组合、reply 和脱敏日志**

Keep process umask `0o077`, current heartbeat and graceful shutdown. Replace direct DailyWorkService listener callback with dispatcher. Register exact array `[dailyWorkCapability, invoiceCapability]`. Call `invoiceArchiveWriter.recoverTransactions()` before `dispatcher.resumeReplies()` and before starting the event listener. Start no second listener. Add startup temp scavenging only for directories matching `^job-[A-Za-z0-9_-]+$`, older than 24 hours, and not symlinks.

Implement `safeLog` as one JSON line. It computes `correlation = sha256("log:" + messageId).digest("hex").slice(0,12)`, accepts only stage/code plus numeric durationMs/sizeBytes/stderrBytes/retryCount, and discards every unknown input key. Production code must pass safe scalar codes rather than Error objects.

- [ ] **Step 5: 运行并确认 GREEN**

Run: `node --test test/config.test.mjs test/lark-runtime.test.mjs test/privacy.test.mjs`

Expected: all tests pass。

### Task 13: 离线全量验证和需求逐条审计

**Files:**
- Read all changed files in `/private/tmp/llw-feishu-assistant-dev/`
- Read: design spec and this plan

**Interfaces:**
- Produces: fresh evidence that all tests, syntax, privacy and requirements pass before deployment。

- [ ] **Step 1: 运行完整测试**

Run:

```bash
/usr/local/bin/npm test
```

Expected: 0 fail、0 cancelled、0 skipped；测试总数大于 37。

- [ ] **Step 2: 运行语法和 diff 检查**

Run:

```bash
find src test -name '*.mjs' -type f -print0 | xargs -0 -n1 /usr/local/bin/node --check
git diff --check
```

Expected: all commands exit 0；无输出错误。

- [ ] **Step 3: 敏感信息扫描**

Run searches for real config values by reading them inside a local script and comparing without printing the values. Also search source for secret field names and forbidden raw logging calls. Expected: no real identifier or secret is present in source/test/docs; no production log statement contains event/content/decision objects.

- [ ] **Step 4: 逐条对照设计完成标准**

Check all ten completion criteria in design section 23. Any criterion without a test or command receives a new failing test before proceeding. Do not deploy on a partial pass。

---

## Phase C — 本机部署、健康检查和真实验收

### Task 14: 受保护备份、部署与可回滚状态迁移

**Files:**
- Backup: current component, config, state and LaunchAgent plist to Mac backup directory
- Deploy: `/private/tmp/llw-feishu-assistant-dev/` into current component directory
- Modify local protected config to version 3

**Interfaces:**
- Produces: deployed code with unchanged LaunchAgent label and one event consumer；timestamped rollback source。

- [ ] **Step 1: 创建本机备份并验证**

Create a timestamped mode-0700 directory under `/Users/ccrt/Library/Application Support/LLW Assistant/backups/components/`. Copy component excluding `.git`, config, state and installed plist. Compare file counts and SHA-256 manifests. Never print config/state contents。

- [ ] **Step 2: 停止服务**

Use `launchctl bootout gui/501/com.llw.feishu-daily-work` or the installed platform-equivalent command. Confirm event status no longer lists its consumer. Do not use SIGKILL。

- [ ] **Step 3: 部署代码和配置**

Use `rsync -a --delete --exclude .git/` from the verified development copy to the component directory. Update protected config atomically to version 3 without changing profile/sender/chat values. Keep config and state at mode 0600。

- [ ] **Step 4: 部署前本机完整测试**

Run `/usr/local/bin/npm test` in the deployed component directory。

Expected: same test count and 0 failures as Task 13。

- [ ] **Step 5: 启动与健康检查**

Bootstrap the LaunchAgent, then verify:

```bash
launchctl print gui/501/com.llw.feishu-daily-work
/Users/ccrt/bin/lark-cli event status --json
```

Expected: service running、heartbeat fresh、`im.message.receive_v1` exactly one active consumer、dropped 0。Inspect only safe error codes and log byte counts。

- [ ] **Step 6: 回滚演练检查**

Without altering user data, verify backup contains all required restore targets and manifests match. Do not actually roll back a healthy deployment。

### Task 15: 最小权限实测与一张真实发票的有界端到端验收

**Files:**
- Runtime temp only under protected Mac state directory
- Archive output only under `/Volumes/ZHUTONG/LLW的私人助手/LLW/亚信工作/日常发票/餐饮发票/YYYY年MM月/`

**Interfaces:**
- Produces: evidence for event, download, identify, validate, archive, receipt, idempotency and cleanup。

- [ ] **Step 1: 请求用户发送测试发票**

Ask the bound user to send one clear JPG/JPEG/PNG/WebP dining invoice whose printed buyer name and tax ID exactly match the hard gate. Do not ask the user to reveal identifiers or credentials。

- [ ] **Step 2: 有界观察单个事件**

Use the deployed service and status counters; do not launch a second `im.message.receive_v1` consumer. Wait for exactly one new invoice outcome or a bounded timeout of 3 minutes。

- [ ] **Step 3: 处理精确权限阻塞**

If download returns structured `missing_scope`, extract only `missing_scopes` and `console_url`, confirm the only requested scope is `im:message:readonly`, provide the exact developer-console URL, and stop. Never run bot `auth login`。After the user grants and publishes it, retry with the same service path。

- [ ] **Step 4: 验证完整链路**

Confirm using protected state and filesystem metadata without logging ticket contents:

- one event claimed by invoice
- one download completed
- file signature and size accepted
- AI Schema valid and eight fields non-empty
- buyer exact match and dining category
- target month derived from issue date
- final filename follows amount/collision rules
- final SHA-256 equals downloaded source SHA-256
- Flybook reply status committed or existing
- temp job directory removed
- original Flybook attachment untouched

- [ ] **Step 5: 验证幂等**

Replay the saved event only through a local test harness or call dispatcher with the same protected message ID inside the process without printing it. Assert download, AI and writer counters remain zero and no second archive file appears。

- [ ] **Step 6: 更新系统地图**

After all checks pass, update `/Volumes/ZHUTONG/LLW的私人助手/LLW/.llw-system/SYSTEM_MAP.md` with exact module locations, supported formats, permission scopes, LaunchAgent state, test count and E2E result. Do not include ticket fields or Flybook IDs。

- [ ] **Step 7: 最终验证**

Freshly run the complete deployed test suite, LaunchAgent check, heartbeat check, event-status check, archive hash check and privacy scan. Only after all exit 0 report completion to the user。

---

## Execution Stop Conditions

Stop immediately and report the exact safe blocker if any condition occurs:

1. A pre-existing user change appears in the local component repository after baseline capture.
2. Existing daily-work regression tests fail for a business-behavior reason.
3. The event bus shows more than one active `im.message.receive_v1` consumer.
4. The required bot scope is broader than `im:message:readonly` or `im:message:send_as_bot`.
5. State migration cannot preserve all existing outcomes and the active conversation.
6. Vault markers or archive root realpath do not match the approved path.
7. A copy/hash test indicates any possibility of overwriting an existing file.
8. A privacy test finds a real identifier, message, ticket field, attachment content or token in source/log output.
9. Real invoice fields are not clear enough to satisfy every hard gate.
10. Any destructive cleanup would need to delete a user file rather than a program-owned random temp file.

## Spec Traceability Matrix

| Design requirement | Implemented and verified by |
|---|---|
| Single consumer, normalization, security gate, one-owner routing | Tasks 3, 4, 12, 14 |
| Capability contract and static registration | Tasks 3, 5, 11, 12 |
| Version-3 state, migration, outbox and crash reply recovery | Tasks 2, 4, 13, 14 |
| Existing daily-work behavior unchanged | Tasks 5, 12, 13, 14 |
| Lark marker parsing and bot attachment download | Tasks 6, 7, 11 |
| JPEG/PNG/WebP signatures, 20 MiB limit, PDF/OFD route | Tasks 8, 11 |
| Read-only Codex + filing-invoices + strict Schema | Tasks 6, 9, 11 |
| Exact buyer gate, dining semantics boundary and field validation | Tasks 9, 11 |
| Month path, amount filename, collision state machine | Task 10 |
| FAT32 no-overwrite copy, transaction recovery and SHA-256 | Tasks 2, 10, 13, 15 |
| Per-attachment outcomes and failure isolation | Tasks 4, 11, 12 |
| Fixed user receipts and restart delivery | Tasks 4, 11, 12 |
| Local temp cleanup and original attachment preservation | Tasks 7, 8, 11, 15 |
| Privacy, no raw identifiers/content/secrets in logs | Tasks 9, 12, 13, 15 |
| Minimal bot scopes and no bot OAuth | Tasks 7, 14, 15 |
| Offline suite, deployment, rollback and health checks | Tasks 13, 14 |
| One real invoice bounded E2E and system-map update | Task 15 |
| No Git commit/push/PR | Global Constraints, Tasks 1, 13, 14 |

## Final Evidence Report Format

The completion report must list fresh evidence, not predictions:

- implementation files and architectural boundary
- exact test command and pass/fail count
- service state and single-consumer count
- permission scopes actually used
- E2E stages: event, download, identification, validation, archive, reply, cleanup
- archive result as Vault-relative path
- SHA-256 equality result without exposing hashes unless the user requests them
- daily-work regression result
- remaining non-goals: PDF/OFD automation, group chat, docs and weekly report
- confirmation that no Git commit/push/PR occurred
