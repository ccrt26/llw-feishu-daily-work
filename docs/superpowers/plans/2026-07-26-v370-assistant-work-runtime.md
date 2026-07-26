# V3.7.0 Assistant Work Runtime Implementation Plan

## Goal

Implement R4 batch four as a disabled, reversible public candidate without
changing production behavior.

## Constraints

- Follow the R4 authority and the approved runtime design.
- Use the existing Dispatcher, Router, StateStore, private Skill loader, and
  outcome recovery.
- Keep `knowledge-ingest` and `assistant-work` doubly disabled.
- Do not implement file generation or file sending in this batch.
- Do not deploy, migrate production configuration, restart, merge, or edit user
  data.
- Use WPS locally for Office interaction and later visual compatibility
  acceptance; do not call WPS AI, WPS cloud, or document AI plugins.
- Use synthetic fixtures only.
- Run proportional tests and one full regression at the phase gate.

## Tasks

1. Add RED tests for the strict Assistant Work decision, local Markdown search,
   draft workspace, session manager, semantic task boundary, and core
   capability behavior.
2. Implement the smallest validators and deterministic storage/search modules
   required to make those tests pass.
3. Add the read-only `assistant.work` decision client and AI-input guard.
4. Implement the capability so it creates/restores one Task Session, uses only
   verified sources, versions drafts, preserves the fixed model and grounding
   mode, and closes explicitly.
5. Extend the static registry and Dispatcher to supply the minimal Task Session
   summary to the existing Router and resume clear continuation without
   swallowing independent actions.
6. Add exact disabled candidate configuration and main composition only after
   the isolated core is green.
7. Run targeted, adjacent, full-regression, permission, privacy, clean-tree,
   and isolation-restore checks.
8. Commit and push only the validated integration branch. Do not create a PR,
   merge `main`, deploy, or enable the candidate.
