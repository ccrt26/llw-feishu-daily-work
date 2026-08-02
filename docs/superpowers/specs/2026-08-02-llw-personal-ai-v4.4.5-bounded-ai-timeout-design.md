# LLW Personal Assistant V4.4.5 DOCX 证据准备与十分钟 AI 上限设计

**状态：** 2026-08-02 已实现、部署并通过真实飞书纵向验收
**当前系统版本：** V4.4.5
**前置状态：** V4.4.4 安全分类热修继续作为安全基线
**目标版本：** V4.4.5

## 1. 决策摘要

V4.4.5 不采用“固定 300 秒后失败”，也不采用“十分钟后调用多个分段 AI 再合并”。程序在 AI 前为安全 DOCX 准备可核验的正文结构和内嵌图片证据，然后只调用一次现有 Personal Assistant：

```text
飞书云文档导出
→ 现有 OOXML 安全检查
→ TaskDocxReader 只读准备文字、图片和覆盖清单
→ 同一个 Codex 一次阅读原件和准备证据
→ 直接回复 / 询问一次 / 调用一个现有工具
→ Writer 或零写入
→ Outcome
→ 原入口回复
```

时间边界按职责独立：

| 操作 | 上限 | 到时行为 |
|---|---:|---|
| 飞书 `inspect` 或 `export` 单次外部操作 | 120 秒 | 终止该次只读外部操作 |
| 本地 DOCX 证据准备 | 60 秒 | 安全停止；不调用 AI 或 Writer |
| 合格 DOCX 任务的 AI 处理中提示 | 5 分钟 | 只发送一次进度提示，不终止 AI |
| 合格 DOCX 任务的一次 Personal Assistant Codex | 10 分钟 | 终止该次 AI，保留来源并保持零写入 |

300 秒只是合格 DOCX 任务的用户可见提示线；600 秒是该任务单次 AI 的最终硬上限。纯 PDF、PPTX、XLSX、图片、文字和视频任务继续使用现有 120 秒合同。不存在 30 分钟任务、自动多模型调用或超时后原样重试。

真实发布验收从同一保留来源生成 123 个有序文字结构和 14/14 张图片证据，覆盖
状态为 `complete`。同一个 Personal Assistant 随后完成一次知识写入，Outcome
先保存再回复原飞书会话；只产生一份 Markdown 和一份哈希一致的原 DOCX，没有
重复 Writer、发布锁或未发布 job 残留。

## 2. 已有证据与根因

真实任务已经证明：

- 用户 OAuth 和飞书权限足够；
- 云文档能够导出为非空 DOCX；
- V4.4.4 已允许安全网页超链接，同时继续拒绝危险外部关系；
- 当前真实 DOCX 约 2.67 MB，正文约 6,673 个字符，含 14 个媒体对象；
- 来源准备成功后，Codex 在 120 秒触发 `assistant_timeout`；
- Writer 调用和知识库写入均为零，原来源仍在当前 Task Session。

这些证据只能证明 AI 需要超过 120 秒，不能证明 300 秒一定足够。300 秒来自旧 invoker 的历史上限，不是这份文档的实测完成时间。

第一次 V4.4.5 部署尝试还暴露了参数耦合：`main.mjs` 把 `personalAssistant.aiTimeoutMs` 同时传给 Codex、飞书文档导出器和附件下载器。候选配置改成 300 秒后，飞书导出器因自身合法上限仍为 120 秒而拒绝启动。生产已经完整回滚并恢复健康。

根因不是单纯“秒数太小”，而是来源取得、格式解包和 AI 理解共用了不合适的时间合同，同时让 Codex 临时承担了本可由确定性程序完成的 DOCX 结构准备工作。

## 3. 目标与非目标

### 3.1 目标

