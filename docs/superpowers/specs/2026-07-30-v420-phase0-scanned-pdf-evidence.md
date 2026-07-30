# V4.2.0 Phase 0 Scanned-PDF Evidence

**Date:** 2026-07-30
**Status:** Candidate and production WeChat acceptance passed

## Scope

This report covers the isolated V4.2.0 candidate, the protected production
deployment, the PDF-only hotfix, and the completed WeChat acceptance. It does
not authorize a Git commit, push, later media gate, credential, runtime
installation, permission expansion, or API cost.

The fixture is synthetic, contains one raster-only page, has no searchable
text layer, and contains no user or platform data. The isolated run did not
use WeChat, Feishu, production state, a Writer, or a user file. The production
run used WeChat only as the real entry and retained no message text in this
report.

## Deterministic harness

Command:

```text
/usr/local/bin/node --test test/v420-scanned-pdf-smoke.test.mjs
```

Fresh result: `4/4` passed.

The harness rejected:

- a text-layer PDF advertised as the scan fixture;
- a model timeout above 120,000 ms;
- zero model-image evidence;
- a non-zero Writer count;
- any extra report field capable of carrying a path, source content, prompt
  content, or platform identifier.

## Local-only real PDFium evidence

The protected existing PDFium runtime processed the frozen fixture through
the generic `TaskPdfReader`. A local deterministic provider stub replaced
Codex, so these fields prove source binding, no-text-layer detection, page
rendering, model-image argument construction, and zero Writer only:

```json
{
  "sourceSha256": "9e041f0814412510771700af4af449d751c1fab883683261eef153ea4b778882",
  "pageCount": 1,
  "pageImageSha256": "f65c1a27dd94a0707b1dd502c750c30fb31f0b4003ec8032726ebb3fb0675584",
  "codexImageCount": 1,
  "elapsedMs": 752,
  "outcomeStatus": "reply",
  "writerCalls": 0,
  "diagnosticCode": null
}
```

Here `codexImageCount` is the number of validated image arguments presented
to the injected local provider. It is not evidence that the external Codex
service received or understood the image.

## Real Codex evidence

The initial candidate attempt reached the fixed Codex child process after
PDFium preparation, but the maintenance sandbox prevented Codex from opening
its local state database and in-process app-server client. The owner then
explicitly approved one external call containing only the synthetic fixture,
the current `llw-personal-assistant` runtime Skill bundle, and the instruction
`先总结，不保存`.

The approved retry used the fixed existing Codex CLI and local
authentication, with a 120,000 ms model timeout. It returned one valid direct
reply:

```json
{
  "sourceSha256": "9e041f0814412510771700af4af449d751c1fab883683261eef153ea4b778882",
  "pageCount": 1,
  "pageImageSha256": "f65c1a27dd94a0707b1dd502c750c30fb31f0b4003ec8032726ebb3fb0675584",
  "codexImageCount": 1,
  "elapsedMs": 29127,
  "outcomeStatus": "reply",
  "writerCalls": 0,
  "diagnosticCode": null
}
```

No response content, prompt body, absolute path, credential, user content, or
platform identifier was retained in this report. No Writer, production
state, permission, deployment, commit, or push was changed.

## Shared-core candidate gate

This phase changes shared Skill loading, failure propagation,
`TaskSourceWorkspace`, model image input, configuration validation, and the
Personal Assistant coordinator. One complete candidate regression was
therefore meaningful for detecting cross-capability breakage that the focused
PDF tests cannot exclude. It was run once as a candidate gate, not repeated
after every local edit.

The first sandboxed run exposed 27 failures: 26 local fake-DeepSeek tests could
not bind their loopback listener in the maintenance sandbox, and one WeChat
test still expected the historical generic media reason. The WeChat
expectation was corrected to the intended default-off V4.2.0 audio gate. The
DeepSeek tests then passed `27/27` outside that loopback restriction, without
calling a real provider. The first complete candidate gate passed:

```text
tests 741
pass 741
fail 0
```

After that single full gate, the frozen WeChat-shaped vertical candidate set
passed `9/9`. It covered:

