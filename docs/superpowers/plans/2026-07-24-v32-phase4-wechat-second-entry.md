# LLW V3.2 普通微信第二入口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不安装 OpenClaw、不退出飞书、不复制业务核心的前提下，为项目所有者增加普通微信一对一私聊入口；微信文字复用 `daily-work`，微信图片/PDF 复用 `invoice`，微信支持三个精确 `/llw-model` 命令，并能单独关闭和恢复。

**Architecture:** 在现有 Node.js 模块化单体中增加一个默认关闭的微信直接 HTTPS 入口；飞书和微信先各自校验并转换为同一个 `IncomingMessage`，再进入同一个 `Dispatcher` 队列、Router、模型状态和两个业务 capability。微信 token 只进 macOS 钥匙串，平台标识/游标/回复上下文只进受保护本机状态；微信 runtime 的错误被入口内部吸收，不能结束飞书 listener。

**Tech Stack:** Node.js 24 ESM、Node 内置 `fetch`/`node:crypto`/`node:test`、macOS Keychain `/usr/bin/security`、原子 JSON 状态、现有 LaunchAgent、现有 lark-cli、Codex CLI、DeepSeek HTTPS、Obsidian Vault。

## Global Constraints

- 唯一设计基线：`/Users/ccrt/Downloads/LLW_PERSONAL_AI_SKILL_PLATFORM_MASTER_CONSTRUCTION_BASELINE_V3_2.md`。
- 计划状态：已制定，阶段四实现尚未开始。
- 计划分支：`agent/v32-phase4-wechat-plan`，起点为组件仓库已合并 `main` 提交 `2cba8a2`。
- 当前生产保持阶段三提交 `7837454`、模型 `codex`、一个 LaunchAgent、一个 Node.js 主进程和一个直属 lark-cli 事件消费者。

- 严格按 V3.2 阶段四执行；任何需要突破边界的情况立即停止并报告。
- 行为变更一律 RED → GREEN → REFACTOR；未先看到对应失败测试，不写实现。
- 阶段四只增加一个薄微信入口，不新增 Skill、业务数据库、消息队列、Agent 框架、通用渠道 SDK或管理后台。
- 不安装、运行或迁移到 OpenClaw；不把腾讯插件作为运行依赖。
- 不做微信群、多用户、主动群发、完整语音、视频、通用聊天或新业务能力。
- 飞书与微信共用一个 `Dispatcher` 队列、同一 Router、同一模型状态、同一两个业务 Skill、同一写入器和同一发票哈希/事务规则。
- 微信令牌只能存放在 macOS 钥匙串；微信标识、同步游标和回复上下文只能存放在权限 `0600` 的受保护本机状态，不得进入工作区、Git、Obsidian、普通日志或测试快照。
- `wechatEnabled=false` 时不得读取微信钥匙串、不得访问微信网络、不得改变飞书启动和运行行为。
- 任何真实扫码授权、钥匙串写入、生产配置修改、LaunchAgent 重启、真实 Vault 写入、Mac 重启和 Git 推送都在对应步骤另行取得项目所有者明确批准。

---

## 已核对事实与固定设计

1. 组件 `main` 已包含阶段二和阶段三源变更；完整基线测试为 240/240。
2. 当前 `IncomingMessage.source` 和 `ReplyTarget.source` 已允许 `feishu | wechat`，但只有飞书转换函数；`Dispatcher`、安全门、恢复回复和附件下载仍直接依赖飞书字段。
3. 腾讯公开仓库 `Tencent/openclaw-weixin` 在提交 `cef0bfc390393f716903e16d50408118047f87e0` 的 README 中明确给出了“自有后端”所需的 HTTP JSON 接口、长轮询、回复消息和媒体字段。阶段四只把该仓库作为协议证据与实现参考，不安装其 OpenClaw 插件或宿主。
4. 直接接入固定使用 Node.js 24 已有内置能力：`fetch`、`node:crypto`、`node:fs`、`node:child_process`；不增加 npm 运行依赖。若实际验证证明必须增加第三方依赖，立即停止并单独请示。
5. 当前正式 Skills 不修改；微信原始事件、用户标识、会话标识、消息标识、上下文令牌、CDN 参数和本机路径均不得进入 Router 或业务 Skill。
6. 阶段五的一页 `.llw-system/OPERATIONS.md` 不提前在阶段四建设；阶段四只更新事实地图和可行性记录。

## Task 4.1：不安装 OpenClaw 的可行性门禁

**精确文件**

- 新建：`/Volumes/ZHUTONG/LLW的私人助手/LLW/.llw-system/WECHAT_THIN_ADAPTER_FEASIBILITY.md`
- 不修改生产代码、配置、状态、LaunchAgent 或钥匙串。

**Interfaces**

- Consumes: V3.2 第 7.2–7.5、阶段四和回滚边界；腾讯协议证据提交 `cef0bfc390393f716903e16d50408118047f87e0`。
- Produces: 一份不含秘密和平台标识的 `pass | blocked` 可行性结论；`pass` 是 Task 4.2 的前置条件。

- [ ] **Step 1: 逐项摘录协议证据**

  只记录 QR、`getupdates`、`sendmessage`、`message_id`、`context_token`、媒体引用、游标、重连和许可证所在的上游文件/提交，不复制 token、二维码或实例数据。

- [ ] **Step 2: 核对不安装 OpenClaw 的硬门禁**

  在可行性文档写入精确结论：

  ```text
  runtime_dependency_openclaw=false
  runtime_dependency_third_party_sdk=false
  protocol_source=Tencent/openclaw-weixin@cef0bfc390393f716903e16d50408118047f87e0
  ```

- [ ] **Step 3: 运行文档秘密扫描**

  Run:

  ```bash
  rg -n 'Bearer |bot_token|context_token.{0,20}[A-Za-z0-9_-]{12}|qrcode.{0,20}[A-Za-z0-9_-]{12}' .llw-system/WECHAT_THIN_ADAPTER_FEASIBILITY.md
  ```

  Expected: 无输出。

- [ ] **Step 4: 提交门禁结论供所有者确认**

  只有 `pass` 才继续；`blocked` 必须说明缺失能力、维护成本和“保持阶段三”的回退，不得提出 OpenClaw 替代路线。

**当前问题**

公开协议说明证明存在直接 HTTP 接口，但尚未用本机和项目所有者账号验证扫码条款、授权结果、本人私聊、稳定消息 ID、原会话回复、图片/PDF 下载、断线恢复和 Mac 重启恢复。不能把“仓库有接口”直接当成生产可行。

**最小修改**

1. 固定审阅腾讯仓库提交 `cef0bfc390393f716903e16d50408118047f87e0`，记录且只记录：
   - QR 登录返回字段和需要项目所有者确认的使用条款；
   - `getupdates`、`sendmessage`、消息 ID、发送者、`context_token`；
   - 图片/PDF CDN 引用、AES-128-ECB 解密边界；
   - 会话超时、重定向、同步游标和重连要求；
   - 许可证、维护成本和协议变更风险。
