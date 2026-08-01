# V4.3.1 Processing Receipt Baseline

- Component base: `7a3a6089be81964d4d7ef9621a3f78929fe26438`
- Skills base: `25dd530c6248a7b0c3571471a460b5fd88eee87c`
- Component branch: `agent/v431-processing-receipt`
- Skills branch: `agent/v431-processing-receipt-skill`
- V4.3.0 Skills manifest SHA-256: `95adbd12e904ed12d399124815f9d24ad37eb7eb31df71fe342edf5e89c8b8fb`
- Directly affected baseline: `124/124` PASS
- External API, Keychain, Codex, and real Writer calls: zero
- Production component, Skill, configuration, service, permissions, and user data modified: no
- Defect to reproduce: an accepted public-video Task can spend its ASR polling, timeline preparation, and model turn without one independent processing receipt.
