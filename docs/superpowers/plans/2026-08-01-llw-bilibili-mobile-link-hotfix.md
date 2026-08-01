# LLW Bilibili Mobile Link Hotfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely recognize exact Bilibili mobile video-share links and route them through the existing canonical Bilibili evidence pipeline.

**Architecture:** Normalize only `m.bilibili.com/video/<BVID>` at the existing public-video text boundary. Emit the existing canonical `www.bilibili.com` URL so the DNS-bound adapter, source preparation, ASR, timeline, AI, Writer, and Task Session remain unchanged.

**Tech Stack:** Node.js 24, ECMAScript modules, built-in `node:test`, existing LLW Personal Assistant shared core.

## Global Constraints

- Do not modify Douyin, task grouping, ASR, AI, Writer, permissions, quotas, models, helpers, or long-running processes.
- Do not add a network request or permit the runtime to connect to `m.bilibili.com`.
- Accept only exact HTTPS mobile video paths with the existing BVID shape; canonicalize to `www.bilibili.com` and remove share tracking parameters.
- Reject a non-first multipart request rather than silently summarizing part 1.
- Work only in the isolated V4.4.0 worktree; do not edit or restart production before a separate deployment gate.
- Do not commit or push without separate project-owner authorization.

---

### Task 1: Mobile Bilibili URL normalization contract

**Files:**
- Modify: `test/personal-assistant-public-video-link.test.mjs`
- Modify: `src/personal-assistant/public-video-link.mjs`

**Interfaces:**
- Consumes: `extractPublicVideoRequest(instructionText: string)`
- Produces: `{platform: "bilibili", url: "https://www.bilibili.com/video/<BVID>/"}` for a safe mobile video-share URL.

- [x] **Step 1: Write the failing mobile-link tests**

Add literal expectations for a screenshot-shaped tracking query, a no-query mobile URL, `p=1`, and rejection of `p=2`, credentials, non-default port, fragment, and non-video paths. The primary expectation is:

```js
assert.deepEqual(
  extractPublicVideoRequest(
    "总结 https://m.bilibili.com/video/BV1AbCdEfGhJ?buvid=redacted&p=1&share_source=WEIXIN，不保存"
  ),
  {
    platform:"bilibili",
    url:"https://www.bilibili.com/video/BV1AbCdEfGhJ/"
  }
);
```

- [x] **Step 2: Run RED**

Run:

```bash
node --test test/personal-assistant-public-video-link.test.mjs
```

Expected: FAIL because the current host allowlist returns `null` for `m.bilibili.com`.

- [x] **Step 3: Implement the minimal normalizer**

Keep `b23.tv`, `www.bilibili.com`, and Douyin unchanged. For the exact mobile host, validate the path and URL authority, validate an optional single `p=1`, then return the canonical URL:

```js
function normalizeRequest(url) {
  if (url.hostname.toLowerCase()!=="m.bilibili.com") {
    const platform=platformFor(url.hostname);
    return platform?{platform,url:url.href}:null;
  }
  const match=/^\/video\/(BV[A-Za-z0-9]{10})\/?$/u.exec(url.pathname);
  const parts=url.searchParams.getAll("p");
  if (!match||url.username||url.password||
      (url.port&&url.port!=="443")||url.hash||
      parts.length>1||(parts.length===1&&parts[0]!=="1")) {
    throw new Error("public_video_link_invalid");
  }
  return {
    platform:"bilibili",
    url:`https://www.bilibili.com/video/${match[1]}/`
  };
}
```

- [x] **Step 4: Run GREEN and direct compatibility tests**

Run:

```bash
node --test test/personal-assistant-public-video-link.test.mjs test/personal-assistant-bilibili-public-adapter.test.mjs test/personal-assistant-public-video-source-preparer.test.mjs
```

Expected: all tests PASS with 0 failures.

### Task 2: WeChat longitudinal regression

**Files:**
- Modify: `test/v432-video-range-wechat-journey.test.mjs`

**Interfaces:**
- Consumes: a WeChat-shaped text message with a mobile Bilibili URL.
- Produces: one Bilibili source preparation, one ASR evidence preparation, one timeline plus bounded range observation, one final WeChat reply, and Writer count 0.

- [x] **Step 1: Convert the existing synthetic WeChat journey to a mobile link**

Use a tracking-query mobile URL and make the fake site adapter assert that it receives only:

```js
"https://www.bilibili.com/video/BV1AbCdEfGhJ/"
```

This keeps all downstream components real while replacing only external site/ASR/model work with their existing bounded fakes.

- [x] **Step 2: Verify the journey protects the new boundary**

Temporarily run the journey against the pre-fix parser or use the recorded Task 1 RED evidence. It must fail before source preparation when mobile normalization is absent.

- [x] **Step 3: Run the longitudinal GREEN test**

Run:

```bash
node --test test/v432-video-range-wechat-journey.test.mjs
```

Expected: PASS; site/ASR/timeline/range each run once, Writer remains 0, Outcome is committed, and the reply returns to WeChat.

### Task 3: Candidate verification and handoff

**Files:**
- Verify only; update design/plan evidence if and only if the implementation result differs from the approved design.

**Interfaces:**
- Consumes: Tasks 1–2 candidate.
- Produces: a deployment-ready local diff with fresh verification evidence and no production mutation.

- [x] **Step 1: Run the focused compatibility set**

```bash
node --test \
  test/personal-assistant-public-video-link.test.mjs \
  test/personal-assistant-bilibili-public-adapter.test.mjs \
  test/personal-assistant-public-video-source-preparer.test.mjs \
  test/personal-assistant-coordinator-tools.test.mjs \
  test/personal-assistant-dispatcher.test.mjs \
  test/v432-video-range-wechat-journey.test.mjs