2. 本任务只做固定提交的源码/README 证据核对；本地假服务属于 Task 4.4，真实扫码属于 Task 4.4 和 Task 4.10，不在本任务提前进行。
3. 仅当公开协议证据明确覆盖以下条件时通过“可以开始离线实现”的门禁：
   - 不安装 OpenClaw 或其插件；
   - 本人一对一文字、图片和 PDF 可被动接收；
   - 回复必须带原消息 `context_token`，且能回到原微信会话；
   - 有稳定 `message_id` 可去重；
   - 账号/会话可恢复，微信可独立停用；
   - 群聊、主动群发和其他用户可以确定性拒绝。

**测试**

- 文档检查不得含 token、二维码值、用户 ID、消息 ID、上下文令牌或 CDN 参数。
- 对上游固定提交逐项核对 QR、长轮询、消息唯一 ID、本人标识、原会话回复和媒体字段；每项必须有精确上游文件/行或 README 章节。
- Task 4.4 的隔离假服务和 Task 4.10 的真实验收仍是独立门禁；Task 4.1 通过不得写成“微信已经可用”。

**回滚**

- 未通过前没有生产部署；删除隔离测试状态即可。
- 若任一必要能力只能依赖 OpenClaw、非本人账号、群聊、主动推送或未知第三方服务，阶段四停止在阶段三，不自行换路线。

**明确不做**

- 不安装 OpenClaw、腾讯插件或第三方微信 SDK。
- 不在此任务实现业务代码，不扫码即视为授权，不接受来源不明的逆向协议替代腾讯公开接口。

## Task 4.2：先用失败测试固定双入口内部契约

**精确文件**

- 修改：`src/core/incoming-message.mjs`
- 修改：`src/core/security-gate.mjs`
- 修改：`test/incoming-message.test.mjs`
- 修改：`test/core-routing.test.mjs`

**Interfaces**

- Consumes: 现有 `createReplyTarget({source,sourceMessageId,conversationId})`、`createFeishuIncomingMessage(event)` 和 `checkSecurity(event,binding)`。
- Produces: `createWechatIncomingMessage(event): IncomingMessage`；`createReplyTarget()` 对微信额外接受 `contextToken`；`checkIncomingSecurity(message,bindings)` 返回现有 `{ok:true}` 或 `{ok:false,reason,notify:false}`。

- [ ] **Step 1: 写微信内部契约失败测试**

  测试输入使用假值并断言精确输出：

  ```js
  const message=createWechatIncomingMessage({
    messageId:"1001",userId:"wx-owner",conversationId:"wx-owner",
    createTimeMs:1784851200000,type:"text",text:"今天完成评审",
    contextToken:"test-context"
  });
  assert.deepEqual(message,{
    source:"wechat",sourceMessageId:"1001",userId:"wx-owner",
    conversationId:"wx-owner",receivedAt:"2026-07-24T00:00:00.000Z",
    text:"今天完成评审",attachments:[],
    replyTarget:{source:"wechat",sourceMessageId:"1001",conversationId:"wx-owner",contextToken:"test-context"}
  });
  ```

- [ ] **Step 2: 运行测试并确认 RED**

  Run:

  ```bash
  node --test test/incoming-message.test.mjs test/core-routing.test.mjs
  ```

  Expected: FAIL，原因是 `createWechatIncomingMessage` / `checkIncomingSecurity` 尚不存在。

- [ ] **Step 3: 实现最小双入口类型与安全门**

  实现并只导出以下签名：

  ```js
  export function createReplyTarget({source,sourceMessageId,conversationId,contextToken}) {}
  export function createFeishuIncomingMessage(event) {}
  export function createWechatIncomingMessage(event) {}
  export function checkSecurity(event,binding) {} // 保留飞书原始入口
  export function checkIncomingSecurity(message,bindings) {}
  ```

  `createWechatIncomingMessage` 只接受 `text | image | file` 的已清洗事件；`checkIncomingSecurity` 只检查 `bindings[message.source]` 的 owner/conversation，不读取模型、Keychain 或业务状态。

- [ ] **Step 4: 运行测试并确认 GREEN**

  Run 同 Step 2。Expected: PASS，且全部既有飞书断言不变。

- [ ] **Step 5: 提交独立契约变更**

  ```bash
  git add src/core/incoming-message.mjs src/core/security-gate.mjs test/incoming-message.test.mjs test/core-routing.test.mjs
  git commit -m "refactor: add bounded wechat message contract"
  ```

**当前问题**

内部类型名义上允许 `wechat`，但无法构造微信消息；安全门仍只接受飞书 `senderId/chatId` 形状；微信回复需要的 `context_token` 没有受控位置。

**最小修改**

1. 先写失败测试，固定微信转换后的唯一业务输入：

   ```js
   {
     source: "wechat",
     sourceMessageId,
     userId,
     conversationId,
     receivedAt,
     text,
     attachments,
     replyTarget: {
       source: "wechat",
       sourceMessageId,
       conversationId,
       contextToken
     }
   }
   ```

2. `contextToken` 只允许出现在微信 `ReplyTarget`，不得复制到消息正文、附件、Router 输入或 Skill 输入；飞书 `ReplyTarget` 形状保持不变。
3. 将安全门收敛为对已转换消息做来源绑定检查：
   - 飞书仍校验现有绑定用户和 P2P 会话；
   - 微信只允许已扫码绑定的本人、用户消息、无群 ID的一对一消息；
   - 未启用来源、空绑定、其他用户、群消息和畸形上下文静默拒绝。
4. 保留飞书原始事件在入口转换前的现有检查，不降低当前边界。

**测试**

```bash
node --test test/incoming-message.test.mjs test/core-routing.test.mjs
```

RED 必须证明当前代码无法构造/校验微信消息；GREEN 后断言业务消息不含任何微信原始字段、CDN 参数或钥匙串值。飞书现有用例全部不变。

**回滚**

- 恢复上述四个文件即可；没有状态或资料迁移。

**明确不做**

- 不建立通用消息总线、任意渠道注册表或可扩展事件平台。
- 不让 Router、Skill 或写入器读取 `contextToken`。

## Task 4.3：让同一 Dispatcher 处理两个已验证入口

**精确文件**

- 修改：`src/core/dispatcher.mjs`
- 修改：`src/state-store.mjs`
- 修改：`src/core/model-command.mjs`
- 修改：`test/dispatcher.test.mjs`
- 修改：`test/state-store.test.mjs`
- 修改：`test/model-command.test.mjs`

**Interfaces**

- Consumes: Task 4.2 的 `IncomingMessage`、`ReplyTarget`、`checkIncomingSecurity()`。
- Produces: `Dispatcher.handleIncomingMessage(message)`；`outcomeKey(message)`；新 outcome 可选 `replyTarget`；历史飞书 outcome 兼容恢复。

- [ ] **Step 1: 写共享队列、来源去重和恢复回复失败测试**

  使用同一 harness 提交 `feishu:m1`、`wechat:m1`、重复 `wechat:m1`，断言前两条各处理一次、第三条为 duplicate；模拟保存后发送失败并重新打开 `StateStore`，断言恢复目标仍为微信。

