# V4.4.0 Single-Mainline Baseline

Date: 2026-07-31

## Exact bases

- Component:
  `0ce2b3f9aa9e25a1914cbadec45a89bb133d498d`
- Skills:
  `bde85270c7d2b0e3805420fa19bf5573ef174969`
- Component branch: `agent/v440-single-mainline`
- Skills branch: `agent/v440-single-mainline-skill`

Both isolated worktrees were clean at creation. The dirty production checkout
was inspected read-only and is not a development source.

## Directly affected baseline

The baseline covered:

- current main composition and legacy dispatch boundary;
- Personal Assistant task Coordinator and Dispatcher;
- task session state and manager;
- source burst debounce;
- StateStore migrations, Outcomes and recovery;
- Personal Assistant invoker;
- current task-session journeys;
- V4.2.7 knowledge-save video journey;
- V4.3.2 real interval WeChat-shaped journey.

Result: `127/127` PASS.

Command used the isolated V4.3.2 Skill root and no external API.

## Inherited full-candidate evidence

The exact V4.3.2 base immediately before this work passed:

- focused video-evidence chain: `126/126`;
- unrestricted full component regression: `906/906`;
- exact native V2 helper smoke for timeline and 5–7 second range: PASS.

## Production status

Not modified. No configuration, service, permission, credential, external API,
or user data was changed.
