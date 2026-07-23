# V3.0 Phase 3 Task 3.3 fixed failure-gate report

## Status

DONE AS CHARACTERIZATION GREEN — the existing Dispatcher and StateStore implementation already satisfies the two non-sensitive failure gates in this subtask. Two deterministic regression tests were added to `test/dispatcher.test.mjs`; no production code was changed.

This report does not accept the paused Task 3.2 sensitive-input-guard work, enable DeepSeek, or open the Phase 3 gate.

## Added evidence

### DeepSeek failure does not affect a later manually selected Codex task

The test `a DeepSeek failure leaves the next Codex task independent after an explicit manual switch` proves that:

- the initial persisted mode is DeepSeek;
- a Router exception is classified as a DeepSeek failure;
- the failed task invokes no capability, performs no business write, and performs no model-mode write or automatic switch;
- only the exact `/llw-model codex` command writes the model once;
- the following new task snapshots Codex, invokes Router once for that task, invokes only `daily-work` once, and commits one successful business result;
- the observed mode-read sequence is `deepseek`, then `codex`, so the success is an independent new task after an owner-style manual switch rather than automatic fallback.

### A replied outcome suppresses duplicate processing after restart

The test `a replied outcome suppresses the same raw message after StateStore and Dispatcher restart` proves that:

- the first Dispatcher handles and replies to one message successfully;
- the state file contains the message outcome with `status: committed` and `replied: true`;
- a new `StateStore.open` reads the same state file and a fresh Dispatcher is constructed with fresh spies;
- redelivery of an exact clone of the original raw message returns the existing duplicate result;
- the recovered outcome remains present and has no pending reply;
- the new Router, both capability handlers, messenger, and both model-mode operations receive zero calls.

## Characterization chronology

- Baseline before modification: `node --test test/dispatcher.test.mjs` — 22 passed, 0 failed.
- Added only the two requested tests and the `readFile` test import through `apply_patch`.
- First isolated run: `node --test --test-name-pattern='DeepSeek failure|replied outcome' test/dispatcher.test.mjs` — 2 passed, 0 failed. Because the brief explicitly requested characterization tests when the existing implementation already satisfies the behavior, no artificial RED or production change was introduced.
- Focused suite: `node --test test/dispatcher.test.mjs` — 24 passed, 0 failed.
- First full-suite run inside the restricted sandbox: 204 passed and 22 failed only because the sandbox denied the test fake server's `listen 127.0.0.1` with `EPERM`; no product assertion failed.
- Full-suite rerun with permission for the loopback-only fake endpoint: `/usr/local/bin/npm test` — 226 passed, 0 failed, exit 0.

## Independent review

An independent read-only reviewer found no Critical, Important, or Minor issues and returned `Ready to merge: Yes`. The review specifically confirmed the failure/manual-switch sequence, fresh StateStore and Dispatcher restart boundary, persisted replied outcome, zero downstream calls on redelivery, deterministic inputs, and exact change scope.

## Scope and safety

- Changed only `test/dispatcher.test.mjs` and this report.
- Did not modify production source, the sensitive-input guard, workspace evals or Skills, configuration, `SYSTEM_MAP.md`, or progress files.
- Did not read or modify Keychain, contact real DeepSeek, access the external network, run model evals, deploy, restart services, install anything, or push.
- The full-suite network permission was used only for the existing test-local `127.0.0.1` fake DeepSeek server.
- V3 §10.3 item 5 remains deferred to Phase 4. Item 6 remains paused by owner instruction. The Phase 3 gate remains closed because Task 3.2 is paused/unaccepted.
