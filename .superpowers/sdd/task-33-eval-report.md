# Phase 3 Task 3.3 non-sensitive eval report

> V3.2 current note: this report records the historical construction of the fixed 10 Router and 12 daily-work cases. The final real evaluation now uses `deepseek-v4-pro`, the formal Skills, non-thinking mode and explicit `temperature: 0`, and passed 22/22 in one complete run: Router 10/10 and daily-work 12/12. The model's official 1M context capability does not change the current tasks' bounded inputs. The earlier 18/22 V4 Flash run remains diagnostic only. Statements below that no real model eval had run were true when this task report was written.

## Status

DONE AFTER TWO REVIEW REMEDIATIONS — Router and daily-work now have guard-valid, versioned non-sensitive eval inputs, stable exact expectations, and explicit human-scoring criteria where exact expectations cannot express the requirement. Both review rounds returned `REQUEST CHANGES` before remediation; the findings and RED/GREEN evidence are recorded below. No Codex or DeepSeek model eval was run, so this result does not establish model behavior, approve DeepSeek, accept Task 3.2, or open the Phase 3 enablement gate.

## Implementation

- Versioned 10 Router eval inputs, including seven new fictional, non-sensitive scenarios: safe invoice attachment metadata, invoice knowledge-question rejection, daily-work continuation, active-conversation cancellation, cancellation without an active conversation, an invoice attachment superseding active daily-work context as a new task, and an enabled-capability list that excludes daily-work.
- Versioned 12 daily-work eval inputs, including nine new fictional, non-sensitive scenarios: unique timed supplement, named target absent from the candidate whitelist, multi-turn clarified supplement with distinct current-source and prior-user-fact roles, active cancellation, Beijing-time `yesterday` across midnight, explicit-date precedence, two independent records, a knowledge question, and a vague fact requiring clarification.
- Strengthened the two component contract tests so every case passes the real `guardAiInput(task,input)`, every Router capability has the guard's exact six fields, every daily candidate has the guard's exact nine fields, and every new scenario has direct assertions for its key input semantics and candidate/conversation relationship.
- Replaced the unsupported derived expectation keys `reason_not` and `records_count` with existing semantics: inactive cancellation fixes only `action: unsupported`, while two independent work items use a two-element partial `expected.records` array. New daily date/time expectations now live under partial `expected.records[]` objects.
- Stopped fixing one full `original_text` string for the multi-turn supplement case. The eval fixes only the stable action, confidence, candidate target, and current `source_text`; the fixture contract test validates that prior user fact text exists in the conversation and that the selected target is in the candidate whitelist.
- Every Router capability object now deep-equals the corresponding canonical workspace `routing-contract.json` object. Cases that enable only invoice contain only that canonical invoice object.
- Added `manual_review_criteria` only to the inactive-cancellation and multi-turn-supplement cases. These strings are instructions for a human scorer in a future actual model eval; they are not model output fields, executable assertions, or an eval DSL.
- Did not change the three existing `SKILL.md` files, output Schemas, routing contracts, UI metadata, sensitive-input guard, source code, production configuration, or deployment artifacts.

## Files

Component Git:

- Updated `test/intent-routing-skill-contract.test.mjs`.
- Updated `test/daily-work-skill-contract.test.mjs`.
- Component test commit: `8baee97` (`test: expand non-sensitive skill eval contracts`).
- Review-remediation test commit: `6442896` (`test: validate skill evals through AI guard`).
- Second-review test commit: `31dcaad` (`test: pin eval contracts and review criteria`).

LLW workspace, outside the component Git repository:

- Updated `/Volumes/ZHUTONG/LLW的私人助手/LLW/.agents/skills/feishu-intent-router/evals/cases.jsonl`.
- Updated `/Volumes/ZHUTONG/LLW的私人助手/LLW/.agents/skills/feishu-daily-work/evals/cases.jsonl`.
- These eval files are persisted in the workspace and are not included in the component Git commits.

## TDD chronology

