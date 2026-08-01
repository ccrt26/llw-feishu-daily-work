# V4.3.1 Processing Receipt Candidate Report

## User Goal

This local candidate solves one user-visible problem: a genuinely accepted long
public-video task must not appear frozen while ASR and timeline preparation are
running.

It sends exactly one `已收到，正在处理。` receipt for the active task, while
preserving the existing final reply, Writer authorization, recovery, safety, and
quota contracts.

## Scope

The candidate:

1. Signals processing only after input validation, protected credential access,
   ASR quota reservation, and provider acceptance.
2. Also signals before a required timeline build when a durable transcript is
   already available.
3. Persists a separate once-only receipt-attempt marker before sending.
4. Keeps that marker outside the final Outcome, so it neither consumes nor
   replaces the final reply.
5. Makes receipt callback, persistence, or send failure non-fatal to the actual
   task.
6. Activates the matching component and private-Skill contract as V4.3.1.

Invalid media, missing credentials, exhausted quota, rejected provider
submission, and already-complete evidence do not generate this receipt.

Real interval source reading, partial-ASR semantics, legacy removal, and
configuration-range changes are not part of this candidate.

## Exact Bases and Candidate Commits

- Component base: `7a3a6089be81964d4d7ef9621a3f78929fe26438`
- Verified component runtime candidate:
  `327c82698993df7f49aba6f4dd55e9c7f39f86f5`
- Component branch: `agent/v431-processing-receipt`
- Skills base: `25dd530c6248a7b0c3571471a460b5fd88eee87c`
- Skills candidate: `a7d26e6cb8df750e3b028e3fce7ed6a5d7e8582f`
- Skills branch: `agent/v431-processing-receipt-skill`
- Candidate `manifest.json` SHA-256:
  `c8addab18c2f4f45c213f64c0e5505329eca6c686556db0553e9061fbde1cdf3`

Component implementation commits:

- `c4e871f` — persist one processing receipt attempt
- `a83db34` — signal accepted long video processing
- `43306e3` — send one accepted-task processing receipt
- `327c826` — activate the V4.3.1 component contract

## Test-Driven Evidence

### Durable once-only marker

- RED: StateStore and Task Session Manager tests failed because no receipt slot
  or reservation method existed.
- GREEN: the first matching active-task reservation succeeds and a duplicate
  reservation returns false, including after process restart.
- Existing version-4 state receives an empty
  `processingReceiptAttempts:{feishu:null,wechat:null}` slot without changing
  the state version.
- Closing, replacing, expiring, or cancelling a task clears its marker.

### Accepted-work ordering

- RED: the expected accepted event was absent and non-function callbacks were
  not rejected.
- GREEN: the callback occurs after quota reservation and provider acceptance,
  before polling.
- Quota rejection reaches neither the callback nor the provider.
- Callback failure does not alter the successful ASR result.
- Reader-level duplicate signals are collapsed to one attempt per preparation.

### Coordinator and WeChat vertical journey

- The receipt is sent with idempotency key `processing:<taskId>`.
- It has no Outcome and does not call `markReplied`.
- Receipt-send failure still permits the final reply.
- First WeChat video-summary turn sends one processing receipt and one final
  summary with zero Writer calls.
- A later save instruction in the same task adds the final save reply and one
  Writer call, while the processing-receipt count remains exactly one.

## Verification

- Initial directly affected baseline: `124/124` PASS.
- Version and manifest contract: `25/25` PASS.
- Final focused affected-chain regression: `143/143` PASS.
- Initial sandboxed full run: `859/884` PASS; all 25 failures were
  environmental:
  - 24 tests could not listen on the local loopback interface (`EPERM`).
  - 1 native video fixture could not invoke the system encoder.
- Minimal unrestricted diagnosis of those exact failures: `28/28` PASS.
- Final unrestricted full component regression: `884/884` PASS.
- External APIs called: zero. Loopback fake servers and synthetic local
  fixtures only.

## Changed-File Allowlist

Component changes are limited to:

- one baseline evidence document and this candidate report;
- StateStore and Task Session Manager receipt-attempt persistence;
- public-video ASR accepted callback and reader bridge;
- Coordinator receipt send;
- V4.3.1 main composition/version wiring;
- directly related state, manager, ASR, reader, Coordinator, composition,
  contract, and WeChat journey tests.

The private Skills candidate changes only `manifest.json`, and only the
`llw-personal-assistant` version from V4.3.0 to V4.3.1. Runtime Skill files and
their recorded hashes are unchanged.

## Rollback

Rollback is the exact pre-candidate pair:

- Component: `7a3a6089be81964d4d7ef9621a3f78929fe26438`
- Skills: `25dd530c6248a7b0c3571471a460b5fd88eee87c`

No parallel implementation or new production dependency was added.

## Production Status

**Not deployed.**

This work modified no production component, production Skill, configuration,
service, permission, credential, external API, or user data. Deployment,
configuration-hash update, service restart, and a real-entry production smoke
require explicit owner confirmation.