1. 解除飞书文档取得、附件下载和 AI 分析对同一个超时字段的错误共用。
2. 为已经安全通过的 DOCX 生成与原件哈希绑定的文字、PNG 图片和控制器可信覆盖证据。
3. 让同一个 Personal Assistant 在一次调用中阅读原件和证据；只有合格 DOCX 任务最长十分钟。
4. 把用户无反馈等待控制在五分钟以内。
5. 无法证明内容覆盖、AI 超时、任务过期或用户取消时，保持来源可恢复和 Writer 零误写。

### 3.2 非目标

- 不增加 Agent、Router、Writer、后台队列、长期服务或第二条消息主链；
- 不增加第二次主要 AI、分段 AI、合并 AI 或自动模型重试；
- 不扩大飞书/OAuth 权限、来源类型、文件大小或媒体数量；
- 不安装或调用 WPS、LibreOffice、Office、Quick Look 或新的文档转换运行件；
- 不实现 PPTX、XLSX 的新 reader；它们继续使用现有路径；
- 不把程序提取误称为 AI 已理解，也不保证还原 Word 的精确分页和视觉排版；
- 不提前实现 V4.5.0 的来源身份、版本关系和本地知识库读取能力。

## 4. 科学的职责划分

### 4.1 格式识别保持不变

现有 `inspectAssistantSource` 继续根据文件头、OOXML 必需部件、内容类型和安全关系确认真实格式。安全检查器和 reader 共用一个严格的有界 OOXML package reader；不得各自实现两套宽严不同的 ZIP、关系或路径判断。`TaskDocxReader` 只接收已经满足以下条件的来源：

- `handle.format === "docx"`；
- 原件位于当前 owner-only Task Workspace；
- 原件哈希、大小、权限和相对路径已经通过现有来源合同；
- OOXML 宏、加密、外部对象、未知外部关系、路径和压缩资源安全门已经通过。

reader 再次打开任务工作区中的原件时，必须用期望 SHA-256 重新验证同一 package。所有准备读取的正文 XML 都禁止 `DOCTYPE`、`ENTITY` 和外部实体解析，只接受严格、非扩展的 XML。语法合法、有界、仅指向 package 内部但语义尚不支持的内容关系产生 `partial`；格式错误、悬空、越界、路径逃逸、禁止的 External 或其他不安全关系失败关闭。这样 reader 不能因为正文解析器比安全检查器宽松而重新引入 XXE、ZIP 路径或外部资源风险。

因此 DOCX reader 不根据文件名、正文关键词或业务意图判断格式，也不接管 PDF、PPTX、XLSX、图片、文字或视频路径。

### 4.2 程序只准备证据

新增独立只读组件 `TaskDocxReader`。它只负责客观、可复核的格式工作：

- 按原顺序读取标题、段落、列表和表格单元格；
- 读取页眉、页脚、脚注和尾注中可可靠表达的文字；
- 提取安全内嵌的 PNG 图片；
- 记录图片与所在 OOXML 部件、关系 ID 和附近正文块的位置关系；
- 为原件、文字证据、图片证据和表示索引计算 SHA-256；
- 列出已检查、已表示、忽略和不支持的内容部件；
- 生成 `complete` 或 `partial` 覆盖状态及明确 limitations。

它不总结、不判断重点、不识别业务、不选择工具、不访问网页链接、不生成 Writer 参数，也不修改用户资料。

### 4.3 AI 仍负责理解

原始 DOCX 继续保留在只读工作区。程序向同一次 Codex 调用提供：

- 原 DOCX；
- 有顺序和来源位置的文字证据；
- 当前图片预算内的内嵌图片；
- 覆盖状态和 limitations；
- 原有用户要求、Task Session、Skill 和工具定义。

证据是阅读辅助，不替代原件。Codex 仍然负责理解、总结和决定一次 reply、ask 或 tool call。程序不得根据提取文字预先路由业务。

## 5. DOCX 证据合同

### 5.1 任务级表示

`TaskDocxReader.prepare({workspaceDir, sources, signal, now})` 跟随现有 `TaskPdfReader` 的只读准备模式，但额外返回控制器可信的覆盖映射：