- [ ] **Step 2: 运行测试并确认 RED**

  ```bash
  node --test test/dispatcher.test.mjs test/state-store.test.mjs test/model-command.test.mjs
  ```

  Expected: FAIL，因为当前 dispatcher 只接受飞书 raw event 且恢复时固定构造飞书目标。

- [ ] **Step 3: 实现来源感知但非通用化的核心**

  固定签名和键规则：

  ```js
  handleIncomingMessage(message) {
    const next=this.queue.then(()=>this.processIncomingMessage(message));
    this.queue=next.catch(()=>{});
    return next;
  }

  function outcomeKey(message) {
    return message.source==="feishu"
      ? message.sourceMessageId
      : `wechat:${message.sourceMessageId}`;
  }
  ```

  `handleRawEvent(raw)` 继续完成飞书原始标准化/畸形处理后调用 `handleIncomingMessage`；`saveOutcome` 保存 `replyTarget`，`resumeReplies` 优先使用保存值，旧记录缺失时使用飞书兼容目标。

- [ ] **Step 4: 运行测试并确认 GREEN**

  Run 同 Step 2。Expected: PASS；自然语言模型切换仍为 null，三个精确命令两入口相同。

- [ ] **Step 5: 提交核心收敛**

  ```bash
  git add src/core/dispatcher.mjs src/state-store.mjs src/core/model-command.mjs test/dispatcher.test.mjs test/state-store.test.mjs test/model-command.test.mjs
  git commit -m "refactor: share dispatcher across chat entries"
  ```

**当前问题**

`Dispatcher` 内部直接标准化飞书原始事件、按飞书消息 ID 去重，并在重启后把全部未回复结果重建为飞书目标。微信接入若绕开它就会复制业务核心，若直接调用则无法正确去重和原入口回复。

**最小修改**

1. 先写失败测试，再增加 `handleIncomingMessage(message)`，使两个入口在完成各自原始事件校验后进入同一串行队列。
2. 保留 `handleRawEvent(raw)` 作为飞书兼容入口，它只负责现有飞书标准化、飞书安全检查和畸形飞书回执，然后转交 `handleIncomingMessage`。
3. 去重键固定为：
   - 飞书继续使用原 `sourceMessageId`，避免历史 outcome 在部署后失效；
   - 微信使用 `wechat:<sourceMessageId>`，避免跨入口碰撞。
4. 新 outcome 在受保护状态中保存最小 `replyTarget`；历史 outcome 没有该字段时继续按现有飞书绑定恢复。
5. `resumeReplies()` 按 outcome 保存的来源回复；任何回复上下文都不写普通日志。
6. 现有三个 `/llw-model` 精确命令改为“聊天入口命令”命名，但匹配文本、持久化行为、任务模型快照和失败不自动切换规则完全不变。

**测试**

```bash
node --test test/dispatcher.test.mjs test/state-store.test.mjs test/model-command.test.mjs
```

必须覆盖：

- 飞书和微信同走一个队列、同一 Router 和同一 capability；
- 两入口相同裸消息 ID 不互相去重；
- 同一微信消息重复投递只处理一次；
- 保存 outcome 后、回复前崩溃，重启仍回复原微信；
- 三个精确命令在微信生效，自然语言切换仍不生效；
- 微信安全失败发生在模型命令、Router、Keychain、AI 和写入之前；
- 历史飞书 outcome 仍可恢复。

**回滚**

- 回到阶段三代码；状态仍保持 version 4，新增 outcome 字段为向后兼容可选字段，不要求迁移或改写 Obsidian。
- 若测试证明无法兼容历史 outcome，停止，不上线。

**明确不做**

- 不创建第二个 Dispatcher、Router、模型状态或 capability registry。
- 不自动选择模型、不因入口不同改变模型。

## Task 4.4：实现直接 HTTPS 鉴权和受保护微信绑定

**精确文件**

- 新建：`src/adapters/wechat-api.mjs`
- 新建：`src/wechat-bind.mjs`
- 新建：`test/wechat-api.test.mjs`
- 新建：`test/wechat-bind.test.mjs`
- 修改：`src/config.mjs`
- 修改：`test/config.test.mjs`

**Interfaces**

- Consumes: Node `fetch`、`node:crypto`、`execFile("/usr/bin/security", ...)`；Task 4.1 固定的腾讯协议提交。
- Produces: `wechatApi` 的 QR/getUpdates/send/download 方法、`decryptWechatMedia()`；`runWechatBind()`；version 4 配置的四个微信字段；权限 `0600` 的 channel state。

- [ ] **Step 1: 写 API、配置和绑定失败测试**

  测试固定以下公开接口，不使用真实网络/钥匙串：

  ```js
  createWechatApi({fetchImpl,baseUrl,token,uIn})
  runWechatBind({configFile,fetchImpl,keychainWrite,openQr,stateWrite})
  ```

  断言旧 version 4 配置加载后得到：

  ```js
  {
    wechatEnabled:false,
    wechatStateFile:"/Users/test/wechat-state.json",
    wechatKeychainService:"com.llw.wechat-ilink",
    wechatKeychainAccount:"llw-assistant"
  }
  ```

- [ ] **Step 2: 运行测试并确认 RED**

  ```bash
  node --test test/wechat-api.test.mjs test/wechat-bind.test.mjs test/config.test.mjs
  ```

  Expected: FAIL，原因是新模块/字段不存在。

- [ ] **Step 3: 实现直接 HTTPS 和手工绑定**

  只实现这些导出：

  ```js
  export function createWechatApi({fetchImpl=fetch,baseUrl,token,uIn}) {
    return {getQrCode,pollQrStatus,getUpdates,sendMessage,downloadEncryptedMedia};
  }
  export function decryptWechatMedia(ciphertext,aesKey) {}
  export async function runWechatBind({
    configFile,fetchImpl=fetch,keychainWrite=writeWechatToken,
    openQr=openQrUrl,stateWrite=writeWechatState
  }={}) {}
  ```

  HTTP 响应先检查状态、`content-type` 和最大 JSON/媒体字节；token 仅作为 `Authorization: Bearer ...` 请求头值存在于内存。`runWechatBind` 只在确认状态后写 Keychain，再原子写无 token 的 channel state。

- [ ] **Step 4: 运行测试并确认 GREEN**

  Run 同 Step 2。Expected: PASS；假 token 不出现在 state、stdout、stderr 和错误字符串。

- [ ] **Step 5: 取得所有者批准后做一次真实绑定门禁**

  只运行：

  ```bash
  /usr/local/bin/node src/wechat-bind.mjs "/Users/ccrt/Library/Application Support/LLW Assistant/state/feishu-daily-work/config.json"
  ```

  Expected stdout 仅含 `bind_ok=true` 与 `p2p_owner_ok=true`；本步骤不启用 `wechatEnabled`。

- [ ] **Step 6: 提交鉴权边界**

  ```bash
  git add src/adapters/wechat-api.mjs src/wechat-bind.mjs src/config.mjs test/wechat-api.test.mjs test/wechat-bind.test.mjs test/config.test.mjs
  git commit -m "feat: add protected direct wechat binding"
  ```

**当前问题**

生产没有微信配置、授权或令牌存储；服务不能依赖 OpenClaw 代管登录。真实扫码会产生高敏感 bot token 和平台标识，必须在联网前固定保存边界。