```

- [x] **Step 2: Run the complete candidate regression once**

Risk addressed: `public-video-link.mjs` is shared by Feishu/WeChat and Bilibili/Douyin routing, so the full suite checks unrelated source gates, Task Sessions, Writer authorization, privacy, and single-mainline contracts remain unchanged.

```bash
npm test
```

- [x] **Step 3: Verify diff scope and hygiene**

```bash
git diff --check
git status --short
git diff -- src/personal-assistant/public-video-link.mjs \
  test/personal-assistant-public-video-link.test.mjs \
  test/v432-video-range-wechat-journey.test.mjs
```

Expected: only the approved parser, two regression tests, and local design/plan documents differ; no secrets, production state, task sources, logs, or user data are added.

- [x] **Step 4: Stop at the deployment gate**

Report the candidate evidence, remaining risk, rollback target, and exact production files. Do not restart the LaunchAgent, edit production, commit, or push without separate authorization.

## Execution result (2026-08-01)

- RED confirmed: the tracked mobile link returned `null`; unsafe mobile links were not rejected.
- GREEN confirmed: direct Bilibili/public-video contracts passed `26/26`.
- The WeChat longitudinal test failed with task status `failed` after temporarily removing the normalizer, then passed after restoring it; Source Intake, ASR evidence, timeline, one bounded interval, Outcome, and WeChat reply completed with Writer `0`.
- Focused shared-core compatibility passed `48/48`.
- Complete local candidate regression passed `622/622` outside the restricted sandbox. The restricted-sandbox run passed `621/622`; its only AVFoundation fixture failure reproduced as `Cannot Encode` in the sandbox and passed both alone and in the complete suite with normal local media permissions.
- The original retained screenshot message now normalizes to platform `bilibili`, exact canonical host `www.bilibili.com`, a valid BVID video path, and an empty tracking query.
- Before deployment, production parser SHA-256 was `0086509bc2941a8d5e4ab0368c68de9d01dc3350c1c48d5e524a0b958f5601c5`, equal to the V4.4.0 candidate parent; configuration, state, ASR ledger, Vault, and user data were not modified during candidate work.
- After separate owner authorization, the parser, two regression tests, and these two local design/plan documents were copied byte-for-byte into production. The deployed parser SHA-256 is `e849844fe89636df220518fa8e17da0750eeed232066fdfdea8d08a4dc75a76e`.
- Protected rollback point: `v441-bilibili-mobile-link-pre-deploy-20260801-SQYFxs` under the local protected baseline directory; all seven artifact hashes, sizes, and modes were verified and the restored pre-fix parser test passed `5/5` in a fresh temporary tree.
- The sole LaunchAgent was stopped and started once. Production-path focused verification passed `48/48`; the original retained message canonicalized correctly; heartbeat advanced; exactly one main process and one direct event-consumer child were present; no startup error was added.
- Production configuration, state, and ASR usage-ledger hashes remained unchanged across deployment. The owner later authorized publication; this fix is included in V4.4.3 together with the single-attempt Bilibili policy.
