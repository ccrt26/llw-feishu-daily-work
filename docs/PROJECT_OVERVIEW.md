# LLW Personal Assistant V4.1.0 Project Overview

日期：2026-07-29

状态：V4.1.0 持续任务已实现、部署并完成真实微信纵向验收；媒体保持关闭

用途：供项目所有者、开发者和 AI 评审者理解当前生产架构

## 1. 目标与原则

V4.0.1 把历史上的多层语义链收敛为一个 LLW Personal Assistant；V4.1.0 在不增加第二个助手或任务平台的前提下，把短消息轮次升级为每通道一个持续 Task Session：

```text
飞书 / 微信薄入口
  → 绑定、幂等和来源安全
  → 飞书/微信各自的当前 Task Session
  → 一个 Personal Assistant
  → 直接回复 / 询问一次 / 调用一个安全工具
  → Writer
  → Outcome
  → 原入口回复
```

核心原则：

1. 自然语言表达任务要求，文件是处理对象；同通道后续输入持续加入当前任务。
2. 程序在 AI 前只处理传输与安全，不提前替 AI 做业务语义判断。
3. 一轮可以查看多个来源，但最多执行一个副作用工具。
4. 工具参数定义只有一份，同时用于模型声明、执行校验和测试。
5. Writer 是唯一业务持久化者；AI 不能提前宣称写入成功。
6. 飞书和微信只是入口，各自保存一个独立当前任务，不各自建立业务系统。
7. 失败关闭、最小数据、可恢复、可回滚。

## 2. 当前生产架构

```mermaid
flowchart TD
  subgraph Entry["Thin entries"]
    F["Feishu"]
    W["WeChat"]
  end
  F --> I["IncomingMessage: instruction + 0..8 attachments"]
  W --> I
  I --> B["Binding, queue, idempotency, burst collection"]
  B --> TS["Durable per-entry Task Session + revision"]
  TS --> S["Retained Source Intake and Content Safety"]
  S --> A["LLW Personal Assistant"]
  A --> R["Direct reply / one question"]
  A --> T{"One tool call"}
  T --> DW["record_daily_work"]
  T --> IV["archive_dining_invoice"]
  T --> K["save_knowledge"]
  T --> D["create_document"]
  DW --> O["Outcome first"]
  IV --> O
  K --> O
  D --> O
  R --> O
  O --> TS
  O --> P["Reply recovery and original-entry reply"]
```

生产配置 version 6 只加载 `llw-personal-assistant`。旧 Router、Capability registry 和候选 normalizer 已从 V6 静态启动链退出；旧版本兼容代码只在非 V6 回滚入口按需加载，历史还保存在 Git 和受保护回滚包中。

## 3. 消息与多来源

`IncomingMessage` 可以同时包含：

- 当前自然语言 `instructionText`；
- 0–8 个附件；
- 原入口的最小 `ReplyTarget`。

飞书或微信把文字与文件拆成相邻事件时，有界 burst collector 只决定何时启动一次处理，不决定任务边界。每条安全输入先持久增加当前通道任务的 `revision`；超过 15 秒、AI 已回复、AI 追问或一次处理失败，都不会让后续输入脱离当前任务。

首批资源限制：

- 每轮最多 8 个来源；
- 单个来源最多 20 MiB；
- 一轮总计最多 80 MiB；
- 支持 TXT、Markdown、DOCX、PPTX、XLSX、PDF 和安全图片；
- 多个明显相关文件默认作为一个来源集合交给一次 AI；
- 多个互不相关任务只问一次“合并还是拆分”，不自动调用多个工具。

当前用户要求优先于文件名和附件内容。例如“总结，不保存”必须零 Writer；附件正文即使含有命令式文字，也只被视为数据。

普通来源进入任务级只读工作区后保持到任务结束、取消、替换或 24 小时不活动。Writer 和回复前都复核 `taskId + revision`；运行中补充会让旧快照失效，旧结果不得写入或回复。

## 4. AI-first 原文件理解

Codex 运行在当前轮的私有任务目录：

- `cwd` 仅为当前轮工作区；
- sandbox 为只读；
- Vault 根目录不进入 AI 工作区；
- Office/PDF 通过安全相对路径查看；
- 图片通过多个视觉输入传递；
- 不授予任务网络权限。

“AI 直接读原文件”不等于把平台附件无检查地交给模型。Source Intake 仍负责：

- 受限下载或云文档快照；
- 普通文件、所有权和权限；
- 扩展名、文件头和 OOXML/PDF 容器边界；
- 大小与总量；
- 安全相对路径、哈希和清理。

它不做业务摘要、不判断应调用哪个工具，也不把预解析结论当成 AI 的输入真相。

## 5. 四个确定性工具

### `record_daily_work`

AI 选择创建或补充目标；程序复核北京时间、候选记录、目标唯一性和原始用户文字，再调用既有 `VaultWriter`。

### `archive_dining_invoice`

支持一张或多张发票。批次在写入前完成全部硬规则校验；七个票面字段、购买方、餐饮类别、日期、金额、文件类型、哈希、命名、幂等和无覆盖由程序负责。批次中途 Writer 失败时返回可恢复的部分结果，不继续执行后续项目，也不重新调用 AI。

### `save_knowledge`

一个工具调用建立一个知识项，可以绑定 0–8 个当前来源并保留多个原件。模型只能使用允许的资料库 key；程序负责目录段、来源 ID、组合摘要哈希、原件命名、白名单、原子发布和重复幂等。

### `create_document`

生成 DOCX、PPTX 或 XLSX。文件先在私有输出工作区生成，再检查唯一工件、OOXML 类型、宏、加密、大小、普通文件、SHA-256 和稳定路径。生成文件不会自动保存到知识库。

## 6. Provider 边界

