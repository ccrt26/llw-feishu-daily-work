# V4.4.5 Bounded AI Timeout Candidate

Date: 2026-08-02

## Base and candidate commits

- V4.4.4 deployment-gate base: `a0f365e`.
- Branch: `fix/v445-personal-assistant-timeout`.
- Approved design: `afc2a10`.
- Implementation plan: `335331d`.
- Two-value configuration contract: `ea83afa`.
- Existing invoker ceiling contract: `2639ee5`.

## Root cause

The real Feishu cloud document passed user-identity export, V4.4.4 OOXML
safety inspection and Task Source retention. Codex then reached the locally
configured 120-second Personal Assistant deadline. The durable Outcome was
`failed/assistant_timeout`, already replied, with zero Writer calls and zero
knowledge writes. The source remains available for an ordinary same-task
retry.

The 120-second value is not a Feishu or Codex platform limit. It was one exact
historical configuration value. The existing invoker already validates a
hard upper bound of 300 seconds.

## Candidate behavior

- Configuration schema remains 7.
- `personalAssistant.aiTimeoutMs` accepts exactly 120,000 or 300,000 ms.
- V4.4.5 production configuration will use 300,000 ms.
- Values between the two approved values, above 300,000, below 120,000 or
  non-integers remain invalid.
- Invoice, knowledge-ingest and assistant-work timeouts remain 120,000 ms.
- `main.mjs` and `invoke-personal-assistant.mjs` are unchanged.
- The existing invoker still terminates a timed-out child and reports only
  `assistant_timeout`.
- There is no automatic retry and no dynamic timeout policy.

## Test evidence

- Unchanged configuration baseline: `11/11` PASS.
- RED: the new schema-7 contract failed only when saving 300,000 ms; the run
  was `10/11` with the intended `invalid_personal_assistant` failure.
- GREEN configuration contract: `12/12` PASS.
- Invoker plus production composition: `20/20` PASS.
- Focused configuration, invoker, Task Session, Writer/Outcome and Feishu
  journey set: `76/76` PASS.
- Complete restricted regression: `675/676`; the only failure was the known,
  unchanged AVFoundation synthetic-video `Cannot Encode` environment case.
- The exact unchanged media test passed `1/1` with normal local media
  permission. Effective complete regression: `676/676`.

## Changed-file boundary

V4.4.5 is limited to:

- `src/config.mjs`;
- `test/config.test.mjs`;
- `test/personal-assistant-invoker.test.mjs`;
- this version's design, plan, baseline, candidate report and README status.

V4.4.4 safety code, the exporter, Source Preparer, TaskSourceWorkspace,
Coordinator, Writer, Skill, manifest, state schema, permissions, models,
media gates and service topology are unchanged.

## Production and rollback status

V4.4.5 is not deployed. Production still runs system V4.4.3 with the V4.4.4
safety hotfix and `personalAssistant.aiTimeoutMs=120000`. Before switching,
an owner-only rollback point must capture the exact V4.4.4 component and
configuration and pass fresh-directory restore verification.

After deployment, the owner will send only `重试` in the same private Feishu
conversation. The original document must not be uploaded or exported again.
The system version changes only after the retained-source AI → Writer →
Outcome → reply journey and task cleanup both pass.