- Baseline attempt in the restricted sandbox: `/usr/local/bin/npm test` reported 202 passed and 22 failed because the sandbox rejected the fake DeepSeek server's local `127.0.0.1` listen with `EPERM`. No product assertion failed.
- Complete baseline rerun with permission for the loopback-only fake server: `/usr/local/bin/npm test` passed 224/224 with 0 failures.
- RED: changed only the two contract tests, then ran `node --test test/intent-routing-skill-contract.test.mjs test/daily-work-skill-contract.test.mjs`. Both tests failed as intended (0/2): one reported missing `router-positive-invoice-attachment`, the other missing `daily-positive-unique-timed-supplement`.
- GREEN: appended only the seven Router and nine daily-work JSONL cases. The unchanged focused command then passed 2/2.
- REFACTOR: made the outside-candidate assertion compare the requested title directly against the candidate whitelist. The focused command remained green at 2/2.
- First independent review: `REQUEST CHANGES`. The reviewer found that Router capability objects omitted `positive_examples` and `negative_examples`, daily candidates omitted six required fields, two expected keys invented an unevaluated DSL, the multi-turn case over-fixed one `original_text`, and the tests did not directly validate each scenario's key input semantics.
- Remediation RED: changed only the two contract tests to call the real guard for every eval and to require the corrected expected structures and scenario assertions. The focused command failed 0/2 with `ai_input_rejected`: `router-positive-daily-work` failed Router contract validation and `daily-boundary-ambiguous-supplement` failed candidate validation.
- Remediation GREEN: changed only the two workspace JSONL files. The same focused command passed 2/2, with all 10 Router and all 12 daily-work inputs accepted by the real guard.
- Second independent review: `REQUEST CHANGES`. The reviewer found that guard-valid Router capability objects still paraphrased the canonical routing contracts, that two non-exact requirements had no versioned human-scoring criteria, and that the Beijing send-date relationship was not calculated directly in the contract test.
- Second-remediation RED: changed only the two contract tests. The focused command failed 0/2: `router-positive-daily-work` differed from the canonical daily-work contract, and `daily-positive-multiturn-clarified-supplement` lacked its exact `manual_review_criteria` array. The direct `Intl.DateTimeFormat` Beijing-date assertions already passed.
- Second-remediation GREEN: copied canonical routing-contract objects into the Router JSONL and added only the two specified human-scoring arrays. The unchanged focused command passed 2/2.

## Verification

- Final focused contracts: 2 passed, 0 failed.
- Final full regression after the last test refactor: `/usr/local/bin/npm test` — 224 passed, 0 failed, exit 0.
- JSONL audit: Router has 10 cases and 10 unique IDs; daily-work has 12 cases and 12 unique IDs; all lines parse as JSON.
- Real-guard audit: 22/22 inputs pass `guardAiInput(task,input)`. Every Router case has only `message`, `conversation`, and `capabilities`; every capability has exactly `capability`, `purpose`, `accepts`, `positive_examples`, `negative_examples`, and `supports_continuation`. Every daily-work case has only `message`, `conversation`, and `candidates`; every candidate has exactly `record_id`, `date`, `occurred_time`, `occurred_end_time`, `title`, `people`, `location`, `summary`, and `follow_ups`. All capabilities/candidate lists contain at most 20 items.
- Canonical-contract audit: every Router capability object deep-equals the current daily-work or invoice `routing-contract.json`; enabled-only-invoice cases contain no daily-work object.
- Human-scoring metadata audit: exactly two cases have `manual_review_criteria`; all other case roots contain only `id`, `kind`, `task`, `input`, and `expected`. The optional metadata is not evaluated as model output.
- Beijing-date audit: `Intl.DateTimeFormat` with `Asia/Shanghai` converts both relative-date cases' `createTime` values to `2026-07-24`; `yesterday` expects `2026-07-23`, while explicit `7月21日` expects `2026-07-21`, which differs from the send date.
- Expectation audit confirmed there is no `reason_not`, `records_count`, or precisely fixed multi-turn `original_text` in either eval or contract test.
- Non-sensitive audit: the two eval files contain no matched Feishu identifiers, resource keys, local paths, API keys, tokens, or secret markers.
- `git diff --check` completed without output before the component test commit.
- Component range audit listed only the two intended contract tests and this report. Workspace content changes are limited to the two intended eval JSONL files; the external-volume filesystem also refreshed their existing AppleDouble `._cases.jsonl` metadata sidecars when the JSONL files were replaced.

## Safety and scope

- No real Keychain entry was read, created, changed, or deleted.
- No real DeepSeek request or external network request was made. Tests used only an injected local loopback fake endpoint.
- No model evaluation, model comparison, Provider, Registry, database, eval platform, fallback, auto-selection, deployment, restart, installation, configuration change, or push was performed.
- `deepseekEnabled` was not changed and the Task 3.3 enablement gate remains closed.
- `SYSTEM_MAP.md` and `.superpowers/sdd/progress.md` were not updated.
- The paused Task 3.2 sensitive-guard work was not modified or presented as accepted.

## Remaining gate

- Router and daily-work still require actual Codex/DeepSeek model eval execution and owner review before any manual DeepSeek enablement decision. No model output has been scored against either the stable `expected` fields or the human-review criteria in this task.
- Task 3.2 remains paused/unaccepted, so this report records only completion of the non-sensitive versioned eval materials and component fixture-contract validation.