**最小修改**

1. `wechat-api.mjs` 只实现阶段四实际使用的五个网络动作和一个本地解密函数：
   - 获取 QR；
   - 轮询 QR 状态；
   - `getupdates`；
   - `sendmessage`；
   - 下载 CDN 密文；
   - 用 Node `crypto` 解密媒体。
2. 只允许 HTTPS；初始主机固定为腾讯公开的 `ilinkai.weixin.qq.com`。QR确认返回的新主机必须是合法 HTTPS 主机、无用户信息、无本地/保留 IP，并写入受保护状态后才可使用。
3. 配置 version 仍为 4，只新增并严格校验：
   - `wechatEnabled`，旧配置缺失时归一化为 `false`；
   - `wechatStateFile`；
   - `wechatKeychainService`；
   - `wechatKeychainAccount`。
4. `wechat-bind.mjs` 只能由项目所有者手工运行：
   - 本地打开 QR 图片 URL；
   - 等待本人扫码和确认；
   - 用 `/usr/bin/security add-generic-password -U` 写入 token；
   - 以 `0600` 原子写入 `wechatStateFile`，只含 version、API base URL、bot ID、绑定 owner user ID 和空同步游标；
   - stdout 只输出 `bind_ok=true` 等布尔状态，不输出任何值。
5. 服务启动不自动扫码、不自动改配置；`wechatEnabled=false` 时不读取微信状态或钥匙串。

**测试**

```bash
node --test test/wechat-api.test.mjs test/wechat-bind.test.mjs test/config.test.mjs
```

假 HTTPS 服务覆盖成功、超时、非 JSON、过大响应、错误状态、重定向恶意主机、QR过期、token 缺失和原子写失败。注入假的 `security`/浏览器打开函数，断言参数中 token 不进入错误、stdout 或状态文件。

真实扫码前必须再次取得项目所有者批准；真实扫码只验证绑定结果和权限，不启动业务处理。

**回滚**

- 保持 `wechatEnabled=false`；删除或隔离 `wechatStateFile`。
- 钥匙串项不随代码回滚自动删除，避免破坏性操作；只有项目所有者明确要求撤销时才精确删除该 service/account。
- 配置旧版本可由缺省归一化继续启动飞书。

**明确不做**

- 不安装 npm 包、不保存 QR、token 或使用条款页面内容。
- 不把微信 token 写入 plist、环境变量、配置、工作区或备份。
- 不自动授权、多账号或配对其他用户。

## Task 4.5：实现本人一对一文字、原入口回复和重连

**精确文件**

- 新建：`src/adapters/wechat-runtime.mjs`
- 新建：`src/adapters/wechat-reply.mjs`
- 新建：`src/adapters/channel-messenger.mjs`
- 新建：`test/wechat-runtime.test.mjs`
- 新建：`test/wechat-reply.test.mjs`
- 新建：`test/channel-messenger.test.mjs`
- 修改：`src/core/incoming-message.mjs`

**Interfaces**

- Consumes: Task 4.4 的 `createWechatApi()` 和受保护 channel state；Task 4.2 的 `createWechatIncomingMessage()`。
- Produces: `startWechatListener({api,state,binding,onMessage,onError})`；`createWechatMessenger({api,boundUserId})`；`createChannelMessenger({feishu,wechat})`。

- [ ] **Step 1: 写 runtime、回复和二分 messenger 失败测试**

  假 `getUpdates` 依次返回本人文字、其他用户、群消息、机器人消息、未完成消息和重复消息；断言只把本人完成态文字交给 `onMessage`。回复测试断言 `to_user_id` 与绑定本人一致并原样带回测试 `contextToken`。

- [ ] **Step 2: 运行测试并确认 RED**

  ```bash
  node --test test/wechat-runtime.test.mjs test/wechat-reply.test.mjs test/channel-messenger.test.mjs test/incoming-message.test.mjs
  ```

  Expected: FAIL，因为三个适配器不存在。

- [ ] **Step 3: 实现最小入口生命周期**

  固定导出：

  ```js
  export async function startWechatListener({
    api,state,binding,onMessage,onError=()=>{},retryDelayMs=1000
  }) {
    return {stop,done};
  }

  export function createWechatMessenger({api,boundUserId}) {
    return {send:async ({replyTarget,text,idempotencyKey})=>{}};
  }

  export function createChannelMessenger({feishu,wechat}) {
    return {send:message=>{
      if (message.replyTarget.source==="feishu") return feishu.send(message);
      if (message.replyTarget.source==="wechat") return wechat.send(message);
      throw new Error("invalid_reply_target");
    }};
  }
  ```

  `startWechatListener` 的循环必须在内部捕获网络错误并调用脱敏 `onError`；鉴权失效令 `done` 正常结束微信部分，不 throw 到飞书主等待链。

- [ ] **Step 4: 运行测试并确认 GREEN**

  Run 同 Step 2。Expected: PASS；群/他人/机器人/视频/语音均 0 Router、0回复。

- [ ] **Step 5: 提交文字入口**

  ```bash
  git add src/adapters/wechat-runtime.mjs src/adapters/wechat-reply.mjs src/adapters/channel-messenger.mjs src/core/incoming-message.mjs test/wechat-runtime.test.mjs test/wechat-reply.test.mjs test/channel-messenger.test.mjs
  git commit -m "feat: add bounded wechat text entry"
  ```

**当前问题**

没有长轮询、微信原始消息转换、回复或断线恢复。直接把原始 `WeixinMessage` 交给核心会泄露平台字段并绕过入口边界。

**最小修改**

1. `wechat-runtime.mjs` 从受保护状态读取绑定和同步游标，从钥匙串读取 token，运行单一 `getupdates` 长轮询。
2. 只接收：
   - `message_type=USER`；
   - `message_state=FINISH`；
   - 无 `group_id`；
   - `from_user_id` 精确等于绑定 owner；
   - 当前阶段支持的单个 text/image/file item。
3. 文本事件只转换为 Task 4.2 的微信 `IncomingMessage`；不保留原始事件。
4. 每次成功响应后以 `0600` 原子保存最新同步游标；会话超时停止微信入口并安全报错，不清空飞书状态、不触发重新扫码。
5. 网络瞬时失败在微信 runtime 内有限退避重试；错误通过现有 `safeLog` 只记录 stage、稳定错误码和不可逆 correlation，不让 rejection 终止飞书 listener。
6. `wechat-reply.mjs` 只向 `replyTarget.conversationId` 发送文字，并强制回传该消息的 `contextToken`。
7. `channel-messenger.mjs` 只在 `feishu` 和 `wechat` 两个实现间按已验证 `ReplyTarget.source` 选择；不建设任意渠道注册系统。

**测试**

```bash
node --test test/wechat-runtime.test.mjs test/wechat-reply.test.mjs test/channel-messenger.test.mjs test/incoming-message.test.mjs
```

必须覆盖本人文字、其他用户、群消息、机器人消息、未完成消息、视频/语音、多 item、重复消息、长轮询超时、鉴权过期、网络失败、游标原子恢复、原入口回复和 `contextToken` 缺失拒绝。断言任何微信错误都不会停止或调用飞书 listener。

