# 单一 PDFium 发票 PDF 处理器设计

日期：2026-07-26  
状态：根据项目所有者复核意见补齐 PDF 内容路由，等待书面规格确认
范围：V3.6.3 发票能力的 PDF 技术兼容修正，并补齐 PDF 的内容路由准备；不改变发票业务语义

## 1. 背景与根因

生产当前使用随 Codex 工作区运行时提供的 Poppler：

- `pdfinfo` 检查加密和页数；
- `pdftotext` 提取辅助文本；
- `pdftoppm` 渲染全部页面。

真实微信 PDF 已证明下载、解密、文件检查、Codex 调用和 Node.js 规则均正常，但 Poppler 对该电子发票使用的未嵌入 `STSong-Light` / `Adobe-GB1` 字体不能完整处理。生产渲染页面丢失发票号码、日期、购买方名称、销售方名称、项目和金额，Codex 因而正确输出多个 `missing`，Node.js 正确返回 `required_field_missing`。

直接运行 Poppler 得到确定性错误：

- `Missing language pack for 'Adobe-GB1' mapping`；
- `Unknown font tag 'Xi0'`；
- `No font in show`；
- 当前二进制的数据目录还编译为不存在的构建机绝对路径。

同一原始 PDF 使用 PDFium 5.11.0 后，视觉页面和文本层均完整；以 PDFium 页面进入现有 Codex/Node.js 链路时，七个字段全部为 `clear`，类别为 `dining`，规则结果为 `archive_dining / eligible`。

## 2. 已验证的技术事实

隔离测试未修改生产配置、生产代码或正式 Vault。PDFium 5.11.0 已通过：

| 场景 | 结果 |
|---|---|
| 真实中文电子发票及未嵌入中文 CID 字体 | 页面与文本完整 |
| 普通数字 PDF | 通过 |
| 图片型扫描 PDF | 通过，允许无文本层 |
| 旋转页面 | 通过 |
| AcroForm 表单 | 表单值进入渲染结果 |
| 两页顺序 | `1, 2` 完整且稳定 |
| 十页边界 | 全部页面完成；独立进程约 478 ms |
| 十一页 | 在渲染前识别并拒绝 |
| 加密 PDF | PDFium 错误码 `4`，可稳定映射为 `pdf_encrypted` |
| 空、伪装和截断 PDF | PDFium 错误码 `3`，可稳定映射为结构无效 |
| 文本超过 256 KiB | 可在 AI 前拒绝 |
| 十页独立进程峰值内存 | 约 128.7 MiB |
| 虚构未嵌入中文字体餐饮发票端到端 | 七字段清晰、餐饮、单张；购买方不匹配按 Node.js 规则拒绝 |

PDFium 的文档加载、密码错误、页数、表单初始化、文本页和逐页渲染接口以 pypdfium2 官方 API 为准：

https://pypdfium2.readthedocs.io/en/stable/python_api.html

## 3. 设计决定

生产只保留一个 PDF 引擎：PDFium。

不得保留 Poppler 作为正常路径、回退路径或第二次尝试。PDFium 处理失败时固定安全失败，不得自动切换另一引擎。

Node.js 继续负责通用安全边界、超时、临时目录和输出复核；它不是第二套 PDF 能力。Codex 和 Node.js 发票业务职责保持不变。

现有代码对图片采用“先安全准备、再视觉路由、路由成功后复用准备结果”的顺序；但 PDF 在下载前由 `router.text` 只根据文件名、扩展名和资源类型路由，无法根据实际页面判断它是不是发票。本修正必须消除这项不一致。

完整调用顺序如下。下载、文件检查和 PDFium 是通用的受限附件准备，不是发票业务 Skill；准备结果同时供统一路由和后续唯一业务 Capability 使用：

