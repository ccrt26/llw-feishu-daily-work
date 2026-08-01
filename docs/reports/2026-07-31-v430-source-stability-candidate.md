# V4.3.0 Source Stability Candidate Report

## Scope

This local candidate implements only the approved first remediation release:

1. Reject an aggregate visual-evidence set that cannot fit the strict 16-image model boundary.
2. Keep every source intact and ask the user to start a new task and send the material in batches.
3. Perform no second AI call and no Writer call after the aggregate becomes over budget.
4. Advertise and accept `source_read_request` only when a real Source Reader backend is injected.
5. Activate the matching component and private-Skill version contract as V4.3.0.

Legacy removal, progress acknowledgements, a real interval Source Reader, partial ASR, and configurable limit ranges are not part of this candidate.

## Exact Bases and Candidate Commits

- Component base: `2c77c0c30eb0043faff0538cb18a991301b9ee31`
- Component candidate: `5902e28800b45027f9fc29d2da3c81fcd489e964`
- Component branch: `agent/v430-source-stability`
- Skills base: `b6d024a96921f8270e1452468dd80cc00d1e354e`
- Skills candidate: `25dd530c6248a7b0c3571471a460b5fd88eee87c`
- Skills branch: `agent/v430-source-stability-skill`
- Candidate `manifest.json` SHA-256: `95adbd12e904ed12d399124815f9d24ad37eb7eb31df71fe342edf5e89c8b8fb`

## Test-Driven Evidence

### Aggregate visual-evidence budget

- RED: the new two-PDF/20-page Coordinator test failed with `agent_turn_context_invalid`, proving that the aggregate had no safe pre-model budget decision.
- GREEN: the bounded planner classifies the aggregate before derived-file validation and returns one deterministic split request.
- Contract: aggregates at or below 16 images remain byte-for-byte and order preserving; aggregates above 16 are never silently truncated.

### WeChat vertical zero-write journey

- First 10-page PDF: one assistant analysis.
- Second 10-page PDF in the same active task: deterministic `rejected` Outcome.
- Assistant call count remains one.
- Writer call count remains zero.
- Reply asks the user to send `开始新任务` and batch the material.

### Truthful Source Reader capability

- RED: the production-shaped composition, client, Coordinator, Schema, prompt, and provider adapter advertised or accepted source reads while no reader was injected.
- GREEN: `allowSourceRead` is now an explicit strict boolean across the complete call chain.
- Disabled/default contract: output Schema excludes `source_read_request`, its field is strictly `null`, the prompt does not advertise interval inspection, and the provider adapter rejects such output.
- Enabled contract: the same capability becomes available only when a real Source Reader is injected.

## Verification

- Initial directly affected baseline: `64/64` PASS.
- Version and manifest contract: `25/25` PASS.
- Final focused affected-chain regression: `96/96` PASS.
- Initial sandboxed full run: `851/876` PASS; all 25 failures were environmental:
  - 24 tests could not listen on the local loopback interface (`EPERM`).
  - 1 native video fixture could not invoke the system encoder.
- Minimal unrestricted diagnosis of those exact failures: `28/28` PASS.
- Final unrestricted full component regression: `876/876` PASS.
- External APIs called: zero. Loopback fake servers and synthetic local fixtures only.

## Changed-File Allowlist

Component candidate changes are limited to:

- baseline and candidate evidence documentation;
- main V4.3.0 composition/version wiring;
- personal-assistant client, Coordinator, invoker, output Schema, and provider adapter;
- one new bounded visual-evidence planner;
- directly related unit, contract, composition, and WeChat journey tests.

Private Skills candidate changes only `manifest.json`, and only the `llw-personal-assistant` version from V4.2.9 to V4.3.0. Runtime Skill bytes and their seven recorded hashes are unchanged.

## Rollback

Rollback is the exact pair of pre-candidate revisions:

- Component: `2c77c0c30eb0043faff0538cb18a991301b9ee31`
- Skills: `b6d024a96921f8270e1452468dd80cc00d1e354e`

No parallel legacy implementation was added.

## Production Status

**Not deployed.**

This work modified no production component, production Skill, configuration, service, permission, credential, external API, or user data. Deployment, configuration-hash update, service restart, and a real-entry production smoke require explicit owner confirmation.
