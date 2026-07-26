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