```text
飞书 / 微信消息入口
  → IncomingMessage 标准化
  → 安全门和幂等
  → 通用受限附件准备
      → 下载到当前消息的私有临时目录
      → 文件头、扩展名、大小、普通文件和无符号链接检查
      → 一个受限 PDFium 子进程
          ├─ 加密与结构检查
          ├─ 页数检查
          ├─ 全部页面文本提取
          └─ 全部页面 PNG 渲染
      → Node.js 复核固定输出清单和限制
  → 统一意图路由 Skill：feishu-intent-router
      → router.visual 查看全部已验证页面
      ├─ clarify / unsupported：结束，不调用业务 Skill、不归档
      └─ route: invoice（high）
          → invoice Capability 复用同一份准备结果
              → invoice.visual
                  └─ 按 filing-invoices Skill 提取票面事实
              → Node.js 现有确定性入库规则
              → 现有 writer
              → 归档用户发送的原始 PDF
  → 无论结果如何都清理临时准备文件
```

这里的四个名称不得混用：

- `feishu-intent-router` 是统一意图路由 Skill。PDF 完成通用技术准备后，由它查看实际页面并选择唯一 Capability；只有 `route: invoice / high` 才进入发票业务处理。
- `invoice` 是发票 Capability，负责 AI 提取、确定性规则和 writer；它接收并复用已经下载、检查和渲染的准备结果，不得再次下载或再次运行 PDFium。
- `filing-invoices` 是发票业务 Skill，定义票面字段、清晰完整性和业务输出合同。目前允许归档的业务类别只有餐饮，但该 Skill 仍须识别并拒绝非餐饮发票，因此不是一个独立的“餐饮发票 Skill”。
- `invoice.visual` 是 `invoice` Capability 内调用 Codex 的语义任务，并非 Skill。它按照 `filing-invoices` 合同从 PDFium 页面提取事实和清晰度，不负责购买方匹配、是否入库或写文件；这些仍由后续 Node.js 确定性规则和 writer 负责。

本修正不新增第二个路由器或新的业务 Skill。现有 `router.visual` 的受限输入由“一张已准备图片”扩展为“一至十张按页码排序的已准备页面”；它仍只输出 Capability 选择，不得提取或返回票面字段。`router.text` 继续处理纯文本和无需查看内容即可判断的附件元信息，但不得用于判断 PDF 内容是不是发票。

## 4. 单一处理器边界

### 4.1 输入

Node.js 只向处理器提供：

- 已通过现有文件头、扩展名、大小、普通文件和无符号链接检查的原始 PDF；
- 当前私有 job 下一个新建、空的 `analysis` 目录；
- 固定限制：最多 10 页、文本最多 262,144 字节、渲染输出合计最多 100 MiB、页面最大边 3,508 像素。

处理器不接收飞书或微信标识、资源键、Vault 路径、归档主体、模型配置、密钥或业务规则。

### 4.2 单次执行

一次子进程必须完成全部 PDF 技术处理：

1. 不提供密码加载 PDF；错误码 `4` 映射为 `pdf_encrypted`，其他加载失败映射为 `pdf_structure_invalid`。
2. 初始化表单环境，确保可见表单字段进入页面图像。
3. 读取页数；小于 1 或大于 10 时返回 `pdf_page_limit`。
4. 按页码 `1..N` 提取 Unicode 文本；扫描件允许空文本。
5. 按页码 `1..N` 渲染白底 PNG，包含页面内容、表单和批注，最长边固定为 3,508 像素。
6. 每页处理完成后释放页面和位图，禁止把十页原始位图同时常驻内存。
7. 只输出一个有版本的最小清单，不向 stdout/stderr 输出票面文字。

预期清单形状：

```json
{
  "version": 1,
  "pageCount": 1,
  "textFile": "extracted.txt",
  "pageFiles": ["page-1.png"]
}
```

文件名只能是固定相对名称，不能由 PDF 内容、文件名或用户输入决定。

### 4.3 Node.js 复核

子进程成功不等于可以进入 AI。Node.js 必须继续验证：

- 清单为严格 Schema，未知字段拒绝；
- `pageCount` 与页面文件数量一致，顺序连续且不重复；
- `analysis` 内只能存在清单、一个文本文件和恰好 N 个页面文件；
- 所有输出为当前用户拥有的普通文件，不是目录或符号链接；
- 文本为有效 UTF-8，字节数不超过 262,144；
- 每个 PNG 文件头正确、非空，合计不超过 100 MiB；
- 子进程总时限仍为 60 秒，超时后终止并返回 `pdf_prepare_timeout`。

