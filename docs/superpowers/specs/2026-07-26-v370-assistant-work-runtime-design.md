# V3.7.0 Assistant Work Runtime Design

## Authority and scope

This design implements R4 batch four only: one `assistant-work` runtime, one
shared Task Session manager, a versioned working-draft workspace, bounded local
Markdown search, verified source paths, and continuation through the existing
Dispatcher and Router.

It does not implement file generation or file sending; those remain batch five.
It does not merge `main`, deploy, migrate the production configuration, restart
services, enable either V3.7.0 capability, or modify user documents.

The owner has also fixed the Office boundary:

- local interactive Office work prefers the installed WPS Office;
- Microsoft Office is not required;
- background Office preparation is deterministic and local;
- no WPS cloud service or AI document plugin is used;
- WPS is used for opening, editing, layout, compatibility, and later output
  acceptance where its public macOS interfaces permit it.

## Selected architecture

The runtime adds small modules rather than another service:

1. `TaskSessionManager` converts the one stored Task Session into the minimal
   Router conversation and owns create/update/close rules.
2. `KnowledgeSearch` searches only configured knowledge-library roots, only
   regular Markdown files, with file-count, byte, result, and total-excerpt
   limits. It rejects symlinks and returns Vault-relative verified paths.
3. `TaskWorkspace` stores `draft-vN.md` under one private session directory.
   It never overwrites a draft and verifies the expected base version.
4. `AssistantWorkDecision` validation mirrors private Skill version `1.1.0`,
   including `grounding_report` and verified source-path checks.
5. The existing read-only Codex job runner invokes only
   `llw-assistant-work`; no plugin, WPS AI, cloud document service, or second
   model is introduced.
6. `assistant-work` is registered only when both the public allowlist and
   candidate configuration explicitly enable it. Both remain false in this
   integration candidate.
7. The existing Dispatcher supplies the Task Session summary to the existing
   Router. The private Router decides whether a message is continuation or an
   independent new action. A new atomic action does not delete the open working
   draft.

## Session and model rules

- There is at most one open long-running Task Session.
- The session model is captured at creation and cannot change.
- Assistant Work `1.1.0` is Codex-only; a DeepSeek-started request receives a
  fixed refusal and no automatic model switch.
- `source_strict`, `hybrid`, and `creative` are explicit session values.
- Precise source requests default to `source_strict`; articles, plans, and
  presentations default to `hybrid`; explicit ideation defaults to `creative`.
- Recent turns are bounded and old turns are reduced to a deterministic task
  summary. Full drafts never enter StateStore.

## Source boundary

Search roots come only from the already configured knowledge libraries. Search
does not open the whole Vault, `.agents`, `.llw-system`, state, invoices, or
unconfigured directories.

Every source returned to the Skill is:

- a regular non-symlink Markdown file;
- beneath exactly one allowed library;
- represented by a verified Vault-relative POSIX path;
- read with a bounded size and excerpt budget.

The decision validator accepts only paths supplied by that search result. A
missing, conflicting, forged, absolute, or escaping path cannot reach state.

## Draft boundary

The workspace root is a private local state directory, not the Vault and not a
knowledge library. Each session directory contains only program-owned files:

```text
<workspace-root>/<session-id>/
  session.json
  draft-v1.md
  draft-v2.md
  sources.json
```

All writes are exclusive or atomic, modes are private, session IDs and
filenames are fixed by the program, and a version mismatch fails closed.

## Failure and rollback

Model, search, workspace, decision, and state failures return fixed bounded
messages and do not write long-term knowledge. Existing outcomes remain the
single persist-before-reply and reply-recovery mechanism.

Rollback is reverting the candidate commit. Production configuration and
services remain untouched, so there is no runtime migration to reverse in this
batch.

## Verification budget

Run the existing adjacent baseline once before edits. During development run
only new and directly affected tests. At phase completion run adjacent
Dispatcher/Router/state/config tests, then one complete public regression.