- scanned PDF direct reply with zero Writer;
- scanned PDF timeout and same-source retry;
- ordinary daily-work handling through the shared queue;
- image-invoice eligibility and Writer contract;
- knowledge save from ordinary DOCX/PDF sources;
- document generation;
- DeepSeek plain text allowed and file input rejected;
- all six media/web gates stopping before download, AI, or Writer.

A final targeted source-workspace test passed `9/9` after a formatting-only
indentation correction.

## Production deployment and PDF-only hotfix

Before deployment, a protected rollback bundle captured the exact V4.1.0
component and Skills Git baselines, configuration, version-4 state contract,
model and WeChat state, LaunchAgent, PDFium facts, file manifests, and restore
evidence. A fresh isolated restore matched hashes, modes, commits,
configuration, state, and PDFium 5.11.0; the restored component passed
`675/675`.

The production switch staged and hash-verified 42 files, migrated configuration
from version 6 to version 7 with all six later-media gates `false`, preserved
state bytes, and restarted the one existing LaunchAgent. A separate
pre-switch state snapshot was retained.

The first clean production PDF-only journey exposed a missed R2 requirement:
the Coordinator prepared PDF evidence only when the immediate instruction was
non-empty. It therefore passed PDF metadata without page images to Codex and
hit the fixed 120-second model timeout. The source and task remained retained,
and no Writer ran.

A failing journey test first reproduced the defect by requiring the initial
PDF-only stage to contain the source observation and ordered page images.
The minimal fix runs the existing PDF reader regardless of whether
`instructionText` is empty. The focused test passed `1/1`; the affected
PDF/Coordinator set passed `18/18`. Because the fix changed the shared
Coordinator after the first full gate, one second and final complete candidate
regression was meaningful for excluding cross-capability regressions and
passed `741/741`. No further complete regression was run.

A protected pre-hotfix rollback bundle was created before atomically deploying
the two-file fix. Production focused verification passed, state bytes remained
unchanged, and the retained one-source WeChat task survived the restart.

## Production WeChat acceptance

The same frozen source then continued in the existing WeChat task with a
direct-summary, no-save instruction. Bottom-layer verification recorded:

```json
{
  "originalSha256": "9e041f0814412510771700af4af449d751c1fab883683261eef153ea4b778882",
  "originalMatchesFrozenFixture": true,
  "pageCount": 1,
  "textAvailable": false,
  "coverageStatus": "complete",
  "pageImageSha256": "f65c1a27dd94a0707b1dd502c750c30fb31f0b4003ec8032726ebb3fb0675584",
  "pageHashMatchesIndex": true,
  "sidecarOriginalMatches": true,
  "producedBy": "pypdfium2-5.11.0",
  "outcomeStatus": "committed",
  "replied": true,
  "artifactCount": 0,
  "replyFileCount": 0,
  "writerCount": 0
}
```

No reply content, platform identifier, credential, absolute source path, or
user data is retained here. The owner explicitly ended the test task.
Post-cleanup verification found the WeChat Task Session and compatibility
conversation slots null, the task-source workspace absent, and the latest
Outcome committed and replied with zero artifacts and no Writer field.

The existing LaunchAgent remained running with one Node main process and one
direct `lark-cli` event consumer; heartbeat continued advancing, the effective
model remained Codex, and all six later-media gates remained false. No Feishu
business-message test was repeated because this change did not alter a
Feishu-specific permission, resource-download, or message-field contract.

## Phase-0 boundary decision

The owner has no separate OpenAI API credential and intends to use only the
current Codex subscription. That subscription is not treated as an
independent transcription API credential or billing authorization. Phase 0
therefore adds no transcription adapter, reads no credential, incurs no API
cost, and installs no media runtime. Native voice, audio files, local video,
web pages, Bilibili, and Douyin remain exact-schema gates fixed to `false`.

The deployed Phase-0 change adds no media Router, second Agent, fifth side-effect
tool, extra event consumer, automatic DeepSeek expansion, downloader,
third-party video-understanding model, credential, installation action, or
new permission. Production is running the verified working tree based on the
approved V4.1.0 Git commit; the V4.2.0 changes remain uncommitted and unpushed
pending a separate Git authorization.