任一失败都不得调用 AI，临时目录由现有清理边界删除。

## 5. 运行件与配置

### 5.1 受保护的 PDFium 运行件

固定使用 pypdfium2 / PDFium `5.11.0`。生产运行件只包含所需模块、原生 PDFium 库、配置元数据和许可证，约 8.1 MiB，复制到 `~/Library/Application Support/LLW Assistant/` 下的受保护运行件目录：

- 目录权限 `0700`；
- 文件权限不得向 group/other 开放；
- 记录逐文件 SHA-256；
- 不从 Codex App 缓存目录直接运行；
- 不在服务启动或消息处理中联网安装依赖。

处理器源码、依赖版本与哈希清单模板进入组件 Git；第三方二进制运行件不直接提交 GitHub，部署工件和回滚点保存实际副本。

系统 `/usr/bin/python3` 只作为固定启动器，不提供第二个 PDF 解析引擎。启动和健康检查必须验证：

- Python 路径为预期普通可执行文件；
- 受保护目录身份和权限正确；
- 可导入精确版本 `5.11.0`；
- PDFium 原生库哈希与清单一致。

验证失败时服务必须 fail closed，不回退 Poppler。

### 5.2 单一路径配置

配置最终只保留一个 PDF 处理器可执行路径，例如 `pdfProcessorPath`。删除正常运行对 `pdfInfoPath`、`pdfToTextPath` 和 `pdfToPpmPath` 的依赖。

配置迁移必须在服务停止时原子执行。新旧组件与配置不可交叉部署；回滚必须同时恢复组件、配置和旧依赖状态。状态文件版本、模型状态、微信绑定和业务数据不因本修正改变。

## 6. 不改变的内容

本设计不得修改：

- `filing-invoices` 的七字段提取合同；
- `invoice.visual` 的 Codex `medium` 推理设置；
- DeepSeek 对发票任务保持禁止；
- 购买方名称、税号和餐饮类别三项业务资格；
- 日期只确定月份、金额只确定文件名；
- 同月同金额的 `金额`、`金额-2`、`金额-3` 顺序；
- 原始 PDF 归档、SHA-256、事务、防覆盖和幂等；
- 飞书、微信继续共用同一个 Dispatcher、Router、Capability 和 writer，不分叉第二套实现；
- 正式微信启用状态；
- 正式 Vault 的目录结构和既有资料。

不新增 OCR、第二个模型、第二个 PDF 引擎、PDF 自动修复、OFD 支持或新的发票类别。

## 7. 错误映射

保持现有用户可见语义：

| PDFium / 处理器结果 | 程序结果 |
|---|---|
| 密码错误码 `4` | `pdf_encrypted` |
| 页数 `0` 或 `>10` | `pdf_page_limit` |
| 其他加载、页对象或结构失败 | `pdf_structure_invalid` |
| 文本无效或超限 | `pdf_text_invalid` |
| 页面渲染、PNG 或输出清单无效 | `pdf_render_invalid` |
| 子进程超时 | `pdf_prepare_timeout` |

禁止在用户回复、普通日志或状态中记录 PDFium 原始异常、文件路径或票面内容。普通日志只允许安全技术错误码和有界数值。

## 8. 测试策略

### 8.1 测试驱动

实现前先新增失败测试，证明现有 Poppler 路径无法满足单一 PDFium 合同。生产代码只能在对应失败测试出现后修改。

### 8.2 必测矩阵