```js
{
  observations: DocxObservation[],
  modelImageFiles: DocxImageEvidence[],
  coverageBySource: {
    [sourceId]: {
      sourceId,
      originalSha256,
      indexRelativePath,
      indexSha256,
      status: "complete" | "partial",
      limitations: string[]
    }
  }
}
```

每个 DOCX 在 Task Workspace 中发布：

- `source-00N.docx-text.json`：有序、受限的文字块和结构类型；
- `source-00N.docx-image-NNN.png`：安全内嵌且模型支持的 PNG 图片；
- `source-00N.docx-index.json`：原件哈希、各证据哈希、部件覆盖、状态和 limitations；
- 与现有任务派生证据一致的 owner-only sidecar manifest。

每个 `DocxImageEvidence` 精确包含 `sourceId`、`relativePath`、`sha256`、`documentOrder`、`ownerPartName`、`relationshipId` 和 `targetMediaPartName`。`ownerPartName` 必须是一个已经解析的正文、页眉、页脚、脚注或尾注部件；`targetMediaPartName` 必须是 package classifier 已验证的 `word/media/` 内部规范名。关系 ID 只在所属部件内解释，验证器必须证明精确映射 `(ownerPartName, relationshipId) → targetMediaPartName`；不得把不同部件中合法重复的 `rId` 混为一个关系。现有模型图片验证器只对这一新描述符增加 DOCX 分支，并继续验证私有相对路径、PNG 魔数、尺寸、像素、总字节、哈希、严格递增顺序以及关系作用域；不得把 DOCX 图片伪装成 PDF 页或视频区间。

所有输出使用安全固定相对名、`0600` 权限、排他创建和原子发布，并绑定原件 SHA-256。`coverageBySource` 来自已经验证并哈希绑定的 index，不从模型文字或普通 limitations 推断。重试时只有原件哈希、index 哈希、全部证据哈希和覆盖映射完整匹配的现有证据可以复用；任何一项不一致都失败关闭，不能静默重新解释旧证据。

### 5.2 完整性定义

`complete` 只表示程序已经完整覆盖本版本明确支持的 DOCX 内容类型，不表示已经还原 Word 的全部视觉语义。

真实飞书导出件补充并固定了以下标准结构合同：

- XML 的预定义 `xml` 前缀可以合法用于 `xml:space`；任意未绑定前缀、重绑定
  `xml` 前缀或把 XML 保留命名空间绑定给其他前缀仍失败关闭；
- package 根关系只把类型和目标同时精确匹配的 core properties 与 extended
  properties 视为已检查元数据，类型缺失、目标错位或其他根关系不因此放行；
- 页眉、页脚等已解析内容部件中的标准 VML 图片，仅在每个 `v:shape` 都由
  `v:imagedata` 通过该部件自己的内部 image relationship 指向合格 PNG 时完整
  表示；纯矢量 VML、混合额外矢量形状或未知 VML 均产生 `unsupported_vml`
  并使覆盖为 `partial`；
- 已知表格、单元格和版式属性只作为结构处理，不因其存在误报 `partial`；表格
  单元格段落统一输出 `table_cell`，即使原段落带编号也不携带 heading/list 的
  `level` 字段。

package classifier 必须逐项分类全部 ZIP 条目和内容关系：

- 必须解析：`word/document.xml`；
- 可选且存在时必须解析：编号、样式、`headerN.xml`、`footerN.xml`、`footnotes.xml` 和 `endnotes.xml`；
- 可发布图片：只允许由已解析内容部件的内部 image relationship 引用、实际位于 `word/media/` 且魔数和声明类型均为 PNG 的条目；
- 已知非正文元数据：content types、关系、主题、设置、字体表和文档属性可以记录为已检查但不作为正文；
- 已知未支持内容：comments、tracked changes、charts、diagrams、SmartArt、equations、text boxes、altChunk、custom XML binding 和其他 DrawingML 语义统一产生 `partial`；
- 任意未被上述分类覆盖但语法合法、有界且只指向 package 内部的条目、内容类型或内容关系，只要可能承载或改变用户可见内容，就必须产生 `partial`，不能按未知即忽略；
- 非法路径、重复规范化名称、悬空或越界关系、路径逃逸、禁止的 External 关系、禁止 XML 标记或资源上限违规必须失败关闭，不能降级为 `partial`。

