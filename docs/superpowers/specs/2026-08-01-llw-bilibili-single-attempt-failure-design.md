# LLW V4.4.3 Bilibili Single-Attempt Failure Design

**Status:** 2026-08-01 project-owner approved and implemented
**Release:** V4.4.3
**Scope:** remove the automatic Bilibili source retry and report one safe, useful failure reason

## Goal

每条 B 站处理请求只调用一次公开视频来源适配器。失败后系统说明可安全确认的失败
类别，由用户决定是否重新发送；不得自动进行第二次网络或媒体获取，也不得因此调用
ASR、AI 或 Writer。

## Decision

1. `createPublicVideoSourcePreparer()` 对 B 站和抖音都只调用一次对应 adapter。
2. 保留固定白名单诊断标签，只用于安全日志和用户可理解的分组回复。
3. 回复区分：链接无效、访问失败、媒体不可用、返回信息异常、媒体检查失败、超限、
   本地安全复核失败。未知细节退回宽泛安全回复。
4. 回复不包含真实路径、URL 查询参数、哈希、平台响应、身份信息或异常堆栈。
5. 来源失败时 ASR、AI、Writer 均为零；暂存目录必须清理；Outcome 的稳定原因仍为
   `public_video_source_preparation_failed`。

## Non-goals

- 不修改 B 站下载协议、域名白名单、DNS 绑定、媒体大小或时长上限。
- 不修改抖音、任务自动分组、ASR、时间线、模型、Writer 或权限。
- 不把网络推测描述为确定事实；访问失败只说明“可能是网络或站点临时拒绝”。

## Verification

- 单元合同覆盖所有 B 站 adapter 失败码，逐项断言调用次数恒为 `1`。
- Dispatcher 合同覆盖媒体不可用、本地安全复核失败和未知细节的回复与日志边界。
- 微信纵向合同覆盖真实入口形态到 Source Intake、失败 Outcome、原入口回复、
  ASR/AI/Writer `0`、暂存清理，并断言 adapter 仅调用一次。
- 继续运行独立 B 站任务、手机链接、任务结束和现有视频理解兼容测试。

## Acceptance criteria

- 任何 B 站来源失败都不会触发自动第二次来源调用。
- 用户能看到安全、可行动的失败类别，并可自行重发。
- 未知或内部细节不会进入用户回复或普通日志。
- 成功的视频总结链、任务结束语义和 Writer 零写入规则保持不变。
