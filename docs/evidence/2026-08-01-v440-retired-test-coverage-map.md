# V4.4.0 退役测试覆盖迁移证据

## 目的

V4.4.0 删除旧 Coordinator `handle()`、旧 Dispatcher、Capability registry、
Source Job 和旧来源准备器。以下测试不能通过改名继续存在，因为它们执行的对象已
退出运行图。本表逐项确认现行 Task Session 主链中的替代覆盖；没有替代覆盖的
区间读取轮数边界已先迁移到当前 Coordinator 测试。

## 旧 V4.0.1 纵向旅程

| 旧场景 | 当前覆盖 |
|---|---|
| 飞书纯文字到每日工作 Writer、Outcome、回复 | `personal-assistant-record-daily-work.test.mjs`；现行飞书 Task/Outcome/回复链由 `v410-task-session-journeys.test.mjs` 覆盖 |
| 回复恢复不重复 AI/Writer | `v410-task-session-journeys.test.mjs` 的持久 Outcome 回复恢复旅程 |
| 等待文件后合并 DOCX/PDF | `v410-task-session-journeys.test.mjs` 的文件后补要求旅程；`personal-assistant-task-source-workspace.test.mjs` 的多来源合并 |
| 无文字餐饮发票和真实归档 | `personal-assistant-archive-invoice.test.mjs`、`invoice-archive-writer.test.mjs`、`invoice-decision-validator.test.mjs` |
| 三来源生成文件 | `personal-assistant-create-document.test.mjs`；现行 revision/生成发布旅程在 `v410-task-session-journeys.test.mjs` |
| 两张发票批次 | `personal-assistant-archive-invoice.test.mjs` 的批次预校验、顺序写入和部分失败 |
| 分开发送来源的 debounce | `personal-assistant-source-burst-collector.test.mjs`、`personal-assistant-dispatcher.test.mjs` |
| 飞书云文档只读快照 | `feishu-document-exporter.test.mjs`、`personal-assistant-source-preparer.test.mjs`、现行 Coordinator 云文档门禁 |

旧旅程依赖已删除的 `knowledge-ingest/source-preparer.mjs`、
`office-source-preparer.mjs` 和 Coordinator `handle()`，不能进入 V7。

## 旧故障注入

| 旧场景 | 当前覆盖 |
|---|---|
| DeepSeek 附件在来源准备前拒绝 | `personal-assistant-invoker.test.mjs`、`personal-assistant-coordinator-tools.test.mjs` |
| 非法工具参数零 Writer、重复不重做 | `personal-assistant-tool-definitions.test.mjs`、现行 Dispatcher 幂等测试 |
| 回复失败恢复不重调 AI | `v410-task-session-journeys.test.mjs` |
| Writer 失败不重调 AI | `v410-task-session-journeys.test.mjs`、各现行工具执行器测试 |

## 旧只读与会话运行测试

| 旧场景 | 当前覆盖或决定 |
|---|---|
| PDF 同轮总结零 Writer | `v420-phase0-scanned-pdf-journey.test.mjs` |
| Office 原件只读、无预解析伪证据 | `personal-assistant-context-builder.test.mjs`、Task Source Workspace 测试 |
| 飞书文档 URL 不进入模型 | `feishu-document-exporter.test.mjs`、现行 Source Preparer 测试 |
| waiting_file、取消、来源保留 | 由持久 Task Session、Dispatcher 取消和 Task Source Workspace 取代 |
| 旧 Coordinator 内个人规则确认 | 已退出现行运行图；规则文件的安全读写仍由 `personal-assistant-rules.test.mjs` 覆盖 |
| 视频区间读取 | `v432-video-range-wechat-journey.test.mjs` |
| Source Job retain/release | 已由 Task Source Workspace 生命周期取代 |

## 补齐的独立边界

旧 `v410-foundation-fault-injection` 唯一未被直接锁定的独立行为是来源区间读取
轮数上限。V4.4.0 已在 `personal-assistant-coordinator-tools.test.mjs` 增加
“stops at the configured source-read round limit with zero writes”，RED 时因测试
组合未传入上限得到 `4 !== 2`，GREEN 后为 `1/1` PASS。它直接执行当前
`handleTask()`，验证达到上限后不再读区间且 Writer 为零。

## 已运行的替代覆盖

- 当前 Provider、安全、上下文、工具定义：`35/35` PASS。
- 当前主组合、Dispatcher、Task Session、Task Source Workspace、PDF 证据：
  `66/66` PASS。
- 当前四类 Writer/工具和 V7 Task Session 纵向旅程：`63/63` PASS。
- 当前扫描 PDF、公开视频保存和真实区间微信旅程：`7/7` PASS。

上述结果用于证明风险已迁移，不把已删除旧模块的测试数当作候选质量指标。
