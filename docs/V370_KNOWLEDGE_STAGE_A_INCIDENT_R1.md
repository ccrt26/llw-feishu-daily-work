# V3.7.0 Knowledge Ingest Stage A Incident — R1

## Status

- Production capability `knowledge-ingest` remains enabled for the bounded
  Stage A acceptance window, but production has not yet received the managed-root
  writer fix described below.
- `assistant-work` remains disabled.
- The existing service remains healthy and has no unreplied outcomes.
- No knowledge artifact was created by any failed attempt.

This report is intentionally sanitized. It contains no message body, platform
identifier, credential, private library content, or machine-specific private
path.

## Reproduction

1. Enable only the V3.7.0 `knowledge-ingest` candidate.
2. Restart the existing single LaunchAgent.
3. Send one bound private Feishu text with:
   - explicit save intent;
   - explicit personal-library target;
   - short synthetic content.
4. The Router selects `knowledge-ingest`.
5. The user receives the fixed technical failure receipt:
   `知识资料处理失败，本次未写入或创建目录；请稍后重试。`

The behavior reproduced twice with two distinct Feishu messages.

## Persisted evidence

For both attempts:

- outcome capability: `knowledge-ingest`;
- outcome status: `failed`;
- reply persisted and sent: yes;
- artifact count: zero;
- pending file request: false;
- unreplied outcome count after processing: zero;
- no recent `knowledge.md` artifact exists in either managed library;
- service heartbeat continued to advance.

The failure receipt can be returned by
`src/capabilities/knowledge-ingest/capability.mjs` when any exception occurs in
one of these stages:

1. direct-text source preparation;
2. managed-library catalog construction;
3. Codex decision-client execution or decision validation;
4. deterministic knowledge writer commit.

The current catch boundary deliberately hides the internal error, so the
persisted production outcome does not distinguish these stages.

## Confirmed production defect and fix

The formal private Skills repository is stored on a macOS external volume.
macOS created AppleDouble metadata entries such as `._output-schema.json`.

Before commit `2c8e685`, both:

- `src/capabilities/knowledge-ingest/decision-client.mjs`
- `src/capabilities/assistant-work/decision-client.mjs`

rejected every hidden entry while copying a selected Skill into a private
ephemeral job. This caused `knowledge_decision_failed` before Codex could run.

Commit `2c8e685` adds a narrow exception for `._*`, matching the existing
formal-manifest discovery rule. Arbitrary other hidden entries remain rejected.
Two regression tests were written first and observed failing, then passing.

Validation after the fix:

- targeted decision-client tests: 7/7 passed;
- complete local deterministic regression: 459/459 passed;
- no test invoked a real model or external API.

## Evidence that the first fix was insufficient

After deploying `2c8e685`, enabling only `knowledge-ingest`, restarting the
same service, and resending the synthetic acceptance request, the exact same
safe technical failure occurred. The second outcome was again replied,
`failed`, and contained zero artifacts.

Therefore AppleDouble rejection was a real production defect, but at least one
additional production-only failure remains.

## Boundaries already checked

The managed-library catalog was inspected read-only:

| Check | Work library | Personal library |
|---|---:|---:|
| Directories within five-level scan | 13 | 1 |
| Maximum observed depth | 3 | 1 |
| Symlinks | 0 | 0 |
| Invalid directory names | 0 | 0 |
| Ownership or canonical-path mismatch | 0 | 0 |
| 256-folder limit exceeded | no | no |

Additional checks:

- runtime config is version 5;
- `knowledge-ingest` was true during each attempt and is now false;
- `assistant-work` stayed false;
- the protected Codex executable exists and reports its expected version;
- formal selected-Skill files are owned by the service user and have no
  group/other permission bits;
- the knowledge job root is a private owned directory;
- no staging item, published item, or recent knowledge artifact was left behind.

## Final stage evidence and root cause

The value-free stage diagnostics were implemented and deployed. A direct
Codex-only reproduction first identified an output-Schema compatibility issue
in the private Skill. The Schema was flattened without weakening the Node.js
cross-field or path validator, and the repaired private Skill decision then
succeeded.

The next bounded acceptance produced two independent outcomes:

| Entry | Capability | Outcome | Reply | Artifacts | Safe stage |
|---|---|---|---:|---:|---|
| Feishu | `knowledge-ingest` | `failed` | yes | 0 | `knowledge_writer_failed` |
| WeChat | `knowledge-ingest` | `failed` | yes | 0 | `knowledge_writer_failed` |

This excludes entry-specific listening, binding and routing as the remaining
cause. Read-only checks also confirmed valid Vault identity, managed-library
identity, ownership, canonical paths and directory-sync support.

The private Skill contract represents the selected managed root as
`folder_plan.mode="use_existing"` with an empty `segments` array. The decision
validator accepts this exact root plan. `KnowledgeWriter.commit`, however,
reused the folder-creation validator, which required at least one segment and
rejected the valid root plan before filesystem access.

An isolated boundary reproduction confirmed:

- decision validator accepts the root plan;
- writer rejects the same plan as `knowledge_write_rejected`;
- no filesystem operation is reached.

## Scoped fix

The writer now has one explicit `allowRoot` validation option:

- `commit` allows an empty segment array, meaning the already-selected managed
  library root;
- `createFolder` retains the non-empty requirement;
- the five-segment bound, segment-name rules, containment, ownership, symlink,
  atomic publication, idempotency and write-after-verify rules are unchanged.

TDD evidence:

- the new real Writer test first failed with `knowledge_write_rejected`;
- after the two-line scoped production change, Writer tests passed 10/10;
- knowledge capability and writer target tests passed 26/26;
- the complete integration regression passed 463/463.

The code evidence above is not a production-acceptance claim. Production
deployment and one real Feishu plus one real WeChat root-library acceptance
remain required.

## Relevant files

- `src/capabilities/knowledge-ingest/capability.mjs`
- `src/capabilities/knowledge-ingest/decision-client.mjs`
- `src/capabilities/knowledge-ingest/source-preparer.mjs`
- `src/capabilities/knowledge-ingest/library-catalog.mjs`
- `src/capabilities/knowledge-ingest/knowledge-writer.mjs`
- `src/capabilities/knowledge-ingest/decision-validator.mjs`
- `src/core/dispatcher.mjs`
- `src/main.mjs`
- `test/knowledge-decision-client.test.mjs`
- `test/knowledge-ingest-capability.test.mjs`
