# LLW Personal Assistant V4.4.5 有界 AI 分析时限修正设计

**状态：** 2026-08-02 已获项目所有者批准；尚未实施或部署  
**当前系统版本：** V4.4.3  
**前置状态：** V4.4.4 安全分类热修已部署，等待同一真实任务完成验收  
**目标版本：** V4.4.5

## 1. 真实问题

项目所有者从飞书发送真实云文档并要求“阅读、总结并入库”。生产链已经完成用户身份导出、OOXML 安全检查和 Task Source 保留，说明 V4.4.4 的安全修复生效；随后 Codex 分析在程序固定的 120 秒截止时间触发 `assistant_timeout`。Outcome 已回复，Writer 和知识库写入均为零，来源仍保留在当前 Task Session。

该 DOCX 约 2.67 MB，正文约 6,673 个字符，含 14 个媒体对象。阅读原件、理解文字与图片、形成总结并生成严格的 `save_knowledge` 参数超过两分钟属于正常负载，不应被当作权限或安全失败。

120 秒不是飞书、Codex 或安全规范的硬限制，而是 `personalAssistant.aiTimeoutMs` 的历史固定值。底层 Codex invoker 已把合法上限限定为 300,000 毫秒。

## 2. 目标与非目标

目标只有一个：把正式 Personal Assistant 的单次 Codex 分析截止时间从 120 秒调整为 300 秒，让有界复杂 Office/飞书文档任务有合理完成时间。

本版本不做以下工作：

- 不取消超时上限，不引入无限等待；
- 不增加自动重试、后台队列、第二服务、Agent、Router、Writer 或新主链；
- 不改变飞书/OAuth 权限、模型、推理强度、文件大小、图片预算或来源范围；
- 不改变发票、知识旧能力、文档生成等其他独立 AI 时限；
- 不实现按文件类型、页数或媒体数量动态计算超时；
- 不提前实施 V4.5.0 的来源身份、版本关系或知识库读取能力。

## 3. 方案比较

### 方案 A：Personal Assistant 固定 300 秒（采用）

只调整现有 `personalAssistant.aiTimeoutMs`。300 秒是当前 invoker 已有的硬上界，改动最小、行为确定、便于回滚。代价是极端失败任务最多占用当前单服务五分钟，但仍然有界。

### 方案 B：取消超时（拒绝）

能避免长任务因时间退出，但模型或子进程异常时可能无限占用唯一执行链，不符合失败关闭和资源边界。

### 方案 C：动态超时（拒绝）

按文件类型、页数、图片数量或文本量选择不同时限，看似精细，但会新增策略、状态和大量边界测试；当前一个真实样本不足以证明这些规则，违反最小改动。

## 4. 详细设计

### 4.1 配置合同

- 配置 Schema 继续为 version 7；字段结构没有变化。
- `personalAssistant.aiTimeoutMs` 明确接受两个受控值：120,000 毫秒用于历史配置和回滚兼容，300,000 毫秒用于 V4.4.5 正式配置。
- 不接受任意中间值或超过 300,000 毫秒的值。
- 正式配置只修改这一字段，并通过现有原子配置写入路径保存；其他字段逐项不变。
- `capabilities.invoice.aiTimeoutMs`、`capabilities.knowledge-ingest.aiTimeoutMs` 和 `capabilities.assistant-work.aiTimeoutMs` 保持 120,000 毫秒。

### 4.2 运行合同

- `main.mjs` 继续把正式配置值传给现有 `invokePersonalAssistantCodex`。
- invoker 继续在截止时间到达时终止子进程并返回 `assistant_timeout`。
- 不自动重试，避免重复模型调用和潜在副作用。
- Task revision、Writer reservation、提交前 current/compatible 复核和 Outcome-before-reply 顺序保持不变；即使旧分析迟到也不能写入或发送陈旧结果。
- 当前真实来源继续保留。部署后由项目所有者只发送“重试”，走原入口和原 Task Session，不重新上传原件。

### 4.3 失败与回滚

以下任一项触发回滚：

- 配置除目标字段外出现差异；
- 旧 120 秒配置不再可读取，或 300 秒以上值被接受；
- 单一 LaunchAgent、Node 主进程或飞书消费者出现重复；
- 心跳不推进、Skill 加载失败或新增启动错误；
- 聚焦合同失败；
- 真实重试仍在安全检查前失败，或出现未经确认的 Writer 写入。

如果真实任务在 300 秒仍超时，保留来源和零写入事实，停止继续扩大时限；单独分析模型/文档处理耗时，不在本版本中继续增加上限。

## 5. 测试与验收

1. RED：现有代码读取 `personalAssistant.aiTimeoutMs=300000` 时失败。
2. GREEN：配置合同接受 120,000 和 300,000，只拒绝其他值；其他三个 AI 时限仍固定为 120,000。
3. invoker 合同证明 300,000 仍在既有合法上界内，超过上界失败。
4. 运行直接相关配置、invoker、main composition、Task Session、Writer/Outcome 和 V4.4.4 飞书云文档纵向合同。
5. 建立包含 V4.4.4 运行代码和 version 7 正式配置的 owner-only 回滚点，并在全新临时目录验证。
6. 原子更新程序与正式配置，重启原来的唯一 LaunchAgent 一次。
7. 核验一个主进程、一个直属飞书消费者、心跳推进、Skill manifest 正常、无新增错误、Task Source 仍为同一份原件且知识库未被提前写入。
8. 项目所有者在飞书发送“重试”；验收导出来源复用、AI 决策、`save_knowledge`、KnowledgeWriter、Outcome、一次回复和临时清理。
9. 成功后再把系统总版本更新为 V4.4.5，并记录 V4.4.4 为已部署的前置安全热修而非独立最终验收版本。

## 6. 文件边界

候选实现只允许涉及：

- `src/config.mjs`；
- 直接配置合同测试；
- 必要的 V4.4.5 纵向或部署证据测试；
- 本设计、实施计划、候选/生产证据和版本说明。

正式部署只改变已验证程序文件和 version 7 配置中的 `personalAssistant.aiTimeoutMs`。Skill、manifest、状态 Schema、Writer、权限、媒体门、模型和用户资料均不改变。

