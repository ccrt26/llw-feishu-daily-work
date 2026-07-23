# DeepSeek V4 Pro 与 Skill 级推理设置设计

## 状态与范围

- 日期：2026-07-23（Asia/Shanghai）
- 状态：项目所有者已确认采用
- 范围：阶段三隔离分支中的模型标识、现有文本任务推理设置、正式 Skill 说明和真实评测入口
- 不在范围：创建文章编写或其他尚未明确的 Skill；扩大现有输入上限；修改生产；读取 Keychain；调用真实 API；提交或推送

## 决策

1. DeepSeek 固定模型从 `deepseek-v4-flash` 改为官方 OpenAI Chat Completions 标识 `deepseek-v4-pro`。该模型由服务端提供 1M 上下文能力，不使用 Claude Code 集成专用的 `[1m]` 后缀。
2. `router.text` 和 `daily-work.interpret` 使用 DeepSeek V4 Pro 非思考模式，并保留 `temperature=0`，以优先保证短任务和严格 JSON 输出的稳定性。
3. 现有 Codex 推理强度不变：
   - `router.text`：`low`
   - `daily-work.interpret`：`low`
   - `invoice.visual`：`medium`
4. `invoice.visual` 继续禁止 DeepSeek，不自动切换到 Codex。
5. 推理设置由每个明确 Skill 的“模型支持”章节声明，并由对应语义任务的程序路径确定性执行。用户输入、模型输出和 Skill 运行时数据都不能覆盖该设置。
6. 不增加模型配置中心、动态推理选择、通用 Provider、额外 Schema 文件或模型专属 Skill 副本。
7. 尚未定义的文章编写能力不创建 Skill、不预建程序和上下文边界。以后只有在业务目标、输入、输出、资料边界和验收标准明确后，才单独设计。

## 代码与文档改动

- 将版本 4 配置迁移默认值和兼容加载默认值改为 `deepseek-v4-pro`。
- 将固定 22 条真实 DeepSeek 评测入口改为 `deepseek-v4-pro`。
- 保留 DeepSeek 客户端对 V4 Pro 的显式白名单、非思考参数和 `temperature=0`。
- 更新 Router、daily-work、invoice 三个正式 Skill 的“模型支持”说明，使现有 Codex 强度和 DeepSeek 模式可审计。
- 更新阶段三当前报告和 `SYSTEM_MAP.md`，删除仍称 Flash 为当前目标的表述。

## 不变量

- 不改变当前生产配置、状态、LaunchAgent、进程或用户资料。
- 不读取或记录 API Key。
- 不调用真实 DeepSeek，直到项目所有者对真实评测批准门再次明确批准。
- 不扩大 Router/daily-work 当前 128 KiB 请求上限和 4096-token 输出上限。
- 不自动切换模型、重试另一模型、比较或融合结果。
- 修改模型或请求格式后必须重新运行 Router + daily-work 的 22 条真实评测。

## 测试与成功标准

1. 先新增失败测试，证明版本 4 默认配置和评测入口仍指向 Flash。
2. 最小修改后，相关测试必须确认：
   - 默认模型和评测模型均为 `deepseek-v4-pro`；
   - DeepSeek 请求仍为非思考、`temperature=0`；
   - 三个正式 Skill 明确记录各自模型支持和推理设置；
   - 没有创建文章 Skill 或动态模型配置。
3. 正式 Skill 结构校验通过。
4. 阶段三隔离分支完整回归通过。
5. 当前生产组件在修改后的正式 Skill 下完整回归通过。
6. 完成以上本地门禁后，才进入单独批准的 22 条真实 API 评测。