| 场景 | Codex | DeepSeek |
|---|---:|---:|
| 纯文字每日工作 | 支持 | 已批准子集支持 |
| 普通问答/知识整理 | 支持 | 不扩大 |
| 图片、PDF、Office | 支持 | 不支持 |
| 多来源任务 | 支持 | 不支持 |
| 文件生成 | 支持 | 不支持 |
| 发票视觉 | 支持 | 不支持 |

Provider adapter 只转换工具调用外壳，不理解业务、不做第二次路由，也不会在失败后自动切换模型。

## 7. 已验证的真实业务旅程

V4.0.1 已完成的业务验收继续有效。V4.1.0 新增并完成了真实微信持续任务验收：

- 先明确结束旧微信任务；
- 单独发送一份不含隐私的合成 TXT，助手追问用途；
- 稍后发送“总结，不保存、不生成文件”；
- 新任务最终为 revision 2 / resolvedRevision 2，保留同一份来源；
- 来源 SHA-256 与发送前合成文件完全一致；
- 两次阶段 Outcome 都已先持久化并回复；
- 最终直接回复，零工件、零回复文件、零知识库写入；
- 飞书当前任务保持为空，两个入口没有串扰。

既有生产验收还包括：

- 飞书文字知识保存；
- 微信“先发要求、后发三份文件”，合并为一个知识项并保留三个原件；
- 微信同轮三文件只读理解，零 Writer；
- 飞书和微信 PDF + 自然语言只读总结；
- 飞书每日工作；
- 飞书单张无文字餐饮发票自动归档；
- 微信两张餐饮发票批次归档；
- 已归档票据重复发送的真实幂等；
- 等待文件任务取消；
- 不支持音频/视频在 AI、下载和 Writer 前确定性拒绝；
- 服务重启后 Outcome/回复恢复不重复业务。

发票与知识工件验收均核对真实 Writer 结果、SHA-256、事务、Outcome、回复和临时清理。

## 8. 飞书云文档遗留项

飞书普通文档 → DOCX、表格 → XLSX、幻灯片 → PPTX、Wiki 解包后导出的代码和隔离纵向测试已经完成。真实飞书测试确认：

- 入口和链接识别已触发；
- 失败发生在 Source Intake 的用户身份权限检查；
- AI、工具和 Writer 均未运行；
- 零写入。

项目所有者因企业审批流程决定暂缓该能力，不阻塞 V4.0.1 其余发布。

当前固定版飞书 CLI 后续应一次申请并重新授权完整的五项增量权限：

- `drive:drive.metadata:readonly`
- `docs:document.content:read`
- `docs:document:export`
- `docx:document:readonly`
- `wiki:node:read`

重新授权必须保留现有身份和邮箱权限。当前实现不需要编辑、删除、移动、分享、协作者管理或上传权限；不得借此扩大授权。权限通过后必须分别验收普通文档、表格、幻灯片、Wiki 包装类型及含图片/表格块的文档。

## 9. 音频与视频边界

AIFF 是音频格式，但 V4.1.0 仍未启用音频或视频理解，决策为 `STOP_AFTER_FOUNDATION`。当前只把已知音视频元数据送到确定性拒绝路径：

- 不下载；
- 不调用 AI；
- 不调用 Writer；
- 不安装转写、FFmpeg 插件或新模型；
- 返回明确不支持。

未来扩展可以在同一 `TurnBundle` 下增加音频或视频 reader adapter 和独立资源限制，不需要改入口、工具或 Outcome 总架构；必须另行设计和批准。

## 10. 安全、状态与恢复

- 配置 version 6，状态继续使用已验证的 version 4 持久结构；
- 飞书和微信各最多一个 24 小时 Task Session，任务身份和来源完全隔离；
- 保存有界目标、阶段摘要、最近轮次、来源 ID、等待状态、revision 和 Writer checkpoint；
- 保护性 pending input 可保存最小通道回执目标，但不进入模型上下文；
- 任务工作区保留普通来源字节，状态只保存不透明来源 ID，不保存绝对来源路径；
- 不保存 token、完整模型输出或整个 Vault；
- 每个副作用先写真实 Writer，再由程序生成成功回执；
- Outcome 在回复前持久化；
- Writer 重试不重调 AI，回复重试不重做业务；
- 日志只保留阶段和有界错误码；
- 生产仍为一个 LaunchAgent、一个 Node.js 主进程和一条飞书事件消费链。

受保护回滚点包含完整组件/Skills Git bundle、配置恢复器、状态结构、LaunchAgent、PDFium 运行件事实、SHA-256 清单和隔离恢复证据；不包含密钥、平台标识、消息正文、真实发票或用户资料。

## 11. 验证基线

V4.1.0 最终候选完整回归：675/675；生产目录聚焦回归：98/98。

回归不仅统计单元数量，还包含完整纵向旅程：

```text
IncomingMessage
→ binding / idempotency / burst collection
→ durable per-entry Task Session revision
→ real Source Intake
→ retained task source workspace
→ Content Safety
→ Personal Assistant
→ frozen Tool Definition
→ real Writer or zero-write reply
→ Outcome
→ Reply / recovery
```

主要发布证据为 11 条真实形态纵向旅程，覆盖文件晚到指令、运行中补充、双通道隔离、重启、AI/Writer/回复失败、取消、Writer 不可撤回点、24 小时过期、暂停和新任务；另有一次真实隔离 Codex 冒烟和上述真实微信验收。生产健康检查确认一个 Node 主进程、一个直属飞书消费者、心跳推进、Skill 清单一致；当前微信测试任务保留一份已验证来源，飞书任务为空。

准确的生产/远端 Git 提交、回滚目录和审批进度由工作区私有 `SYSTEM_MAP.md` 维护，不把本机身份或业务路径写进仓库文档。
