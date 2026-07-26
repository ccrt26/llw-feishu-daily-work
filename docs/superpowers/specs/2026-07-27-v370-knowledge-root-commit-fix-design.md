# V3.7.0 Knowledge Root Commit Fix Design

日期：2026-07-27  
状态：用户已确认实施  
范围：`KnowledgeWriter.commit` 的受管资料库根目录写入边界

## 问题

`llw-knowledge-ingest` 规定 `use_existing` 加空 `segments` 表示已选择资料库的受管根目录，
决策校验器也接受该结构；但 `KnowledgeWriter.commit` 复用了“创建子目录”的非空段校验，
在访问文件系统前拒绝空数组。飞书和微信因此在同一个 `knowledge_writer_failed` 阶段失败。

## 方案比较

1. 推荐：段校验增加显式的 `allowRoot` 选项。`commit` 允许空段，`createFolder` 保持禁止。
   改动最小，并保留所有现有段名、深度、保留名和路径逃逸检查。
2. 分成两个重复的校验函数。语义清晰，但会复制安全条件，后续容易产生差异。
3. 为根目录伪造一个目录段。会创建用户未要求的目录，违反现有 Skill 契约，不采用。

## 最终设计

- `validateSegments(segments,{allowRoot:false}={})` 继续验证数组、最多五段及每段安全性。
- `KnowledgeWriter.commit` 使用 `{allowRoot:true}`；空数组表示直接以所选资料库根为分类目录。
- `KnowledgeWriter.createFolder` 使用默认值；空数组仍被拒绝。
- `ensureSegments(root,[])` 保持现有自然行为，返回根目录且不创建目录。
- 不修改 Router、Skill、Schema、配置、回复、幂等、原子发布或权限边界。

## 验证

- 先增加真实 Writer 测试：空 `folderSegments` 能在合成资料库根下创建知识项。
- 保留并执行现有测试：`createFolder` 的空 `segments` 仍被拒绝。
- 运行知识能力定向测试、完整组件回归、生产目录回归和服务健康检查。
- 部署后分别通过飞书和微信验证同一类根目录入库，检查 outcome、工件和单消费者状态。

## 外置磁盘兼容补充

根目录修复部署后的真实飞书和微信验收仍在 Writer 阶段失败。相同 Writer 在
`/private/tmp` 的合成资料库中成功，但在与正式资料库相同的外置磁盘中稳定失败。
保留内部错误的本地合成诊断确认，macOS 会在该卷上为 `knowledge.md` 自动生成
AppleDouble 伴生文件 `._knowledge.md`，并将逻辑文件表现为仅所有者可访问的
`0700`；原 Writer 只允许精确的逻辑文件集合及 `0600`，因而把安全的卷实现细节
误判为非法工件。

兼容规则保持最小且封闭：

- 逻辑文件仍只能是 `knowledge.md` 和可选的一个受控源文件；
- 只允许每个逻辑文件精确同名的 `._<name>` 伴生文件；
- 伴生文件必须是当前用户拥有的普通非符号链接文件、大小为 4 字节至 64 KiB，
  且以 AppleDouble 魔数 `00 05 16 07` 开头；
- 所有逻辑及伴生文件只能使用无组/其他用户权限的 `0600` 或 `0700`；
- 任意其他隐藏文件、畸形 AppleDouble、符号链接或权限扩大仍被拒绝；
- Writer 回执只返回逻辑文件，不暴露或传播卷元数据文件。

该补充不改变 Router、Skill、Schema、资料库选择、命名、内容、幂等或写入范围。
