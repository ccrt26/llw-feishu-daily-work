# V4.3.2 Video Evidence Baseline

## Exact bases

- Component:
  `abe1aeaae899b8173c582b773eb29de59dad3acf`
- Private Skills:
  `a7d26e6cb8df750e3b028e3fce7ed6a5d7e8582f`
- Private Skills `manifest.json` SHA-256:
  `c8addab18c2f4f45c213f64c0e5505329eca6c686556db0553e9061fbde1cdf3`

Both isolated worktrees were clean before the baseline.

## Existing fixed native helper

- Path:
  `/Users/ccrt/Library/Application Support/LLW Assistant/runtime/video-timeline-reader-v1/video_timeline_reader_v1`
- SHA-256:
  `b3b79f1770b49b75223d4a085ba41001256c985a3bde36d3317b9dd90a8f5a3f`
- Mode/owner/size: `-rwx------ ccrt 57688`

The production helper and production component were read only.

## Directly affected baseline

The baseline covered source-read request and result validation, timeline
adapter and compiled native contract, Task public-video evidence, video
knowledge evidence, Coordinator model loop, invoker Schema/prompt, runtime,
production composition, WeChat video knowledge journey, and private Skill
contracts.

- Sandboxed run: `74/75` PASS.
- The only sandbox failure was the known macOS native fixture error
  `Cannot Encode`.
- Exact unrestricted reproduction of that native test: `1/1` PASS.
- Effective affected baseline: `75/75` PASS.
- External API calls: zero.
- Real user media or user data read: zero.
- Test inputs: synthetic local fixtures and injected fakes only.