出现以下任一内容时必须标记 `partial`，不能静默遗漏：

- 图表、SmartArt、公式或无法可靠表示的 DrawingML；
- 文本框、复杂浮动布局，或 JPEG、WebP、GIF、SVG、EMF、TIFF 等本版本不支持的内嵌图片格式；
- 修订、批注或其他会改变正文解释的标记；
- 图片总数超过当前整轮 16 张模型图片预算，或与其他来源合计后放不下；
- 文字证据超过现有模型上下文字节上限；
- 任何内容部件、关系或位置绑定无法完整验证。

`partial` 仍可用于带明确限制的直接回复，但不能授权 `save_knowledge`。当模型请求 `save_knowledge` 时，Coordinator 在 Writer reservation 前取 `sourceIds` 与 `evidenceSourceIds` 的并集；其中任何被选择 DOCX 的可信覆盖状态为 `partial`、缺失或与当前原件哈希不一致，都必须确定性阻止写入并回复具体限制。未被工具选择的 partial DOCX 不阻止保存其他完整来源。不能依赖模型自觉放弃工具，也不能重新解析模型可见的 observation 来决定覆盖状态。

### 5.3 外部关系

V4.4.4 允许的安全 HTTP/HTTPS hyperlink 只作为普通文字和位置证据保留。DOCX reader 不解析网页内容、不发起网络请求，也不把链接目标下载为图片或附件。

外部图片、模板、OLE、嵌入对象、外部工作簿、附件、类型缺失和未知关系仍由现有安全检查在 reader 前拒绝。DOCX reader 不复制一套较宽松的安全判断。

## 6. 资源与时间边界

### 6.1 来源准备

现有安全上限继续生效：

- 单个来源最多 20 MiB；
- OOXML 最多 2,048 个 ZIP 条目；
- 解压内容总计最多 64 MiB；
- 单个条目最多 16 MiB；
- 当前任务最多 8 个来源、总计 80 MiB。

DOCX reader 不放大这些上限，也不使用外部网络。解析运行在一次性、owner-only 的短生命周期 Node 子进程中，由父进程强制执行整轮 60 秒截止时间；不能依赖同步解析代码自行检查时间。子进程只能读取复制到私有 job 目录的当前原件并写入该目录，退出后由父进程重新验证所有输出再原子发布。

60 秒是本地证据准备的故障看门狗，不是预期耗时，也不用于证明性能。候选必须在部署同型 Mac 上分别对冷启动和热启动重复测量：一个最大合法 2,048 条目/64 MiB 解压总量的 DOCX，以及一个满足 80 MiB 整轮上限的最多八 DOCX 组合。报告每次总耗时、峰值输出字节和结果码；任一样本触发 60 秒看门狗、资源上限或非线性增长即候选失败。确定性单元测试只用可控假 helper 证明超时终止，不以容易受机器负载影响的 12 秒墙钟断言作为普通回归门禁。

### 6.2 AI 与提示

- 正式配置中的 `personalAssistant.aiTimeoutMs` 继续为 120,000 毫秒，配置 Schema 仍为 7；
- invoker 的合法硬上限从 300,000 调整为 600,000，但默认和纯非 DOCX 任务仍传正式配置的 120,000；
- Coordinator 只在当前来源含至少一个覆盖证据已验证的 DOCX、且不含公开视频时，向同一个 provider 调用显式传入 600,000；
- DOCX 与普通文字、图片、PDF、PPTX 或 XLSX 混合时，整轮使用 DOCX 的 600 秒合同，但其他 reader 和格式行为不变；
- DOCX 与 Bilibili/Douyin 公共视频混合时，在 AI 和 Writer 前要求拆成两个任务，避免为了视频区间读取破坏一次 AI 合同；
- 合格 DOCX 任务固定 `allowSourceRead=false`，输出 Schema 不声明 source read；即使 provider 返回 source-read envelope 也按无效结果失败，绝不进入现有 decision loop；
- 五分钟提示只用于上述合格 DOCX 任务，使用独立命名的 300,000 毫秒运行合同，不作为来源或 AI 终止时间；
- 只有 AI 仍在运行且当前 task revision 未变化时才尝试发送一次提示；
- 提示失败不影响最终 Outcome，提示本身不保存 Outcome、不授权 Writer；
- 十分钟到达时终止 Codex，任何迟到结果都必须被 revision、取消信号、Writer reservation 和 current/compatible 复核阻止。