**回滚**

- `wechatEnabled=false` 后不启动 runtime；飞书 messenger 继续独立工作。
- 删除新增适配器代码并恢复 `incoming-message.mjs` 即可；业务状态和 Obsidian 不迁移。

**明确不做**

- 不主动发消息、不发媒体、不处理群聊、语音、视频、引用消息或多段消息。
- 不把微信网络失败升级为主进程退出条件。

## Task 4.6：把微信图片/PDF接入现有 invoice

**精确文件**

- 新建：`src/adapters/wechat-resource-downloader.mjs`
- 新建：`test/wechat-resource-downloader.test.mjs`
- 修改：`src/capabilities/invoice/capability.mjs`
- 修改：`src/capabilities/invoice/resource-marker.mjs`
- 修改：`test/invoice-capability.test.mjs`
- 修改：`test/invoice-resource-marker.test.mjs`
- 修改：`src/main.mjs`

**Interfaces**

- Consumes: Task 4.5 runtime 的当前消息资源表；Task 4.4 的 `downloadEncryptedMedia()` / `decryptWechatMedia()`；现有 `createInvoiceCapability({download,...})`。
- Produces: `downloadWechatResource({resourceId,tempRoot,maxFileBytes,timeoutMs}) -> {tempDir,file}`；invoice 下载调用新增 `source`。

- [ ] **Step 1: 写加密媒体和共用 invoice 失败测试**

  用固定 16-byte 测试 key 加密一张最小 PNG 和一个最小 PDF；假 HTTPS 返回密文。断言 downloader 解密为一个普通文件，capability 继续调用现有 inspector/writer，`finally` 删除 job。

- [ ] **Step 2: 运行测试并确认 RED**

  ```bash
  node --test test/wechat-resource-downloader.test.mjs test/invoice-resource-marker.test.mjs test/invoice-capability.test.mjs
  ```

  Expected: FAIL，因为微信 downloader 和来源分支不存在。

- [ ] **Step 3: 实现微信媒体下载而不复制业务逻辑**

  固定导出和调用形状：

  ```js
  export async function downloadWechatResource({
    api,resourceId,resources,tempRoot,maxFileBytes,timeoutMs
  }) {
    return {tempDir,file};
  }

  downloaded=await download({
    ...resource,
    source:event.source,
    messageId:event.sourceMessageId
  });
  ```

  `main.mjs` 的下载函数仅作二分：

  ```js
  const downloadInvoiceResource=resource =>
    resource.source==="wechat"
      ? downloadWechatResource({...wechatDownloadConfig,...resource})
      : downloadLarkResource({...larkDownloadConfig,...resource});
  ```

  不允许第三种 source；解密输出仍交现有 `inspectInvoiceFile`、PDF preparer、Codex visual、validator 和 archive writer。

- [ ] **Step 4: 运行测试并确认 GREEN**

  Run 同 Step 2。Expected: PASS；成功、失败、超时后 temp job 均不存在。

- [ ] **Step 5: 提交媒体入口**

  ```bash
  git add src/adapters/wechat-resource-downloader.mjs src/capabilities/invoice/capability.mjs src/capabilities/invoice/resource-marker.mjs src/main.mjs test/wechat-resource-downloader.test.mjs test/invoice-capability.test.mjs test/invoice-resource-marker.test.mjs
  git commit -m "feat: route wechat media through existing invoice"
  ```

**当前问题**

现有发票 capability 只能根据飞书 `img_`/`file_` 资源键调用 lark-cli 下载。微信媒体是带 CDN 参数和 AES key 的加密引用；若另建微信发票流程会复制归档器和去重规则。

**最小修改**

1. 微信 runtime 为当前消息的单个附件建立仅存在于内存的受控资源引用；`IncomingMessage` 只携带不透明 `sourceAttachmentId`、类型、显示名和扩展名。
2. `wechat-resource-downloader.mjs` 根据该内存引用：
   - 在现有 `invoice.tempRoot` 下创建权限 `0700` 的 `job-*`；
   - 下载 HTTPS CDN 密文；
   - 用 Node `crypto` 做 AES-128-ECB 解密；
   - 只产生一个普通非符号链接文件；
   - 在进入现有 inspector 前执行 20 MiB上限；
   - 成功、失败和超时都由现有 capability `finally` 清理。
3. `invoice/capability.mjs` 只把 `source` 传给下载函数；后续 inspector、PDF准备、Codex视觉任务、validator、哈希、事务、归档和回执完全复用。
4. `main.mjs` 用一个显式二分支选择下载器：
   - `feishu` → 现有 `downloadLarkResource`；
   - `wechat` → 新 `downloadWechatResource`。
5. 微信只允许 image 或扩展名为 `.pdf` 的 file；语音、视频、其他文件、多附件和畸形 AES/CDN 元数据在 AI、Keychain 业务读取和写入前拒绝。
6. DeepSeek 模式下仍由现有固定边界在下载和视觉调用前明确拒绝发票；不自动切回 Codex。

**测试**

```bash
node --test test/wechat-resource-downloader.test.mjs test/invoice-resource-marker.test.mjs test/invoice-capability.test.mjs
```

覆盖图片/PDF成功、非 PDF、超限、错误 AES key、解密失败、符号链接、多输出、超时、下载失败、清理失败和同一发票跨入口重复提交。重复提交必须继续由现有 source hash/事务规则得到 `existing` 或既定安全结果，不新增微信去重数据库。

**回滚**

- 关闭微信后，飞书下载器、invoice writer 和历史事务保持不变。
- 回滚不得删除任何已经 `published` 且哈希验证通过的发票。

**明确不做**

- 不复制 invoice capability、视觉 Prompt、validator、archive writer 或交易状态机。
- 不扫描图片/PDF中的 V3.2 敏感内容；继续执行现有文件安全和发票业务校验。

## Task 4.7：用一个可关闭开关完成生产组合

**精确文件**

- 修改：`src/main.mjs`
- 修改：`src/config.mjs`
- 修改：`test/main-composition.test.mjs`
- 修改：`test/config.test.mjs`
- 保持不变：`deploy/com.llw.feishu-daily-work.plist`

**Interfaces**

- Consumes: Tasks 4.3–4.6 的共享 dispatcher、微信 runtime、二分 messenger 和 downloader。
- Produces: `main.mjs` 的单进程双入口组合；`wechatEnabled=false` 的零读取/零网络保证。

- [ ] **Step 1: 写组合和故障隔离失败测试**

  在 `test/main-composition.test.mjs` 注入微信 state/keychain/fetch spies；分别以开关 false、初始化失败、轮询失败运行，断言 false 时调用数全为 0，失败时飞书 `onEvent` 仍可调用同一 dispatcher。

- [ ] **Step 2: 运行测试并确认 RED**

  ```bash
  node --test test/main-composition.test.mjs test/config.test.mjs test/dispatcher.test.mjs test/lark-runtime.test.mjs
  ```

  Expected: FAIL，因为 `main.mjs` 尚未组合微信。

