# V3.0 Phase 3 Task 3.2 report

## Status

DONE — third-round structural guard remediation passed independent review

## Implementation

- Added a native Node.js DeepSeek text client for exactly `router.text` and `daily-work.interpret`. It makes one non-streaming `POST` to the fixed production endpoint `https://api.deepseek.com/chat/completions`, accepts only `deepseek-v4-flash` or `deepseek-v4-pro`, disables thinking, requests JSON-object output, and uses fixed request, response, token, and timeout bounds.
- Added a strict AI input guard that validates task-specific field allowlists and bounded collection sizes before Skill reads, Keychain access, or network access. It rejects credential material, secrets and verification codes, payment credentials, confidentiality markings, environment/log/Keychain exports, absolute POSIX/Windows/UNC paths, raw Feishu identifiers/resource keys, and unbounded bulk requests without echoing rejected content. Ordinary HTTP(S) URLs remain allowed.
- The API key is read only through `/usr/bin/security find-generic-password -w -s <service> -a <account>`. The client has no environment-variable, global base-URL, proxy, SDK, or arbitrary production endpoint path. Tests use an injected fake key reader and an explicit loopback-only endpoint.
- Each call reads the current task `SKILL.md` and `references/output-schema.json`, then reuses the existing `validateIntentDecision` or `validateAction` validator. Malformed, incomplete, oversized, timed-out, non-2xx, or schema-invalid responses fail with category-only errors and no retry or fallback.
- Wired Task 3.1's task model snapshot into the router and daily-work semantic-task boundaries. A DeepSeek snapshot calls only the DeepSeek client when enabled; Codex continues through its existing clients and behavior. A DeepSeek failure never invokes Codex and never writes business or model state.
- Kept `invoice.visual` out of DeepSeek. A valid attachment is treated as a new task using the current global effective model; DeepSeek returns the master-specified rejection before routing, download, model invocation, or archive/write work. Codex attachment handling remains unchanged, including when an older text conversation captured DeepSeek.
- Extended version-4 configuration with `deepseekModel`, `deepseekKeychainService`, and `deepseekKeychainAccount`. Deployed v4 files missing any connection field normalize to disabled safe defaults so the existing Codex service can start; strict saves require the complete structure. The existing v3-to-v4 migration writes the same disabled defaults without changing its version.

## Files

- Added: `src/ai/deepseek-client.mjs`, `src/ai/ai-input-guard.mjs`, `src/core/ai-failure.mjs`, `test/deepseek-client.test.mjs`, `test/ai-input-guard.test.mjs`, `test/fixtures/forbidden-ai-inputs.mjs`.
- Updated: `src/config.mjs`, `src/core/dispatcher.mjs`, `src/core/semantic-tasks.mjs`, `src/main.mjs`, `src/migrate-config-v4.mjs`, `src/service.mjs`, `test/config.test.mjs`, `test/dispatcher.test.mjs`, `test/main-composition.test.mjs`, `test/migrate-config-v4.test.mjs`, `test/privacy.test.mjs`, `test/semantic-tasks.test.mjs`, and `test/service.test.mjs`.
- Implementation commit: `302a016` (`feat: add guarded DeepSeek text tasks`).
- Final-review remediation commit: `28718d0` (`fix: enforce shared AI safety boundaries`).
- Forbidden-class remediation commit: `4785d13` (`fix: cover V3 forbidden input classes`).
- Structural guard remediation commit: `e1c2dca` (`fix: classify V3 forbidden input structurally`).

## TDD chronology

- Baseline: `/usr/local/bin/npm test` — 182 passed, 0 failed.
- Initial RED: the new focused contract tests produced 13 expected failures because the DeepSeek modules, connection fields, model-aware semantic branching, dispatcher forwarding, and main wiring did not yet exist.
- Initial GREEN: non-network focused tests passed 36/36; loopback fake-endpoint tests passed 16/16; the then-current full regression passed 205/205.
- Review fixes were each test-first: expanded guard aliases and path boundaries; deterministic invoice rejection; preservation of the Codex path; real daily-work validator coverage; request-size and malformed-input preflight; and attachment lifecycle tests in both stale-snapshot directions.
- Final URL-boundary RED: positive router/daily inputs containing `https://example.com/a` and `http://localhost/a` exposed the Windows-drive regex false positive (2/3 guard tests passed).
- Final URL-boundary GREEN: adding a start boundary to the drive-letter alternative made the guard suite pass 3/3 while existing `C:\\`, `Z:/`, POSIX, and UNC rejection cases remained covered.
- Second-review RED: explicit V3 class members such as `我的 API Key 是 sk-not-real`, `CVV 是 123`, and `内部资料不得外发` still reached both AI providers. A first independent adversarial generation then found 37 additional natural-language variants; a second generation found 33 leaks and two normal-text false positives; the frozen third generation reproduced 30 of 31 leaks plus one false positive before the final implementation changes.
- Second-review GREEN: all adversarial examples were consolidated into one shared six-category fixture and implemented with finite deterministic patterns. The final matrix contains 154 forbidden examples and 27 allowed conceptual, negated, or implementation-oriented examples, with 0 missed and 0 false-positive results in both Router and daily-work guards.
- Third-review RED: a new final review found six class-level leaks and two false positives. All six leaked through all four Codex/DeepSeek × Router/daily entry points, producing 24 AI calls; the DeepSeek paths also performed 12 Skill/Key/fetch operations, and the daily-work confidentiality example reached an AI call and one business write. The two safe statements were incorrectly rejected because a negated bulk action and a Keychain test discussion matched broad standalone patterns.
- Structural GREEN: the monolithic phrase list was replaced with six named, auditable co-occurrence classifiers. Each combines bounded term clusters with assignment/disclosure, material-presentation, confidentiality, quantity/action, or raw-system context. Negated actions and locally cancelled confidentiality assertions are scoped to their predicate, while an actual value or material presentation takes precedence over development text.
- A fixture-free independent adversarial pass then froze 30 new forbidden and 10 allowed probes. Its initial RED found 13 leaks and three false positives; after category-specific evidence and local-negation fixes, the unchanged set reached 30/30 rejected and 10/10 allowed. The repository matrix now contains 194 forbidden and 41 allowed examples with zero misses or false positives.