AI 超时后不自动重调模型。来源和 DOCX 证据继续保留在当前 Task Session，Writer 为零；用户后续补充或重试仍使用现有任务合同。无论成功、超时或无效 source-read envelope，合格 DOCX 路径的 provider 调用计数都必须恰好为一。

## 7. 多格式扩展边界

统一的是任务级文档证据接口，不是文件解析实现：

| 格式 | 组件 | V4.4.5 行为 |
|---|---|---|
| 纯 PDF | 现有 `TaskPdfReader` | reader 和 120 秒 AI 不变 |
| 含 DOCX、无公开视频 | 新增 `TaskDocxReader` | DOCX 证据准备；整轮一次 600 秒 AI |
| DOCX＋公开视频 | 不进入 AI | 要求拆成两个任务，Writer 为零 |
| 纯 PPTX | 无新 reader | 原件直读和 120 秒 AI 不变 |
| 纯 XLSX | 无新 reader | 原件直读和 120 秒 AI 不变 |
| 纯图片、文字或视频 | 现有路径 | reader、source-read 和 120 秒 AI 不变 |

未来只有真实负载证明需要时，才为 PPTX 或 XLSX 单独设计 reader。不得把 Word、PowerPoint 和 Excel 塞进一个万能 Office parser，也不得修改旧 `ooxml_processor.py`，除非先证明它仍有当前生产调用方和符合本设计的严格覆盖合同。

## 8. 失败、取消与写入

以下任一项必须失败关闭：

- DOCX 证据无法与当前原件哈希、大小或路径绑定；
- reader 超时、异常或派生证据不完整；
- 被 `save_knowledge` 的 `sourceIds` 或 `evidenceSourceIds` 选中的 DOCX 覆盖状态为 `partial`、缺失或哈希不匹配；
- AI 超过十分钟、退出异常或结果 Schema 校验失败；
- 合格 DOCX 路径返回 source-read 请求或尝试第二次 provider 调用；
- Task revision 变化、任务结束或用户取消；
- Writer reservation、current/compatible 复核或 Outcome 保存失败。

失败时清理未发布的暂存文件，保留原 DOCX 和已经完整发布且仍匹配的派生证据。未获得当前且合法的最终 `save_knowledge` 决策时，Writer 调用必须为零。回复只说明失败阶段、覆盖限制和来源仍在，不泄露文档正文、平台标识或内部路径。

## 9. 测试与真实验收

### 9.1 最小确定性合同

