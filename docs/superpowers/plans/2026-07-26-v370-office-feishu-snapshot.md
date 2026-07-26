# V3.7.0 Office 与飞书云文档快照实施计划

1. 先写 Office 安全准备器失败测试，覆盖三种 OOXML、宏/加密/外链/炸弹/格式伪造和资源上限。
2. 实现有界 OOXML Python 解析器与 Node 包装器，运行准备器目标测试。
3. 写并实现 Knowledge Writer 二进制原件持久化测试，保持原子、幂等、不覆盖。
4. 写并实现 knowledge capability 的三种 Office 单下载、单清理和受限 AI 输入测试。
5. 写并实现飞书链接识别与单次导出适配器测试；只允许 DOCX/XLSX/PPTX 快照。
6. 更新严格配置、主组合和微信文件头验证，候选继续双重关闭。
7. 更新私有 `llw-knowledge-ingest` Skill、Schema/eval、版本与 manifest 哈希。
8. 先运行新增与相邻目标测试，再在阶段收口运行一次完整回归、隐私扫描和隔离恢复验证。
9. 验证通过后提交并推送两条集成分支；不建 PR、不合并、不部署、不重启。