## Independent final-review remediation

- A fresh independent final review correctly returned Not ready after the initial implementation. It identified one Critical issue (the guard applied only to DeepSeek), two Important issues (daily output Schema constraints were not deterministically executed, and safe failure replies lost the V3 classifications), and one Minor issue (some malformed dates/collection elements leaked native errors).
- RED: the focused remediation suite failed 15 checks covering those findings.
- GREEN: the same focused area first passed 64/64, then expanded to 67/67 with direct zero-client/zero-Key/zero-network/zero-write and both-model reply-matrix evidence.
- The common guard now runs before either Codex or DeepSeek for both text tasks. It rejects `我的密码是 hunter2`, `短信验证码是 123456`, `银行卡是 4111 1111 1111 1111`, and `绝密项目资料` in both Router and daily-work paths. The prior test that allowed token/password text into Codex was removed and replaced with allowed-text compatibility checks.
- DeepSeek daily-work output is now recursively checked against every constraint kind used by the current Schema—object/array/string type, required fields, additional properties, enum, pattern, min/max length, max items, and array items—before the existing `validateAction` business validator runs. Schema-invalid output maps to `deepseek_output_invalid` and has explicit zero business/model-write coverage.
- Router and daily-work now preserve the V3 fixed sensitive-input and actual-model failure replies. Both Codex and DeepSeek variants are asserted end to end, including no automatic switch and no business/model write.
- Daily input preparation moved behind the safe guard boundary. Invalid finite dates and null capability/candidate/turn elements now map to `ai_input_rejected` before Skill, Keychain, or network work.
- A subsequent independent review returned Not ready because the four-example fix did not yet cover the six V3 forbidden classes at the natural-language class level; it also identified the report's prior Ready claim as stale. The review supplied adversarial examples, while implementation remained test-first and deterministic without adding DLP, dependencies, or another model call.
- The shared final fixture covers identity/access secrets, payment controls, identity documents and biometrics, explicit confidentiality/no-exfiltration constraints, unbounded bulk disclosure, and raw system/security material. It is exercised before either AI client for Codex/DeepSeek and Router/daily-work, and directly before DeepSeek Skill reads, Keychain reads, or network access.
- The final independent read-only re-review returned Ready with no Critical or Important findings. Its only Minor was this report update. It independently confirmed its frozen 31 forbidden/9 normal set at 31/31 rejected and 9/9 allowed, all four provider/task entries at zero AI calls, and the DeepSeek path at zero Skill, Key, and loopback-network access.
- A third independent review subsequently returned Not ready because the finite phrase enumeration remained brittle and caused both leaks and false positives. Remediation changed the implementation shape rather than adding sentence-level aliases: six category functions now evaluate term/context co-occurrence, local negation, and concrete-material priority using small data tables.
- The third final re-review did not read or import the repository fixture. It reran only its independently frozen 30 forbidden/10 allowed probes and returned Ready with no Critical, Important, or Minor findings. All four provider/task entries rejected 30/30 before either client; direct DeepSeek checks observed zero Skill traversal, fake-Key reads, loopback fetches, or request bodies; Dispatcher and daily-work checks observed zero AI, business, model, and conversation writes apart from the required rejected outcome and fixed reply.

## Verification

- Final full regression after remediation: `/usr/local/bin/npm test` — 224 passed, 0 failed (exit 0).
- Final focused side-effect suite: 67 passed, 0 failed (exit 0), including zero Router capability/model writes and zero daily-work create/supplement/conversation writes.
- Final forbidden-input matrix: 194 forbidden examples across exactly six V3 categories and 41 allowed counterexamples; 0 missed and 0 false positives for both text tasks.
- Final independent fixture-free review: Ready; 30/30 forbidden rejected, 10/10 normal examples allowed, and no Critical, Important, or Minor findings.
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

- None remaining after the third-round structural remediation. The deterministic co-occurrence guard covers the explicit V3 closed classes and tested natural-language combinations; it is not presented as a general-purpose DLP system. Production enablement and real credentials remain intentionally out of scope and require later explicit authorization and acceptance work.