1. `main` composition 证明飞书 `inspect/export` 固定使用 120 秒、附件下载使用原有边界、DOCX reader 使用父进程强制的 60 秒、合格 DOCX 显式使用 600 秒，而纯非 DOCX 任务仍使用配置中的 120 秒。
2. 配置 Schema 7 和正式 `personalAssistant.aiTimeoutMs=120000` 保持不变；invoker 接受显式 600 秒但拒绝更大值，其他能力时限不变。
3. DOCX reader 覆盖段落、标题、列表、表格、页眉页脚、脚注尾注和 PNG 图片的顺序、哈希、可信覆盖映射和重用；重复 `rId` 分属不同 owner part 时仍验证精确 `(ownerPartName, relationshipId) → targetMediaPartName` 关系。
4. 任意正文 XML 中的 `DOCTYPE`、`ENTITY`、非法编码或外部实体解析，以及宏、加密、外部对象、未知关系、路径逃逸、ZIP 资源超限和不安全图片，都继续在 AI 前失败。
5. 图表、SmartArt、公式、修订、批注、JPEG/WebP 等不支持图片、未知内容部件或图片预算超限产生 `partial`，不得静默变成 `complete`。
6. `partial` 可以带限制直接回复；选中 partial、覆盖缺失或哈希不匹配 DOCX 的 `save_knowledge` 在 Writer reservation 前被阻止。未选中的 partial 来源不影响其他完整来源入库。
7. 合格 DOCX 与普通来源混合仍只有一次 provider 调用；DOCX＋公开视频在 AI 前拒绝；纯视频的既有 source-read 循环保持不变。
8. 合格 DOCX 固定 `allowSourceRead=false`；即使假 provider 返回 source-read envelope，provider 调用计数仍为一且 Writer 为零。
9. 五分钟提示最多一次，不占 Outcome；十分钟超时取消 Codex，迟到结果、任务补充和取消均不能写入或回复。
10. 可控假 helper 证明父进程能在 60 秒合同下终止并清理；部署同型 Mac 的冷/热单文件和八文件资源基准被记录，任一 60 秒超限即候选失败，但普通回归不使用 12 秒墙钟断言。

### 9.2 纵向合同

新增覆盖真实形态的纵向测试：

```text
飞书云文档消息
→ 用户身份导出
→ V4.4.4 安全检查
→ DOCX 文字/图片/覆盖证据
→ 一个 Personal Assistant
→ save_knowledge
→ KnowledgeWriter 一次原子写入
→ Outcome
→ 飞书一次最终回复
→ 暂存清理
```

另有失败旅程证明 `partial`、AI 超时或 task revision 更新时 Writer 为零、来源保留、提示不冒充 Outcome。

### 9.3 真实验收

部署前建立并恢复验证 owner-only 回滚点。部署后确认一个 LaunchAgent、一个 Node 主进程、一个直属飞书消费者、心跳推进、Skill 正常、原来源仍在且知识库未被提前写入。

项目所有者无需重新上传，只发送“重试”。真实验收只记录阶段耗时、数量、覆盖状态和结果码，不记录正文、标题、图片内容、平台标识或 Vault 路径。必须证明：

- DOCX 证据与当前保留原件哈希一致；
- 已只读确认的 14 个 PNG 媒体对象均被表示或明确说明限制；
- AI 只调用一次并在十分钟内返回合法决策；
- KnowledgeWriter 至多一次，Outcome 先保存再回复；
- 只有 Writer、Outcome 和原入口回复全部成功后，系统版本才更新为 V4.4.5。

## 10. 版本与文档管理

- V4.4.5 已在真实验收成功后成为当前对外版本；
- V4.4.4 记录为已经部署的安全前置热修；
- 第一次 V4.4.5 部署尝试记录为已回滚的失败尝试，不构成发布；
- 旧“固定 300 秒”和“多次分段 AI＋30 分钟总任务”计划都已失效，不得继续执行；
- 本设计已经书面复核，并按 TDD、聚焦测试、一次必要完整回归、回滚验证和真实
  飞书纵向门禁完成发布。

## 11. 允许的实现边界

预计只涉及：

- `main` 中来源操作与 AI 时间参数解耦；
- 合格 DOCX 专用的 600 秒有界调用、五分钟幂等提示和 `allowSourceRead=false` 单调用合同；
- 一个独立、只读的 `TaskDocxReader` 及任务派生证据合同的必要扩展；
- 控制器可信 `coverageBySource` 和被选 `partial` DOCX 对 `save_knowledge` 的确定性零写入门；
- 直接配置、invoker、reader、协调器、Writer/Outcome 和飞书 DOCX 纵向测试；
- V4.4.5 设计、计划、证据、报告和版本说明。

不得修改权限、Skill 业务语义、Writer 数据格式、知识库目录、用户资料、外部关系放行规则、模型、推理强度、服务数量或入口架构。
