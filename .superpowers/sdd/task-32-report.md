# V3.2 Phase 3 Task 3.2 current report

## Status

LOCAL ACCEPTANCE COMPLETE — deterministic regression and the fixed real DeepSeek V4 Pro evaluation are green. Production rollback creation, commit/push, configuration change, restart and deployment have not been performed.

The former V3.0/V3.1 six-class natural-language guard, 194-case matrix and related `Ready` conclusions are historical and superseded by V3.2. They are not current product claims and must not be used as a deployment gate.

## Current V3.2 implementation

- The common AI text boundary still protects Codex and DeepSeek for exactly `router.text` and `daily-work.interpret`.
- Structural field allowlists, string/collection/byte limits, output Schema checks, existing business validators and zero-side-effect rejection paths remain in place.
- The input guard now detects only:
  - actual identity/authentication/access credentials, reported as `credential`;
  - actual payment/account-control credentials, reported as `payment`.
- The guard uses strong formats, named field values, obvious-placeholder handling and Luhn validation. It does not perform six-class semantic classification, sentence splitting, negation/transition analysis, wallet-seed detection, image/PDF scanning or secondary AI review.
- The closed fixture contains exactly 50 blocking and allowing examples.
- DeepSeek remains a direct Node.js HTTPS client with no SDK, dependency, automatic retry, fallback or model comparison.
- The only accepted, default and evaluated DeepSeek model is `deepseek-v4-pro`. Its official 1M context is provider capacity; the current text tasks retain the existing 128 KiB request and 4096-token output limits.
- Router and daily-work DeepSeek requests explicitly use non-thinking mode, `temperature: 0` and JSON-object output.
- The three formal Skills now state their fixed model reasoning settings: Router and daily-work use Codex `low` or DeepSeek V4 Pro non-thinking; invoice uses Codex `medium` and continues to prohibit DeepSeek. The semantic-task program fixes these settings, and user/model input cannot override them.
- A `cancelled` Router sentinel is preserved only when an active conversation exists. Without an active conversation it is deterministically normalized to a visible `当前没有待取消任务。` rejection.
- The formal `daily-work` Skill now states that a sole candidate is not proof of semantic match and that vague progress intent asks once for the concrete progress instead of silently ignoring or creating a low-information record.
- `tools/run-real-deepseek-evals.mjs` is a fixed 22-case runner over the formal Router and daily-work Skills. Its report excludes raw inputs, raw outputs and API key material.

## Preserved safety boundaries

- Guard rejection occurs before DeepSeek Skill reads, Keychain access and network requests.
- The common semantic-task guard runs before either Codex or DeepSeek client.
- DeepSeek errors never invoke Codex and never change model or business state.
- `invoice.visual` remains Codex-only and is explicitly rejected in DeepSeek mode before download or archive work.
- Version 4 production configuration without DeepSeek fields normalizes to `deepseekEnabled=false`.
- Production Codex paths, Feishu behavior, deterministic writers, Obsidian formats and archive rules are unchanged.

## Verification

- Focused RED/GREEN cycles were observed for:
  - missing `temperature: 0`;
  - cancellation without an active conversation;
  - formal Skill sole-candidate and vague-progress rules;
  - the versioned 22-case runner and its raw-data-free report.
- Current Phase 3 full regression: 239 passed, 0 failed.
- Current production-component regression against the revised formal Skill: 162 passed, 0 failed.
- All three formal Skill validations: passed.
- The runner's injected fake-client check: 22/22 passed without Keychain or network access.

These deterministic results are supplemented by the real evaluation below.

## Real evaluation evidence

The historical `deepseek-v4-flash` run produced 18/22 with a temporary Skill copy and non-fixed sampling. It remains diagnostic only and is not a V3.2 certification result.

After project-owner approval, the fixed formal 22 cases were evaluated through the direct HTTPS client with `deepseek-v4-pro`, non-thinking mode and `temperature: 0`:

- Initial V4 Pro run: 16/22. Four Router failures were request timeouts; the unchanged failure-only rerun showed all four passing, establishing transient latency rather than a stable semantic failure.
- Two stable semantic failures were investigated without changing model, mode, sampling, retry or architecture. One daily-work fixture contradicted the formal Skill by failing to identify the record it intended to supplement, so the fictional input was corrected. The Router new-task case exposed an overlapping model reason code; the program now deterministically normalizes cross-capability routing during an active conversation to `new_task`.
- Full rerun after the semantic corrections: 21/22. The remaining failure was the same Router reason-code overlap, while route, capability and confidence were already correct.
- After the validator normalization was implemented through a RED/GREEN cycle, a new complete run passed 22/22 in one run: Router 10/10 and daily-work 12/12.

The final report is `/private/tmp/llw-v32-real-deepseek-eval-report.json`, is mode 0600, and contains no raw input, raw output or API key material. The pre-normalization 21/22 report is preserved separately as diagnostic evidence.

## Remaining gates

1. Review and accept the local implementation and 22/22 real-evaluation evidence.
2. Obtain separate approval before commit/push or PR updates.
3. Before production deployment, create and isolation-restore the required fresh rollback point.
4. Obtain separate approval before configuration changes, restart or deployment.
5. End any approved production acceptance with model mode manually restored to `codex`.

## Production and rollback

- Production remains on commit `3788526`, Codex and version 4 configuration.
- Existing Phase 1 rollback evidence targets the older `b1bdb05` baseline.
- Before any Phase 3 production deployment, create and isolate-restore a fresh rollback point for current configuration/state, LaunchAgent, production component `3788526`, the three formal Skills and model state.
- End any approved production acceptance with model mode manually restored to `codex`.
