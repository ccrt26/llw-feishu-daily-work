# V3.7.0 Private Skill Loader Design

## Status and scope

This design implements only mandatory R3 step 10: connect the public component
to a generic, strict private Skill manifest loader. R3 is already approved. The
owner instructed automatic execution without subagents.

This batch does not implement or enable `knowledge-ingest`,
`assistant-work`, Task Session, knowledge/file Writers, file sending, or new
Vault directories. It does not deploy or change production configuration.

## Selected design

Add one focused `src/core/private-skill-manifest.mjs` module and a version-5
configuration envelope. At startup, `main.mjs` validates the complete private
manifest before state, AI, network listeners, or business work. It then uses
only the validated roots for the existing Router, daily-work, and invoice
Skills. The two V3.7.0 business candidates must remain disabled.

Alternatives were rejected:

- keeping direct path loading would not verify the manifest, versions,
  permissions, or hashes;
- dynamic directory discovery would violate R3's static allowlist;
- copying private schemas or Skill text into the public repository would break
  physical privacy separation.

## Configuration version 5

Add one exact top-level object:

```json
{
  "privateSkills": {
    "root": "/absolute/private/root",
    "manifestPath": "/absolute/private/root/manifest.json",
    "expectedManifestSha256": "64 lowercase hex"
  }
}
```

The object contains no Skill body, examples, platform identifiers, credentials,
or user data. `manifestPath` must equal `root/manifest.json`. Existing
daily-work and invoice `skillRoot` fields remain for this compatibility batch,
but startup requires them to equal the validated manifest roots.

Version 4 is not silently upgraded during service startup. A separate atomic
`migrate-config-v5.mjs` accepts the config path, private root, manifest path,
and operator-verified manifest SHA-256; it rejects unsafe inputs and leaves
bytes unchanged on failure. Rollback restores the version-4 config together
with the previous component.

## Loader contract

`loadPrivateSkillManifest(options)` receives:

- absolute `root`, `manifestPath`, and `expectedManifestSha256`;
- a public static allowlist containing only name, capability, allowed versions,
  semantic tasks, model support, and required enabled state.

It returns metadata and absolute Skill roots only. It never returns file
contents.

Validation order:

1. root and manifest identity, owner, type, permissions, and real path;
2. manifest SHA-256 before JSON use;
3. exact manifest schema, field types, unique names, and canonical ordering
   independence;
4. exact allowlist match for every entry, including enabled state;
5. each Skill directory identity and containment;
6. owner-only regular `SKILL.md`, optional routing contract, and optional output
   schema;
7. SHA-256 match for each referenced file.

Any failure throws one bounded `private_skill_manifest_invalid` error without a
path, filename, manifest value, hash, or content. The loader does not scan
directories, install, update, log, or parse Skill bodies.

## Static activation policy

The public component allowlist states:

- Router `1.1.0`, enabled;
- daily-work `1.0.0`, enabled;
- invoice `1.0.0`, enabled;
- knowledge-ingest `1.0.0`, disabled;
- assistant-work `1.0.0`, disabled.

The public repository may contain these capability and semantic-task names,
because they are public architecture, but contains no private prompt, private
examples, private schemas, actual hashes, or private fixture content.

## Tests

Use only generated `/private/tmp` synthetic Skills:

- valid owner-only manifest and three referenced hashes;
- manifest hash mismatch, malformed JSON, unknown fields, duplicate names;
- unknown or mismatched allowlist entry, version, task, model, capability, or
  enabled state;
- missing, broad-mode, wrong-type, symlinked, escaped, or hash-mismatched files;
- null reference requires the file to be absent;
- loader result contains metadata/root only and no private content;
- v4-to-v5 atomic migration and failure byte preservation;
- config v5 exact fields and protected-path rules;
- `main.mjs` validates before state and uses validated roots.

During development run only loader/config/main-composition tests. At the final
gate run all 326 existing tests plus the new tests, then a read-only cross-repo
check against the private Router candidate. No model calls or subagents are
needed for this mechanical security boundary.

## Deployment boundary

This branch is a public-component candidate only. Do not merge, migrate the
production config, restart the service, or enable either new capability in this
batch. Atomic deployment later requires the private Router candidate, the
component commit, version-5 config, a protected rollback point, full regression,
service health, and real dual-entry acceptance.
