# LLW Bilibili Mobile Link Hotfix Design

**Status:** 2026-08-01 project-owner approved
**Production baseline:** V4.4.0 candidate `56e106272b8b31bce4729cb1dea4dee0364962da`
**Scope:** Recognize safe `m.bilibili.com` video-share links at the existing public-video intake boundary

## Goal

让微信或飞书文字中的合法 B 站手机视频链接进入现有 Bilibili 来源准备链，而不是
作为普通文字交给模型。修复不得增加联网域名、来源类型、权限、ASR 额度、Writer、
Agent、Router 或长期进程。

## Non-goals

- 不修改持续 Task Session 的任务边界或自动分组。
- 不修复或改动抖音追加来源编号问题。
- 不修改 Bilibili 媒体下载、DNS 连接绑定、ASR、时间线、AI 或 Writer。
- 不支持普通 B 站页面、动态、直播、用户空间或任意网页。
- 不新增多分 P 选择能力。

## Design

在 `src/personal-assistant/public-video-link.mjs` 的唯一公开视频链接提取边界加入
手机链接规范化：

1. 只接受 HTTPS、精确主机 `m.bilibili.com`、无用户名/密码、无非默认端口、
   无 fragment 的链接。
2. pathname 必须精确匹配 `/video/BV[A-Za-z0-9]{10}`，允许一个结尾 `/`；
   BVID 合同与现有 Bilibili adapter 保持一致。
3. 查询参数仅用于分享追踪并在进入 adapter 前全部丢弃。若存在 `p`，必须恰好
   一个且值为 `1`；`p=2` 或其他多分 P 请求明确拒绝，避免系统静默总结第一 P。
4. 输出固定为 `https://www.bilibili.com/video/<BVID>/`。现有 adapter 继续只访问
   已批准的 `www.bilibili.com` 与媒体/API 域名，不直接访问手机站。
5. 现有 `b23.tv`、`www.bilibili.com` 和抖音链接行为逐项保持不变。

不采用让下载 adapter 直接访问 `m.bilibili.com` 的方案，因为它会扩大网络边界并
增加一次页面或跳转解析；也不采用放宽现有 Bilibili URL 校验的方案，因为这会让
追踪参数、非视频路径和多分 P 语义进入媒体层。

## Error handling

- 合法手机视频链接规范化为现有 canonical Bilibili 请求。
- 已识别手机主机上的非法路径、凭据、端口、fragment 或非第一 P 请求抛出
  `public_video_link_invalid`，不得退化为普通文字让模型猜测。
- 多个受支持公开视频链接仍按现有合同拒绝为歧义输入。

## Verification

严格按 RED → GREEN：

1. 单元合同先证明截图形态的 `m.bilibili.com/video/BV...` 当前返回 `null`，再要求
   它返回去追踪参数后的 canonical `www.bilibili.com` URL。
2. 覆盖无查询参数、`p=1`、`p=2`、非法路径、凭据/端口/fragment，以及现有
   `b23.tv`、`www.bilibili.com`、抖音和多链接合同。
3. 增加一条微信形态纵向测试，证明手机链接经过真实入口形态进入现有公开视频
   Source Intake，并保持 Writer 0；测试不得调用真实 ASR、AI、消息发送或写正式
   Vault。
4. 运行公开视频链接、Bilibili adapter、来源准备、Coordinator/Dispatcher 和微信
   纵向聚焦兼容集。
5. 形成部署候选后才运行一次与共享入口风险相称的完整回归、建立回滚点，并在
   切换生产前取得项目所有者确认。

## Acceptance criteria

- 用户发送合法 B 站手机视频链接和“总结、不保存”时，系统识别为 Bilibili 视频
  来源，不再给出“缺少可验证转写和完整画面证据”的普通文字拒绝。
- 手机链接规范化后不保留分享追踪参数，不扩大网络或权限边界。
- 非第一 P 不被静默错误总结。
- 现有短链、标准链接、抖音、ASR、AI、Writer 和 Task Session 行为无变化。
