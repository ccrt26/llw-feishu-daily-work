# V3.7.0 Private Skill Loader Implementation Plan

> **For agentic workers:** Execute inline in this session. The owner explicitly
> prohibited subagents. Follow RED-GREEN-REFACTOR and keep production untouched.

**Goal:** Add a fail-closed generic private Skill manifest loader and connect it
to component startup without enabling the two new business capabilities.

**Architecture:** A single core loader validates a strict manifest, static
public allowlist, filesystem identity, permissions, and hashes. Version-5
protected config supplies only root, manifest path, and expected manifest hash.
Existing Skill consumers receive validated roots.

**Tech Stack:** Node.js 24 ESM, `node:test`, `node:fs/promises`, `node:crypto`,
strict JSON fixtures, Git worktree.

## Global Constraints

- No subagents or model calls.
- No private Skill content, examples, schemas, hashes, user paths, or real data
  in the public repository.
- No dynamic scanning, installation, download, update, or runtime enablement.
- New business Skills remain disabled.
- Production component, config, state, service, Vault, and LaunchAgent remain
  unchanged.

---

### Task 1: RED tests for the generic manifest loader

**Files:**
- Create: `test/private-skill-manifest.test.mjs`
- Create: synthetic files only under each test's temporary directory.

**Interfaces:**
- Produces: `loadPrivateSkillManifest({root, manifestPath,
  expectedManifestSha256, allowlist})`.

- [ ] Write tests for valid metadata-only loading and every filesystem, schema,
  allowlist, null-reference, and hash failure listed in the design.
- [ ] Name the mutation caught by each test and assert only the bounded error
  `private_skill_manifest_invalid`.
- [ ] Run:

  ```bash
  /usr/local/bin/node --test test/private-skill-manifest.test.mjs
  ```

  Expected: FAIL because the module does not exist.

### Task 2: Minimal generic loader

**Files:**
- Create: `src/core/private-skill-manifest.mjs`

**Interfaces:**
- Consumes the exact Task 1 options.
- Returns `{manifestVersion, manifestSha256, skills}` where each Skill contains
  public metadata and an absolute `root`, never private file content.

- [ ] Implement strict type/field/semver/hash validation.
- [ ] Implement owner/type/mode/symlink/realpath/containment checks.
- [ ] Stream hashes without decoding `SKILL.md` or references.
- [ ] Validate every manifest entry against exactly one allowlist entry.
- [ ] Convert every internal failure to the bounded public error.
- [ ] Run the Task 1 test until GREEN, then refactor without widening behavior.

### Task 3: RED then GREEN configuration version 5

**Files:**
- Modify: `test/config.test.mjs`
- Modify: `test/wechat-bind.test.mjs`
- Modify: `src/config.mjs`
- Create: `test/migrate-config-v5.test.mjs`
- Create: `src/migrate-config-v5.mjs`

**Interfaces:**
- Config adds exact `privateSkills` fields from the design.
- Migration CLI consumes:
  `configPath privateSkillsRoot manifestPath expectedManifestSha256`.

- [ ] Change test fixtures to version 5 and add failing privateSkills validation
  cases.
- [ ] Add migration tests proving exact v4 acceptance, atomic v5 output, mode
  `0600`, and byte preservation on unsafe or invalid input.
- [ ] Run only config and migration tests and confirm RED.
- [ ] Implement minimal v5 validation and migration.
- [ ] Re-run until GREEN.

### Task 4: RED then GREEN startup integration

**Files:**
- Modify: `test/main-composition.test.mjs`
- Modify: `src/main.mjs`

**Interfaces:**
- `main.mjs` supplies a static five-entry allowlist.
- Existing Router/daily/invoice consumers use only roots returned by the loader.

- [ ] Add a failing composition test requiring manifest validation before
  `StateStore.open`, validated-root equality for existing configured Skill
  roots, and disabled policy for the two candidates.
- [ ] Import and call the loader before state or listeners.
- [ ] Remove the direct Router root derivation.
- [ ] Fail closed if existing configured roots differ from validated roots.
- [ ] Run loader, config, migration, main-composition, routing-contract, and
  intent-router-client tests until GREEN.

### Task 5: Privacy and cross-repository gate

**Files:**
- No private fixture files are added.

**Interfaces:**
- Consumes the private Router candidate only through a local read-only command.

- [ ] Search the public diff for private Skill prose, actual private hashes,
  real workspace paths, platform IDs, credentials, and user data.
- [ ] Create a temporary version-5 config fixture outside the repository and
  call the loader against the private candidate manifest.
- [ ] Require the Router candidate enabled and both new business Skills
  disabled; do not print entries, paths, hashes, or content.
- [ ] Confirm the private and component formal checkouts remain clean.

### Task 6: Regression, commit, and private branch sync

**Files:**
- All files explicitly listed above plus this design and plan.

- [ ] Run targeted tests after each TDD cycle.
- [ ] Run `git diff --check` and review the complete public diff.
- [ ] Run `/usr/local/bin/npm test` once at the final gate; expected count is the
  prior 326 plus the new loader/config/migration tests.
- [ ] Commit scoped changes to `agent/v370-private-skill-loader`.
- [ ] Push the branch only. Do not merge, deploy, migrate production, restart
  the service, or create a release.
- [ ] Report exact commits, test counts, deferred deployment gates, and rollback
  boundary.
