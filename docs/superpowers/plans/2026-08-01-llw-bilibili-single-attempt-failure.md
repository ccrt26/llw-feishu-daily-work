# LLW V4.4.3 Bilibili Single-Attempt Implementation Record

**Goal:** 删除 B 站自动二次来源调用，保留一次尝试和安全失败原因。

## Completed implementation

- [x] RED：来源准备测试证明 `bilibili_access_denied` 和
  `bilibili_media_unavailable` 当前各调用两次；Dispatcher 仍返回笼统重试回复。
- [x] GREEN：删除 `RETRYABLE_BILIBILI_FAILURES` 和
  `prepareWithBoundedRetry()`，直接调用一次平台 adapter。
- [x] 为固定白名单失败码增加用户回复分组，未知细节保持安全兜底。
- [x] 将旧的 V4.4.1 自动重试纵向测试改为 V4.4.3 微信单次尝试合同。
- [x] 保留任务取消、暂存清理、ASR/AI/Writer 零调用和安全日志合同。

## Required verification

```bash
node --test \
  test/personal-assistant-public-video-source-preparer.test.mjs \
  test/personal-assistant-dispatcher.test.mjs \
  test/v443-bilibili-single-attempt-wechat-journey.test.mjs
```

随后运行公开视频、任务控制、任务来源、微信纵向聚焦集和一次明确排除 fixture
脚本的完整 `test/*.test.mjs` 回归。原生 AVFoundation 合同若受受限沙箱编码权限
影响，应在正常本机媒体权限下单独复核，不得把权限失败误报为业务失败。

## Deployment and publication

部署前建立受保护回滚目录，仅替换本次相关源码、测试和文档；重启后检查服务、
Outcome、暂存目录和配置/状态文件边界。验证通过后提交当前候选分支，推送 GitHub，
创建 PR 并合并到经 Git 历史确认的生产集成基线。
