# LLW Personal Assistant V4.4.0 单主链候选报告

日期：2026-08-01

## 结论

V4.4.0 本地候选已把 V7 Task Session 收口为唯一运行主链。旧 main、旧
Dispatcher/Router、旧 capability 包装、旧 Conversation/Source Job 和旧
DeepSeek 评估入口已从候选删除；Git 历史和 V4.3.2 精确提交继续提供回滚。

本候选不修改 Writer 授权、目录、来源范围、模型权限、外部额度、用户资料、
生产配置或服务。

## 运行图

唯一运行路径为：

`main.mjs` → `PersonalAssistantDispatcher.acceptIncomingMessage()` →
`PersonalAssistantTaskSessionManager` →
`PersonalAssistantCoordinator.handleTask()` → 来源准备 / AI / 一个安全工具 →
Writer 或零写入 → Outcome → 原入口回复。

- 非 V7 配置只返回 `config_migration_required`，不再动态载入旧 main。
- Coordinator 不再暴露旧 `handle()` 循环。
- Dispatcher 不再暴露旧 `processIncomingMessage()` 或旧条件分叉。
- SourceReader、`inspect_time_range`、SourceBurstCollector、revision 门禁、Writer
  reservation、恢复和处理中回执全部保留。
- 飞书和微信继续共享同一个 Coordinator、Dispatcher、Writer、Outcome 和恢复链。

## 共享合同分离

为避免新主链依赖旧模块，候选新增三个中立小合同：

- `core/keychain-password-reader.mjs`：固定 argv、单行有界 Keychain 读取和中立错误；
- `core/opaque-identifier.mjs`：43 字符 base64url opaque ID 校验；
- `personal-assistant/legacy-conversation-state.mjs`：只供 StateStore 离线迁移使用的
  纯状态校验，不提供旧会话运行 API。

旧 waiting conversation 仍可确定性迁移；带 retained Source Job 的旧状态继续
明确拒绝，不猜测迁移。

## 测试迁移

删除测试前逐组验证了现行替代覆盖。仍有价值的安全、业务 Skill、微信大整数
消息 ID、媒体门禁和当前纵向旅程均已迁移；只验证退役对象的测试才删除。

独立缺口“来源区间读取达到轮数上限后停止且零写入”已先迁移到当前
Coordinator `handleTask()` 测试。RED 为 `4 !== 2`，测试组合传入显式上限后
GREEN 为 `1/1`。

详细映射见
`docs/evidence/2026-08-01-v440-retired-test-coverage-map.md`。

## 版本和变更量

- 组件运行提交：`027cadcb41057873cf39577208098815c47cc6f8`
- Skills 提交：`81bfc6b494362675a6cb88ad33af1dac29a53494`
- Skills manifest：`4.4.0`
- `llw-personal-assistant/SKILL.md` 内容未修改；SHA-256 仍为
  `5f23ad631b2ec47959bdb89f503db818ba0fbc9784c6499ac02bb1039331eacc`
- 相对 V4.3.2 组件基线：109 个文件变化，672 行新增，15,286 行删除。

删除量主要来自旧运行实现和只验证旧实现的测试，不代表减少现行业务能力。

## 验证证据

### 聚焦验收

命令覆盖主组合、Keychain、隐私、Provider、Coordinator、Dispatcher、
Task Session、状态迁移、来源 debounce/读取、工具定义、扫描 PDF、视频保存、
真实区间微信旅程和微信入口。

结果：`190/190` PASS，0 fail。

### 完整候选回归

权威命令：

```sh
LLW_PERSONAL_SKILL_ROOT=/private/tmp/llw-v440-single-mainline/skills/llw-personal-assistant \
LLW_SKILLS_ROOT=/private/tmp/llw-v440-single-mainline/skills \
node --test test/*.test.mjs
```

结果：`620/620` PASS，0 fail，0 cancelled，0 skipped。

完整回归在本机环境运行，覆盖真实 PDFium、固定媒体 helper、本机回环测试、四类
Writer、飞书/微信入口和恢复。一次过宽的 `node --test` 曾把
`test/fixtures/*.mjs` 与真实 smoke 程序误当测试并等待输入，已安全中断；它不计入
验收。纠正后的明确文件集合是上述唯一完整回归结果。

### 静态审计

- 活动源码和测试对退役模块的导入：0。
- 活动源码和测试对旧 `handleIncomingMessage()`、Coordinator `handle()`：0。
- 测试相对导入缺失：0。
- `git diff --check`：PASS。
- 组件与 Skills worktree 在提交后均干净。

## 回滚

- 组件回滚基线：`0ce2b3f9aa9e25a1914cbadec45a89bb133d498d`
- Skills 回滚基线：`bde85270c7d2b0e3805420fa19bf5573ef174969`

## 明确未做

- 未修改脏的生产 checkout。
- 未部署、未重启 LaunchAgent、未更新生产配置或 manifest 哈希。
- 未调用外部 API、未产生外部费用、未处理真实用户数据。
- 未提交或推送 GitHub。
- 未为了缩短约 700 行的 `main.mjs` 做大规模接线重写；稳定优先，本次只收口
  运行图。组合函数进一步拆分与配置范围化留给后续独立阶段。
