# V4.4.5 DOCX 证据准备与十分钟分析候选报告

日期：2026-08-02

状态：候选已实现并完成本地验证，尚未对外发布，生产总版本仍为 V4.4.3。

## 版本与提交边界

- V4.4.4 部署门基线：`a0f365e`。
- 分支：`fix/v445-personal-assistant-timeout`。
- 最终设计：`8dc3b1f`。
- 最终实施计划：`08a003a`。
- 实现提交：
  - `21494b4`：恢复配置精确 120 秒并开放单次 600 秒 invoker 合同；
  - `27d23bc`：共享严格、有界的 OOXML package reader；
  - `6f0f549`：确定性 DOCX 正文、结构、图片和 coverage 分类；
  - `e879cbb`：原子发布、哈希绑定和精确复用任务证据；
  - `fdea5ec`：单次 DOCX AI、进度提示和 Writer 前覆盖门；
  - `627e0d1`：主程序分离来源、证据准备和 AI 时限；
  - `9e5b9c2`：飞书 DOCX 纵向成功与零写入失败合同；
  - `df61a1f`：启动回收遗留 DOCX 私有 job，并补齐旧双通道 fixture。

早期 `ea83afa` / `fef7109` 等固定 300 秒候选已被后续设计和实现取代，且从未
成为对外版本。

## 候选行为

```text
飞书云文档链接
→ 现有用户身份 inspect/export（120 秒）
→ V4.4.4 安全检查
→ 私有 DOCX 子进程准备正文和 PNG（整轮 60 秒）
→ 父进程复核原件、index、关系作用域和所有证据哈希
→ 同一个 Personal Assistant 调用一次（DOCX 专用 600 秒）
→ 需要时 300 秒发送一次非 Outcome 进度消息
→ complete 才允许 save_knowledge 预订 Writer
→ Writer 至多一次 → Outcome 先持久化 → 原入口回复
```

它没有增加权限、Agent、Router、Writer、模型、服务、业务工具或网络读取。安全
HTTP/HTTPS hyperlink 只作为惰性文档内容；程序不访问链接。外部图片、模板、
OLE、嵌入对象、外部工作簿、附件、缺失类型和未知外部关系仍失败关闭。

DOCX 解析按 OOXML 结构和来源句柄的 `format` 选择，不按文件名、业务关键词或
正文猜测，因此不会把 DOCX 规则硬编码到 PDF、PPTX、XLSX、图片、文字或视频
路径。DOCX 可以和普通来源混合；DOCX 与公开视频必须拆成两个任务。

## 测试证据

- 各阶段聚焦回归：
  - 超时合同：28 项通过；
  - 共享 OOXML 安全路径：43 项通过；
  - DOCX 解析与 coverage：54 项通过；
  - 发布、复用和图片描述符：79 项通过；
  - Coordinator/Dispatcher 直接合同：34 项通过；
  - 主程序、配置、invoker/client 接线：39 项通过；
  - 飞书 DOCX、旧云文档与微信视频联合纵向集：24 项通过。
- 最终聚焦合同命令覆盖配置、主程序、OOXML、DOCX、Task Session、Writer、
  Outcome 和三条纵向业务链：206/206，通过，1.562 秒。
- 完整受限回归只运行一次：735/737，通过 735，失败 2，11.770 秒。
  - 旧 V4.1.0 双通道测试的手工 Coordinator fixture 漏接新 `TaskDocxReader`；
    补齐生产等价接线后精确测试 1/1 通过。
  - AVFoundation 合成视频在受限环境报 `Cannot Encode`；同一未修改测试在本机
    正常媒体权限下精确复跑 1/1 通过（2.695 秒）。
- 因此完整回归中的两项失败都已用精确复验闭环，等效结果为 737/737；随后正确性
  审查新增的启动清理只改动同一 Reader 和主程序接线，受影响的 22 项合同与旧
  双通道精确测试另行全部通过，没有机械重复整套回归。

所有测试均使用合成材料，不包含私人文档、平台标识或知识库内容。

## 部署同型 Mac 资源测量

可复现命令：

```bash
/usr/local/bin/node scripts/measure-v445-docx-evidence.mjs
```

测量使用合法、完整支持的合成 DOCX；60,000 ms 是父进程看门狗：

| 样本 | 温度 | 用时 | 稳定发布证据字节 | 结果 |
|---|---:|---:|---:|---|
| 2,048 条目、64 MiB 解压总量、1 个 DOCX | 冷 | 62.32 ms | 1,561 | complete / ok |
| 同上 | 热 | 49.80 ms | 1,561 | complete / ok |
| 8 个 DOCX、原件合计 83,861,384 字节 | 冷 | 554.75 ms | 12,552 | 8× complete / ok |
| 同上 | 热 | 529.15 ms | 12,552 | 8× complete / ok |

两组均未触发看门狗、资源拒绝或临时目录残留；8 份样本的耗时相对 1 份呈预期
线性增长，没有观察到非线性放大。

## 主智能体正确性审查

- 配置仍严格为 schema 7 + 120 秒，source/export/download 未被 600 秒污染。
- 合格 DOCX 关闭 `source_read`，provider 只调用一次；10 分钟后终止，不重试。
- 共享 package reader 在解压前验证条目数、单项/总量、CRC、规范路径和 XML；
  V4.4.4 对安全超链接与危险外部关系的决定未漂移。
- 图片证据保存精确的 owner part、relationship id 和 media target，父进程重新
  从当前原件证明该作用域映射并复核哈希。
- `coverageBySource` 只来自验证后的 index；被选 partial/missing/stale DOCX
  在 Writer reservation 前停止，未选 partial 不影响其他来源。
- 准备失败、AI 超时、非法 source-read、任务 revision 更新和取消均有零写入
  合同；已有 Task Session 测试证明旧结果不能跨 revision 回复或写入。
- 正常退出清理当前 job；服务重启还会在监听消息前回收所有严格命名、所有者私有
  的遗留 DOCX job，异常根目录或 job 失败关闭。
- PDF、PPTX、XLSX、图片、文字和视频路径未增加 reader、权限或平台层。

## 变更范围

生产代码只涉及：主程序接线、现有 Personal Assistant client/invoker/coordinator/
dispatcher、共享 OOXML 安全读取、新 DOCX helper/reader/evidence publisher，以及
模型图片描述符的 DOCX 分支。其余变更是直接测试、合成 fixture、资源测量脚本和
V4.4.5 文档。

没有修改知识库目录规则、KnowledgeWriter 原子语义、飞书权限、OAuth 范围、
消息入口、状态 schema、私有 Skill 版本、模型选择或服务拓扑。

## 生产与回滚门

生产仍运行 V4.4.3 总版本和 V4.4.4 安全热修，配置保持
`personalAssistant.aiTimeoutMs=120000`。部署前必须保存 owner-only 的当前组件
和配置哈希清单并验证恢复。候选部署后仅在同一飞书会话发送“重试”，不重新上传
或重新导出原文。

只有真实保留来源满足以下条件后才升级总版本为 V4.4.5：原件与 index 哈希一致，
14 个既有媒体对象全部表示或明确阻止保存，provider 只调用一次，Writer 至多一次，
成功时 Outcome 先于最终回复，且无重复写入。任一项失败都保留来源、核对 Writer
结果，并在运行健康或安全不确定时回滚 V4.4.4；不会提高十分钟上限。