- 单次处理器输出清单；
- 普通数字 PDF；
- 程序生成的未嵌入 `STSong-Light` 中文发票；
- 图片型扫描 PDF；
- 旋转页和 AcroForm；
- 1、2、10、11 页；
- 加密、空、伪装、截断和损坏 PDF；
- 空文本层与超 256 KiB 文本；
- 页面顺序、尺寸、PNG 头、总输出 100 MiB；
- 超时、非零退出、异常 stdout、额外文件、缺页、重复页、目录和符号链接；
- 临时目录清理；
- PDF 必须在下载、文件检查和 PDFium 成功后才调用 `router.visual`；
- `router.visual` 必须按顺序收到全部页面，且只输出路由结果；
- 路由为 `clarify / unsupported` 时 `invoice.visual` 和 writer 调用数均为零；
- 路由为 `invoice / high` 时，同一准备结果交给 invoice Capability，下载和 PDFium 调用数均仍为一次；
- 飞书与微信相同 PDF 的准备、路由和业务调用顺序一致；
- PDFium 版本、权限、运行件哈希和无网络安装；
- 现有图片发票、飞书、微信、Router、业务规则、writer 和完整回归。

真实发票不得进入 Git、测试夹具或普通日志。回归夹具使用完全虚构数据；真实 PDF 仅在正式微信验收中出现。

## 9. 部署、回滚与验收

### 9.1 部署前

必须建立新的受保护回滚点，至少包含：

- 当前生产组件 Git bundle 和精确提交；
- 当前 Skills Git bundle 和精确提交；
- 当前 version 4 配置和状态；
- 模型状态、微信状态、LaunchAgent plist 和心跳；
- 当前 Poppler 路径事实；
- 新 PDFium 运行件、许可证和 SHA-256 清单；
- 恢复说明和事实文件。

回滚点不得包含钥匙串、token、普通日志、平台标识、消息正文、真实发票或 Vault 资料。

必须在全新 `/private/tmp` 恢复组件、配置和 PDFium 运行件，验证清单和测试后删除恢复副本。

### 9.2 原子部署

1. 确认完整回归、测试 Vault 和恢复演练通过。
2. 停止唯一 LaunchAgent。
3. 安装受保护 PDFium 运行件。
4. 同时部署组件和原子迁移配置。
5. 启动服务，检查 heartbeat、正式微信启用、Codex 模型、零待回复和唯一飞书消费者。
6. 启动不健康时立即同时恢复旧组件、旧配置和旧依赖事实。

部署不得移动、改名、整理或扫描正式 Vault。

### 9.3 真实验收

项目所有者重新通过正式微信发送已用于诊断的原始 PDF。验收只读取脱敏状态并确认：

- PDF 先完成一次下载、文件检查和 PDFium 处理，再由 `router.visual` 路由为唯一 invoice；
- `router.visual` 调用一次且只产生路由结果，`invoice.visual` 随后调用一次；
- invoice Capability 复用同一准备结果，下载和 PDFium 均不重复；
- 处理完成后全部临时输出已清理；
- Node.js 结果符合现有购买方、税号、餐饮、日期和金额规则；
- 成功时原始 PDF 进入现有月目录，源与目标 SHA-256 相同；
- 同内容重复时返回 `existing`，不覆盖；
- 只有一条回复、无待回复、heartbeat 正常。

真实验收完成后才能更新 `SYSTEM_MAP.md`、收口分支和宣告生产可用。

## 10. 被否决的方案

### 10.1 Poppler + PDFium 双引擎

可以实现回退，但会产生两套行为、两套依赖和“何时切换”的新判断，增加漂移和测试面；与项目所有者要求的简单边界冲突。

### 10.2 保留三条 Poppler 命令接口，内部换 PDFium

改动较小，但仍需三个子进程和三段协议，无法得到真正的单一处理边界；不采用。

### 10.3 修补或重编当前 Poppler

当前包同时存在缺失语言数据、缺失字体配置和错误编译前缀。修补依赖构建机路径或维护自编译 Poppler，比固定已验证的 PDFium 运行件更脆弱；不采用。

## 11. 完成标准

只有以下条件全部成立才能视为完成：

- 生产运行没有 Poppler 调用或回退；
- 一次 PDFium 子进程完成结构、加密、页数、文本和全部页面渲染；
- 所有既有安全限制和业务不变量保持；
- 完整回归、测试 Vault、回滚清单和隔离恢复通过；
- 正式微信真实 PDF 成功得到正确业务结果；
- 正式 Vault 无非预期变更；
- `SYSTEM_MAP.md`、组件提交、分支和 GitHub 已同步。