- [ ] **Step 3: 实现默认关闭的单进程组合**

  组合顺序固定为：

  ```js
  const larkListener=await startLarkListener(feishuOptions);
  let wechatListener=null;
  if (config.wechatEnabled) {
    wechatListener=await startWechatListener(wechatOptions).catch(error=>{
      process.stderr.write(`${safeLog({stage:"listener",code:"wechat_start_failed"})}\n`);
      return null;
    });
    wechatListener?.done.catch(()=>{
      process.stderr.write(`${safeLog({stage:"listener",code:"wechat_listener_stopped"})}\n`);
    });
  }
  ```

  主进程继续等待 `larkListener.done`；`wechatListener.done` 只挂脱敏错误处理，不成为主退出条件。shutdown 先停止微信（若存在），再按现有方式停止飞书。

- [ ] **Step 4: 运行测试并确认 GREEN**

  Run 同 Step 2。Expected: PASS；`git diff -- deploy/com.llw.feishu-daily-work.plist` 无输出。

- [ ] **Step 5: 提交生产组合**

  ```bash
  git add src/main.mjs src/config.mjs test/main-composition.test.mjs test/config.test.mjs
  git commit -m "feat: compose optional wechat entry"
  ```

**当前问题**

微信代码即使离线正确，也必须证明关闭时零影响、开启失败时飞书继续、同一 LaunchAgent 在 Mac 启动后能恢复两个入口。

**最小修改**

1. `main.mjs` 始终先建立并启动现有飞书链路。
2. 只有 `wechatEnabled=true` 才读取微信状态/钥匙串并启动微信 runtime；微信启动或运行错误只关闭/重试微信部分，不能 reject 当前飞书主等待链。
3. 两入口向同一个 `Dispatcher` 实例提交，使用同一个 `StateStore`、`ModelMode`、capability registry 和 intent router。
4. shutdown 分别停止两个入口；微信停止失败不得阻止飞书 listener 正常停止。
5. 保留当前 LaunchAgent label、plist、Node 主入口、工作目录和日志路径；不新增 LaunchAgent、守护进程或 sidecar。

**测试**

```bash
node --test test/main-composition.test.mjs test/config.test.mjs test/dispatcher.test.mjs test/lark-runtime.test.mjs
```

必须断言：

- `wechatEnabled=false` 时微信状态读取、钥匙串读取、fetch 和媒体下载调用均为 0；
- 微信初始化失败、长轮询失败和回复失败时飞书 listener 仍接收并处理；
- 两入口共享同一队列和业务实例；
- 现有 plist 文本和飞书启动参数未变；
- 模型状态缺失/损坏仍安全回到 Codex。

**回滚**

- 固定第一步为 `wechatEnabled=false`，不依赖删除代码、状态或钥匙串。
- 若关闭微信后飞书不能单独健康运行，阶段四不得部署。

**明确不做**

- 不新增第二个业务进程、第二个 LaunchAgent、IPC、消息总线或健康平台。
- 不修改现有飞书权限、profile、绑定或 lark-cli。

## Task 4.8：离线全回归、固定失败测试和测试 Vault

**精确文件**

- 修改：本计划中的执行状态与证据表。
- 不修改正式 Vault 业务资料。

**Interfaces**

- Consumes: Tasks 4.2–4.7 全部离线实现、现有 Skills和测试工具。
- Produces: 0 fail 的完整回归、双入口等价证据、固定失败证据和空临时目录。

- [ ] **Step 1: 运行完整回归并记录精确计数**

  ```bash
  /usr/local/bin/npm test
  ```

  Expected: 全部 PASS、0 FAIL；记录总数，不沿用阶段三 240/240 作为新结果。

- [ ] **Step 2: 运行双入口等价集成测试**

  ```bash
  node --test test/dispatcher.test.mjs test/service.test.mjs test/invoice-capability.test.mjs test/ai-input-guard.test.mjs
  ```

  Expected: 同一脱敏文字/附件输入除 `ReplyTarget` 外得到相同 Router input、capability、draft 和测试 Vault业务结果。

- [ ] **Step 3: 在 `/private/tmp` 执行测试 Vault 场景**

  测试配置必须使用：

  ```json
  {
    "wechatEnabled": true,
    "deepseekEnabled": false
  }
  ```

  微信协议和 Keychain 均注入假实现；执行文字、图片、PDF、重复、下载失败、守卫命中和微信停止场景。Expected: 正式 Vault文件计数/哈希不变。

- [ ] **Step 4: 扫描泄露和临时残留**

  ```bash
  rg -n 'Bearer |bot_token|context_token|ilink_user_id|encrypt_query_param|aes_key' src test docs
  find /private/tmp -maxdepth 1 -type d -name 'llw-wechat-*' -print
  ```

  Expected: 第一条只命中协议字段名/假 fixture，不命中实际值；第二条没有未说明的 job。

- [ ] **Step 5: 提交测试证据更新**

  ```bash
  git add docs/superpowers/plans/2026-07-24-v32-phase4-wechat-second-entry.md
  git commit -m "test: record phase four offline gates"
  ```

**当前问题**

入口测试通过不能替代业务等价、安全门、重复归档和飞书独立性证据。

**最小修改**

1. 在隔离 worktree 运行完整测试：

   ```bash
   /usr/local/bin/npm test
   ```

2. 运行现有三个 Skill 合同测试、Router/daily-work 评测和 invoice 相关测试；正式 Skill 文件不改动。
3. 在 `/private/tmp` 建立测试配置、测试状态和测试 Vault，使用假微信协议服务依次验证：
   - 微信文字 → 同一 `daily-work`；
   - 微信图片/PDF → 同一 `invoice`；
   - 三个精确模型命令；
   - 同消息重放；
   - 下载失败与清理；
   - 微信停止后飞书假 listener 继续；
   - 明确秘密与支付凭证守卫仍在模型/Keychain/写入之前；
   - DeepSeek 发票固定拒绝。
4. 对同一脱敏任务分别构造飞书和微信 `IncomingMessage`，断言 Router输入、capability 选择、业务 draft 和测试 Vault结果等价；仅 ReplyTarget 不同。
5. 若微信接入改变语义输入形状，再经项目所有者批准运行正式 22 条 DeepSeek 评测；否则沿用阶段三 22/22，不为了“看起来完整”产生无关 API调用。

**测试**

- 全部离线测试必须 0 fail。
- 测试 Vault 中不得出现平台标识、context token、CDN 参数或绝对路径。
- 临时目录最终为空，测试状态/配置权限为 `0600`。

**回滚**

- 删除 `/private/tmp` 测试副本；生产未变。
- 任一测试失败即留在隔离分支，用系统化调试定位，不进入部署。

**明确不做**

- 不把单元测试等同于真实微信验收。
- 不把测试消息写入正式 Vault，不扩大真实飞书或微信权限。

## Task 4.9：建立阶段四部署前回滚点并隔离恢复

**精确文件/目录**

- 新建受保护目录：`~/Library/Application Support/LLW Assistant/backups/baselines/v3-phase-4-pre-deploy-YYYY-MM-DD/`
- 读取：当前生产组件、配置、version 4 状态、模型状态、心跳、LaunchAgent plist、三个正式 Skill。
- 不备份：Vault 资料、普通日志、DeepSeek key、微信 token、二维码或消息正文。

