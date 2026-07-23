# V3.2 Phase 3 Task 3.2 current report

## Status

PHASE 3 PRODUCTION ACCEPTANCE COMPLETE — deterministic regression, the fixed real DeepSeek V4 Pro evaluation, protected rollback drill, production deployment and bounded Feishu acceptance are green. Production is intentionally left in Codex mode.

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
- The Feishu boundary accepts exactly the legacy `![Image](img_...)` marker and the current lark-cli 1.0.68 `[Image: img_...]` marker. Both remain full-string matches with the same bounded resource-key grammar.
- Version 4 production configuration without DeepSeek fields normalizes to `deepseekEnabled=false`.
- Production Codex paths, Feishu behavior, deterministic writers, Obsidian formats and archive rules are unchanged.

## Verification

- Focused RED/GREEN cycles were observed for:
  - missing `temperature: 0`;
  - cancellation without an active conversation;
  - formal Skill sole-candidate and vague-progress rules;
  - the versioned 22-case runner and its raw-data-free report.
- Current Phase 3 and production-component full regression: 240 passed, 0 failed.
- All three formal Skill validations: passed.
- The runner's injected fake-client check: 22/22 passed without Keychain or network access.
- The current lark-cli image marker fix was developed with a failing reproduction first: the focused suite failed 2/28 before the parser change and passed 28/28 after it.

These deterministic results are supplemented by the real evaluation below.

## Real evaluation evidence

The historical `deepseek-v4-flash` run produced 18/22 with a temporary Skill copy and non-fixed sampling. It remains diagnostic only and is not a V3.2 certification result.

After project-owner approval, the fixed formal 22 cases were evaluated through the direct HTTPS client with `deepseek-v4-pro`, non-thinking mode and `temperature: 0`:

- Initial V4 Pro run: 16/22. Four Router failures were request timeouts; the unchanged failure-only rerun showed all four passing, establishing transient latency rather than a stable semantic failure.
- Two stable semantic failures were investigated without changing model, mode, sampling, retry or architecture. One daily-work fixture contradicted the formal Skill by failing to identify the record it intended to supplement, so the fictional input was corrected. The Router new-task case exposed an overlapping model reason code; the program now deterministically normalizes cross-capability routing during an active conversation to `new_task`.
- Full rerun after the semantic corrections: 21/22. The remaining failure was the same Router reason-code overlap, while route, capability and confidence were already correct.
- After the validator normalization was implemented through a RED/GREEN cycle, a new complete run passed 22/22 in one run: Router 10/10 and daily-work 12/12.

The final report is `/private/tmp/llw-v32-real-deepseek-eval-report.json`, is mode 0600, and contains no raw input, raw output or API key material. The pre-normalization 21/22 report is preserved separately as diagnostic evidence.

## Production acceptance evidence

- The protected pre-deployment rollback point is `~/Library/Application Support/LLW Assistant/backups/baselines/v3-phase-3-pre-deploy-2026-07-24/`. Its component, three-Skill, configuration/state, LaunchAgent and model-state semantics were restored and verified in a fresh `/private/tmp` directory before deployment.
- Production configuration remains version 4, stores the five fixed model fields with mode 0600, enables the approved DeepSeek capability and fixes the model to `deepseek-v4-pro`.
- Keychain retrieval was verified without printing or persisting the key.
- Feishu acceptance exercised exact status/switch commands, Codex and DeepSeek daily-work clarification, deterministic silent cancellation and the DeepSeek invoice boundary.
- The first image attempt exposed a real lark-cli 1.0.68 marker compatibility gap. Commit `7837454` added only the second exact marker form plus regression coverage; it was pushed, deployed by fast-forward and retested.
- The post-fix image outcome is `invoice/rejected`, replied, has zero artifacts and did not increase the existing invoice transaction count. It therefore performed no model call, download, archive or Obsidian write.
- Final Feishu commands restored and confirmed Codex. The LaunchAgent has one Node.js main process and one direct lark-cli event child, a fresh heartbeat and no new stderr entry.

## Remaining gates

- No Phase 3 production gate remains.
- Draft PR #2 still carries the component branch for later repository integration; merging it is not part of the production acceptance performed here.

## Production and rollback

- Production runs commit `7837454` on local branch `production/v3-deepseek-manual-mode`, with the source branch `agent/v3-deepseek-manual-mode` synchronized to GitHub.
- Effective model is Codex and switching remains manual only; there is no automatic selection, fallback or retry to another model.
- The Phase 3 protected rollback baseline restores production component `3788526`, the three formal Skills at `181cdd5`, version 4 protected state and effective Codex with DeepSeek disabled.
