# V4.3.2 Video Evidence Candidate Report

## User Goal

This local candidate makes public-video analysis materially more truthful and
useful. When the initial navigation overview is insufficient, the model can ask
for one directly relevant interval and receive verified real frames from that
interval before answering.

It also preserves incomplete speech recognition as explicit evidence coverage
instead of silently treating a partial or failed transcript as complete.

## User-Visible Outcome

1. A Bilibili or Douyin task can inspect one relevant video interval of at most
   60 seconds per model round.
2. The interval produces one bounded contact sheet with at most 12 real frames.
3. The second model call receives both the bounded observation and its verified
   PNG evidence.
4. At most three interval-read rounds are possible, and the capability is not
   advertised when no image slot remains.
5. A partial transcript may support a direct answer only inside its explicitly
   covered ranges. A failed transcript is visual-only.
6. Partial or failed transcript evidence cannot authorize knowledge saving.
7. Interval frames, transcripts, subtitles, and other source content never
   authorize a Writer; only the bound user's typed instruction can do that.
8. Read failure, forged evidence, stale task revision, or exhausted capacity
   produces no Writer call.

No new provider, agent, permission, service, dependency, or arbitrary media
operation was added. The only model-visible media read is
`inspect_time_range`.

## Exact Bases and Candidate Commits

- Component base:
  `abe1aeaae899b8173c582b773eb29de59dad3acf`
- Verified component candidate:
  `3b0696518f37fe9756dac87190ed562b468b4cc2`
- Component branch: `agent/v432-video-evidence`
- Skills base:
  `a7d26e6cb8df750e3b028e3fce7ed6a5d7e8582f`
- Skills candidate:
  `bde85270c7d2b0e3805420fa19bf5573ef174969`
- Skills branch: `agent/v432-video-evidence-skill`

Component implementation commits:

- `11ded11` — record the isolated V4.3.2 baseline
- `b79a8c0` — inspect bounded video time ranges
- `94f8dff` — validate visual source-read evidence
- `bdc6339` — persist inspected video interval evidence
- `1178b82` — wire real video interval source reads
- `db60e6f` — preserve partial video transcript coverage
- `db8d7cc` — activate the V4.3.2 component contract
- `3b06965` — align the client contract test with the sole allowed read

## Native Runtime Artifact

- Candidate path:
  `/private/tmp/llw-v432-video-evidence/artifacts/video_timeline_reader_v2`
- SHA-256:
  `4f967d8a45cbc2c7c517c8222619be1dd585a2269110f78723b94a50275039d6`
- Owner and mode: `ccrt`, `0700`
- Size: `74648` bytes
- The exact hash is pinned in the V4.3.2 production composition.

The exact candidate binary was directly exercised against a synthetic 12-second
video. It returned the existing full-timeline
`video_timeline_reader_v1` contract with three samples and one PNG, then returned
the new `video_time_range_reader_v1` contract for 5–7 seconds with one real
sample and one PNG.

## Evidence and Safety Contracts

### Native helper and adapter

- Full-timeline output is capped at 156 samples and 13 sheets, reserving image
  capacity for later interval reads.
- Interval reads are capped at 60 seconds, 12 samples, and exactly one sheet.
- The adapter validates source identity, duration, requested range, sample
  order, paths, realpaths, file ownership/mode, PNG structure, dimensions,
  bytes, and SHA-256 before publication.

### Durable source workspace

- Interval index and PNG names are deterministic.
- A valid index survives process restart and is reused byte-for-byte.
- An index written before its Sidecar append can be safely recovered.
- Forged ranges or changed evidence fail closed.

### Model loop

- Source read is advertised only when a real backend exists, rounds remain, and
  at least one of the 16 model-image slots remains.
- Each model action can request exactly one `inspect_time_range`.
- A revision check immediately after the read prevents stale answers or writes.
- Backend failure becomes one truthful limitation reply with zero writes.

### Transcript coverage

- Accepted states are exactly `complete`, `partial`, and `failed`.
- Covered and uncovered ranges must form an ordered, non-overlapping, exact
  partition of the provider duration.
- Every transcript segment must lie inside a covered range.
- `complete` has no uncovered range, `partial` has both covered and uncovered
  ranges, and `failed` has no covered range or transcript segment.
- The existing knowledge evidence resolver rejects `partial` and `failed`
  before Writer execution.

## Verification

- Isolated affected baseline: effective `75/75` PASS.
- Final focused affected-chain regression: `125/125` PASS.
- Native media contract in the real macOS media environment: `1/1` PASS.
- Combined focused result: `126/126` PASS.
- Full sandbox diagnosis on the pre-fix candidate: `880/906` PASS.
  - 24 failures were local-loopback listen restrictions (`EPERM`).
  - 1 failure was the sandbox media encoder restriction.
  - 1 real stale client test still requested the removed `probe_media` action.
- The stale client contract was corrected to request one bounded
  `inspect_time_range`; its client/provider regression passed `11/11`.
- Final unrestricted full component regression: `906/906` PASS.
- The WeChat-shaped vertical journey covers:
  source preparation → once-only processing receipt → partial transcript and
  navigation evidence → model interval request → verified interval PNG →
  second model answer → Outcome and reply, with zero Writer calls.
- External APIs called: zero. Tests used only local fake servers and synthetic
  files.

## Candidate Hashes

- `llw-personal-assistant/SKILL.md` SHA-256:
  `5f23ad631b2ec47959bdb89f503db818ba0fbc9784c6499ac02bb1039331eacc`
- Skills `manifest.json` SHA-256:
  `37004565fee883bf657eadeeb084349378a3830926e10187d7bd4fb926d18040`
- Native helper SHA-256:
  `4f967d8a45cbc2c7c517c8222619be1dd585a2269110f78723b94a50275039d6`

## Changed-File Allowlist

Component changes are limited to:

- one baseline evidence document and this candidate report;
- the existing native video timeline helper and its adapter;
- SourceReader, public-video task evidence, Coordinator, model schema/prompt,
  provider adapter, and V4.3.2 main composition;
- directly related unit, contract, fault-injection, knowledge-gate, composition,
  and WeChat journey tests.

The Skills candidate changes only:

- `llw-personal-assistant/SKILL.md`;
- `manifest.json`.

## Rollback

Rollback is the exact pre-candidate pair:

- Component:
  `abe1aeaae899b8173c582b773eb29de59dad3acf`
- Skills:
  `a7d26e6cb8df750e3b028e3fce7ed6a5d7e8582f`

The production helper remains the V1 path until deployment. A deployment
rollback would restore the prior component and Skills commits and keep or
restore the V1 helper path and pinned hash.

## Production Status

**Not deployed.**

The existing production checkout is already dirty and was treated as
read-only. This work modified no production component, production Skill,
configuration, service, permission, credential, external API, or user data.

Installing the V2 helper, updating the production component and Skills,
updating protected configuration hashes if required, restarting the service,
and running a real-entry production smoke require explicit owner confirmation.