**Interfaces**

- Consumes: 当前生产阶段三运行件和 Tasks 4.1–4.8 已验证源码。
- Produces: 权限 `0700/0600` 的阶段四部署前备份、SHA-256 manifest 和 `/private/tmp` 恢复证据。

- [ ] **Step 1: 只读解析精确备份源**

  记录生产 Git提交、配置/状态版本、plist 路径、三个 Skill提交、PID/心跳和模型；禁止输出配置内容。

- [ ] **Step 2: 创建受保护备份和 manifest**

  目录名固定为执行日：

  ```text
  ~/Library/Application Support/LLW Assistant/backups/baselines/v3-phase-4-pre-deploy-YYYY-MM-DD/
  ```

  manifest 每行只含 `relative_path mode bytes sha256`；不含原始绝对路径、标识或秘密。

- [ ] **Step 3: 恢复到全新隔离目录**

  使用 `mktemp -d /private/tmp/llw-v32-phase4-restore.XXXXXX`，恢复组件和 Skills bundle，复制脱敏/关闭网络的配置副本。

- [ ] **Step 4: 验证恢复副本**

  ```bash
  /usr/local/bin/npm test
  git fsck --full
  ```

  Expected: 0 FAIL、Git对象完整、manifest 哈希全匹配；生产 PID/心跳/配置哈希不变。

- [ ] **Step 5: 更新事实文档但不提交备份**

  只向 `SYSTEM_MAP.md` 和本计划写入备份目录名、布尔结果和测试计数。

**当前问题**

阶段三回滚点早于阶段四配置和代码；部署前必须能恢复当前飞书 + Codex生产事实。

**最小修改**

1. 在任何生产替换前备份当前运行件，目录 `0700`、工件 `0600`。
2. manifest 只写相对路径、类型、权限、字节数、SHA-256、Git提交和脱敏状态版本。
3. 备份组件完整 Git bundle、当前正式 Skills Git bundle、配置/状态/plist 和启动事实。
4. 恢复到全新 `/private/tmp` 隔离目录，逐项校验哈希、JSON版本、Git提交、Skill合同和完整组件测试。
5. 固定回滚目标：

   ```text
   wechatEnabled = false
   deepseekEnabled = false
   model_mode = codex
   飞书现有服务继续运行
   ```

**测试**

- 恢复副本完整回归 0 fail。
- 恢复配置不读取任何真实钥匙串，不访问网络或正式 Vault。
- 生产 PID、心跳、配置哈希和模型状态在演练前后不变。

**回滚**

- 本任务本身不停止生产；失败时删除不完整备份目录并重新建立，不继续部署。

**明确不做**

- 不把钥匙串导出到文件，不复制用户资料，不把备份提交 Git。
- 不用旧阶段三备份代替本次部署前快照。

## Task 4.10：分两道批准部署并完成真实双入口验收

**精确文件/运行件**

- 生产组件：`~/Library/Application Support/LLW Assistant/components/feishu-daily-work/`
- 生产配置/状态：`~/Library/Application Support/LLW Assistant/state/feishu-daily-work/`
- 现有 LaunchAgent：`~/Library/LaunchAgents/com.llw.feishu-daily-work.plist`
- 正式 Vault 只在项目所有者批准的有界业务验收中写入。

**Interfaces**

- Consumes: Task 4.9 可恢复快照；Tasks 4.2–4.8 已验证提交。
- Produces: 先“代码部署、微信关闭”，再“所有者扫码、微信启用”的两道独立生产证据；最终模型 `codex`。

- [ ] **Step 1: 门 A 批准后部署关闭状态**

  部署前精确检查：

  ```text
  wechatEnabled=false
  effective_model=codex
  phase4_backup_verified=true
  ```

  替换代码和配置后只重启现有 `com.llw.feishu-daily-work`。

- [ ] **Step 2: 验证门 A**

  在 60 秒窗口核对一个 Node 主进程、一个 lark 子进程、heartbeat 更新、微信网络/Keychain 0调用；发送一条所有者真实需要的低风险飞书任务。

- [ ] **Step 3: 门 B 独立批准后绑定并以测试 Vault 启用**

  项目所有者手工扫码；先把同一代码指向隔离测试 Vault，完成微信文字、图片、PDF、精确命令、重复和失败场景。

- [ ] **Step 4: 正式 Vault 独立批准后做有界验收**

  只提交项目所有者真实需要的工作和发票；分别记录 `capability/status/artifact_relative_path/hash`，不记录消息正文或平台标识。

- [ ] **Step 5: 项目所有者选择窗口完成 Mac 重启验收**

  重启前确认无处理中任务；重启后核对两入口恢复、无重复 outcome、heartbeat 更新。随后发送 `/llw-model codex` 并确认当前模型。

- [ ] **Step 6: 任一失败立即执行固定回滚**

  ```text
  wechatEnabled=false
  deepseekEnabled=false
  model_mode=codex
  restore=Task 4.9 snapshot
  ```

  恢复后再次验证飞书健康和完整回归。

**当前问题**

代码部署和微信启用是两种不同风险，不能一次批准后同时完成。

**最小修改**

### 门 A：部署但保持微信关闭

1. 取得项目所有者明确批准。
2. 确认全局模型为 `codex`、`wechatEnabled=false`。
3. 用已验证提交替换生产组件；配置仅补齐关闭状态的微信字段。
4. 重启现有 LaunchAgent，60 秒内确认：
   - 一个 Node 主进程；
   - 一个直属 lark-cli 消费者；
   - heartbeat 更新；
   - 飞书低风险真实任务仍只回复/写入一次；
   - 微信钥匙串和网络调用均为 0。

### 门 B：绑定并启用微信

1. 再次取得项目所有者对扫码、钥匙串写入、生产启用和真实消息验收的明确批准。
2. 项目所有者手工扫码确认；先以测试 Vault 启用并验证，再单独批准切到正式 Vault。
3. 真实有界验收：
   - 微信 `/llw-model status` 原入口回复；
   - 微信低风险 daily-work 与同类飞书任务产生等价业务结果；
   - 微信真实图片和 PDF 分别进入现有 invoice，拒绝/归档结果符合票面；
   - 重复发票继续走现有哈希规则；
   - 切到 DeepSeek 后文字任务可用，发票明确拒绝；随后手工切回 Codex；
   - 关闭微信后飞书仍健康，再重新启用微信；
   - 项目所有者选择窗口重启 Mac，登录后确认飞书恢复、微信重新长轮询且没有重复处理。
4. 只记录 outcome 状态、能力名、产物相对路径/哈希、进程计数、心跳和脱敏错误码；不记录正文、标识或 token。

**测试**

- 部署组件再次运行完整回归。
- 微信与飞书同类任务等价；从哪个入口提交就回复哪个入口。
- 微信鉴权/网络/附件失败均不影响飞书。
- 微信不能绕过安全门、模型命令精确匹配、AI输入守卫、文件检查、validator或原子写入。
- 最终模型必须为 `codex`。

**回滚**

