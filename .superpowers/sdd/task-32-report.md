# V3.0 Phase 3 Task 3.2 report

## Status

DONE

## Implementation

- Added a native Node.js DeepSeek text client for exactly `router.text` and `daily-work.interpret`. It makes one non-streaming `POST` to the fixed production endpoint `https://api.deepseek.com/chat/completions`, accepts only `deepseek-v4-flash` or `deepseek-v4-pro`, disables thinking, requests JSON-object output, and uses fixed request, response, token, and timeout bounds.
- Added a strict AI input guard that validates task-specific field allowlists and bounded collection sizes before Skill reads, Keychain access, or network access. It rejects credential material, secrets and verification codes, payment credentials, confidentiality markings, environment/log/Keychain exports, absolute POSIX/Windows/UNC paths, raw Feishu identifiers/resource keys, and unbounded bulk requests without echoing rejected content. Ordinary HTTP(S) URLs remain allowed.
- The API key is read only through `/usr/bin/security find-generic-password -w -s <service> -a <account>`. The client has no environment-variable, global base-URL, proxy, SDK, or arbitrary production endpoint path. Tests use an injected fake key reader and an explicit loopback-only endpoint.
- Each call reads the current task `SKILL.md` and `references/output-schema.json`, then reuses the existing `validateIntentDecision` or `validateAction` validator. Malformed, incomplete, oversized, timed-out, non-2xx, or schema-invalid responses fail with category-only errors and no retry or fallback.
- Wired Task 3.1's task model snapshot into the router and daily-work semantic-task boundaries. A DeepSeek snapshot calls only the DeepSeek client when enabled; Codex continues through its existing clients and behavior. A DeepSeek failure never invokes Codex and never writes business or model state.
- Kept `invoice.visual` out of DeepSeek. A valid attachment is treated as a new task using the current global effective model; DeepSeek returns the master-specified rejection before routing, download, model invocation, or archive/write work. Codex attachment handling remains unchanged, including when an older text conversation captured DeepSeek.
- Extended version-4 configuration with `deepseekModel`, `deepseekKeychainService`, and `deepseekKeychainAccount`. Deployed v4 files missing any connection field normalize to disabled safe defaults so the existing Codex service can start; strict saves require the complete structure. The existing v3-to-v4 migration writes the same disabled defaults without changing its version.

## Files

- Added: `src/ai/deepseek-client.mjs`, `src/ai/ai-input-guard.mjs`, `test/deepseek-client.test.mjs`, `test/ai-input-guard.test.mjs`.
- Updated: `src/config.mjs`, `src/core/dispatcher.mjs`, `src/core/semantic-tasks.mjs`, `src/main.mjs`, `src/migrate-config-v4.mjs`, `test/config.test.mjs`, `test/dispatcher.test.mjs`, `test/main-composition.test.mjs`, `test/migrate-config-v4.test.mjs`, `test/privacy.test.mjs`, `test/semantic-tasks.test.mjs`, and `test/service.test.mjs`.
- Implementation commit: `302a016` (`feat: add guarded DeepSeek text tasks`).

## TDD chronology

- Baseline: `/usr/local/bin/npm test` — 182 passed, 0 failed.
- Initial RED: the new focused contract tests produced 13 expected failures because the DeepSeek modules, connection fields, model-aware semantic branching, dispatcher forwarding, and main wiring did not yet exist.
- Initial GREEN: non-network focused tests passed 36/36; loopback fake-endpoint tests passed 16/16; the then-current full regression passed 205/205.
- Review fixes were each test-first: expanded guard aliases and path boundaries; deterministic invoice rejection; preservation of the Codex path; real daily-work validator coverage; request-size and malformed-input preflight; and attachment lifecycle tests in both stale-snapshot directions.
- Final URL-boundary RED: positive router/daily inputs containing `https://example.com/a` and `http://localhost/a` exposed the Windows-drive regex false positive (2/3 guard tests passed).
- Final URL-boundary GREEN: adding a start boundary to the drive-letter alternative made the guard suite pass 3/3 while existing `C:\\`, `Z:/`, POSIX, and UNC rejection cases remained covered.

## Verification

- Final full regression: `/usr/local/bin/npm test` — 212 passed, 0 failed (exit 0).
- Final independent review: Ready; no remaining Critical or Important findings. Reviewer-focused guard/config/dispatcher/semantic/privacy tests passed 40/40 and loopback DeepSeek tests passed 18/18.
- `node --check` passed for every added or changed source module.
- `git diff --check` completed without output.
- `/usr/local/bin/npm ls --depth=0` reported no dependencies.
- Boundary audit confirmed the production endpoint occurs only as the fixed client constant; no DeepSeek/OpenAI model or base-URL environment hook was introduced.
- Boundary audit confirmed no changes to `package.json`, `package-lock.json`, `deploy/`, or `.superpowers/sdd/progress.md`.

## Safety and scope

- No real DeepSeek request was made. Network tests used only a local loopback fake endpoint.
- No real Keychain entry was read, created, migrated, or deleted; tests injected fake key readers and fake keys.
- No production `config.json`, model state, Obsidian data, service, LaunchAgent, shell/profile, local executable, dependency, or deployment artifact was changed.
- No fallback, auto-selection, hybrid/compare mode, proxy, SDK, new provider, new process, push, deployment, installation, or restart was performed.
- DeepSeek remains disabled by default. Rollback is `deepseekEnabled=false` with model mode `codex`, or reverting implementation commit `302a016`; there is no data or Obsidian migration.

## Concerns

- None for Task 3.2. Production enablement and real credentials remain intentionally out of scope and require later explicit authorization and acceptance work.
