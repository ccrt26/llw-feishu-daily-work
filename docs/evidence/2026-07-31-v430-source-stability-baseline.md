# V4.3.0 Source Stability Baseline

- Component base: `2c77c0c30eb0043faff0538cb18a991301b9ee31`
- Skills base: `b6d024a96921f8270e1452468dd80cc00d1e354e`
- Component branch: `agent/v430-source-stability`
- Skills branch: `agent/v430-source-stability-skill`
- Production directories modified: no
- Configuration modified: no
- External API calls: zero
- Skill runtime hashes: `7/7` matched the V4.2.9 manifest
- Directly affected baseline: `64/64` PASS
- Known defects to reproduce:
  1. Cross-source derived images can exceed the remaining 16-image budget.
  2. Production advertises `source_read_request` without a Source Reader.