1. 立即把 `wechatEnabled` 设为 `false` 并重启现有 LaunchAgent。
2. 若核心回归或飞书健康失败，停止新运行件，从 Task 4.9 恢复组件、配置、状态和 plist。
3. 恢复后确认飞书 + Codex、单消费者、heartbeat、全回归和未回复 outcome。
4. 不删除已发布且哈希正确的业务产物；微信 token 保留但不读取，撤销另行取得批准。

**明确不做**

- 不在门 A 自动进入门 B。
- 不未经项目所有者选择窗口重启 Mac。
- 不用虚构消息或无业务价值内容污染正式 Vault。

## Task 4.11：阶段四门禁、事实文档和 Git 收口

**精确文件**

- 修改：`/Volumes/ZHUTONG/LLW的私人助手/LLW/.llw-system/SYSTEM_MAP.md`
- 修改：`/Volumes/ZHUTONG/LLW的私人助手/LLW/.llw-system/WECHAT_THIN_ADAPTER_FEASIBILITY.md`
- 修改：本计划的状态与证据表。
- 不创建：`.llw-system/OPERATIONS.md`（属于阶段五）。

**Interfaces**

- Consumes: Tasks 4.1–4.10 的提交、测试、生产、回滚和验收证据。
- Produces: 准确 `SYSTEM_MAP.md`、最终可行性结论、干净 Git分支和项目所有者阶段门禁。

- [ ] **Step 1: 更新事实文档**

  `SYSTEM_MAP.md` 只记录提交、测试计数、开关、运行组件计数、回滚目录和脱敏验收结果；可行性文档把结论从 `planned` 更新为 `passed | blocked`。

- [ ] **Step 2: 运行 placeholder、秘密和差异扫描**

  ```bash
  rg -n 'T[B]D|TO[D]O|implement[ ]later|fill[ ]in[ ]details|Bearer [A-Za-z0-9]|bot_token.{0,10}[A-Za-z0-9_-]{12}' docs src test
  git diff --check
  git status --short
  ```

  Expected: 无 placeholder/实际秘密、`git diff --check` 无输出、status 只含本计划列出的文件。

- [ ] **Step 3: 执行最后验证**

  ```bash
  /usr/local/bin/npm test
  ```

  Expected: 全部 PASS、0 FAIL；并只读确认 LaunchAgent、heartbeat、单 lark 消费链、微信状态和最终 Codex。

- [ ] **Step 4: 提交阶段四实现**

  ```bash
  git add \
    src/adapters/wechat-api.mjs \
    src/adapters/wechat-runtime.mjs \
    src/adapters/wechat-reply.mjs \
    src/adapters/wechat-resource-downloader.mjs \
    src/adapters/channel-messenger.mjs \
    src/wechat-bind.mjs \
    src/core/incoming-message.mjs \
    src/core/security-gate.mjs \
    src/core/dispatcher.mjs \
    src/core/model-command.mjs \
    src/state-store.mjs \
    src/config.mjs \
    src/main.mjs \
    src/capabilities/invoice/capability.mjs \
    src/capabilities/invoice/resource-marker.mjs \
    test/wechat-api.test.mjs \
    test/wechat-bind.test.mjs \
    test/wechat-runtime.test.mjs \
    test/wechat-reply.test.mjs \
    test/wechat-resource-downloader.test.mjs \
    test/channel-messenger.test.mjs \
    test/incoming-message.test.mjs \
    test/core-routing.test.mjs \
    test/dispatcher.test.mjs \
    test/model-command.test.mjs \
    test/state-store.test.mjs \
    test/config.test.mjs \
    test/main-composition.test.mjs \
    test/invoice-capability.test.mjs \
    test/invoice-resource-marker.test.mjs \
    docs/superpowers/plans/2026-07-24-v32-phase4-wechat-second-entry.md
  git commit -m "feat: complete v3.2 wechat second entry"
  ```

  `package.json` 必须保持不变，`dependencies` 必须仍不存在。

- [ ] **Step 5: 取得所有者授权后推送，不自动合并**

  ```bash
  git push -u origin agent/v32-phase4-wechat
  ```

  报告精确分支、提交、测试、生产开关和未完成审批；阶段四未通过全部门禁时保持 Draft/不合并。

**当前问题**

阶段四必须以可复核事实结束，不能只说“微信可以用了”；Git、生产运行件、配置、测试和回滚点必须一致。

**最小修改**

1. 记录但不泄密：
   - 组件分支/提交与 Skills提交；
   - 腾讯协议证据固定提交；
   - `wechatEnabled` 最终状态；
   - 完整测试数、测试 Vault、真实双入口验收；
   - 飞书/微信进程与恢复事实；
   - 阶段四回滚目录和隔离恢复结果；
   - 最终模型 `codex`。
2. `git diff --check`，扫描 token、平台标识、消息正文、绝对测试产物和未计划依赖。
3. 重新读取验证规则，运行最后一次部署组件完整测试和健康检查。
4. 仅在项目所有者授权后提交并推送；不得自动合并阶段四实现分支。

**测试**

阶段四只有在以下条件同时满足时可宣称完成：

- 微信同类任务与飞书产生等价业务结果；
- 原入口回复；
- 同消息去重、附件清理、重启恢复；
- 微信关闭/故障时飞书继续；
- 安全门和程序校验不可绕过；
- 发票仍由现有哈希和业务规则处理；
- 未安装 OpenClaw，未新增数据库/消息队列/Skill；
- 回滚到 `wechatEnabled=false + deepseekEnabled=false + codex + 飞书运行` 已验证。

**回滚**

- 任一门禁失败即不宣称阶段四完成，保持或恢复 `wechatEnabled=false`，回到 Task 4.9 快照。

**明确不做**

- 不清理历史分支或回滚点，不自动合并，不提前进入阶段五。
- 不以新增监控、治理、平台或通用框架“补齐”验收。

## 审批顺序

1. 当前批准只覆盖：合并已审核分支、编制并推送本实施计划；不覆盖阶段四实现和生产操作。
2. 实现获批后，从本计划提交创建隔离分支 `agent/v32-phase4-wechat`，不得直接在生产分支或当前 `main` 开发。
3. Task 4.4 真实 QR 获取/扫码和钥匙串写入前单独批准。
4. Task 4.4 若发现需要任何新依赖、非腾讯域名或协议边界变化，停止并单独批准。
5. Task 4.9 受保护备份和隔离恢复前确认精确目标。
6. Task 4.10 门 A、门 B、正式 Vault 验收和 Mac重启分别明确批准。
7. 每个阶段门禁有证据且项目所有者同意后，才进入下一任务或阶段五。

## 计划完成时的预期代码变化

```text
新增生产模块：5 个
  src/adapters/wechat-api.mjs
  src/adapters/wechat-runtime.mjs
  src/adapters/wechat-reply.mjs
  src/adapters/wechat-resource-downloader.mjs
  src/adapters/channel-messenger.mjs

新增手工入口：1 个
  src/wechat-bind.mjs

新增长期运行组件：0
新增 LaunchAgent：0
新增 npm 依赖：0
新增 Skill：0
新增业务数据库：0
```

任何执行中事实与以上计数不一致，都必须先更新计划并取得项目所有者批准，不能静默扩大范围。
