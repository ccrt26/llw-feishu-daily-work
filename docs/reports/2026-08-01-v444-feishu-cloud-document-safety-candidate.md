# V4.4.4 Feishu Cloud Document Safety Candidate

Date: 2026-08-02

## Exact base and candidate commit

- Base: `606e63fc6535eba1a248c3910c65e384c30eabac`
- Branch: `fix/v444-feishu-cloud-document-safety`
- Code and vertical-contract tip before this report: `ae8dbe5`
- Production checkout was read only and retained its historical atomic-deploy
  differences.

## Root-cause RED

The corrected safe-only fixture ran against the unchanged base code. A DOCX
with two standard HTTP/HTTPS hyperlink relationships failed with
`assistant_source_invalid` at the unconditional `TargetMode="External"`
check. The same old code also accepted the unknown `TargetMode="Remote"`.

The RED run reported 29 passing tests and the two intended missing behaviors
above. No production code had changed when this evidence was captured.

## Safe hyperlink GREEN

The candidate parses each `.rels` part as bounded relationship XML and allows
an External relationship only when all of these facts are true:

- the relationship Type is one of the two exact Office hyperlink URIs;
- the decoded Target is a trimmed, bounded HTTP or HTTPS URL;
- the URL contains no username or password;
- the link remains inert document data and is never fetched.

The direct relationship-policy contract passed `36/36`.

## Unsafe and mixed relationship evidence

Thirty unsafe variants remain fail-closed, including missing or fake types,
external image/template/OLE/package/workbook relations, unsafe schemes,
credential or control-character targets, unknown mode, duplicate IDs or
attributes, wrong namespace, DTD/ENTITY, malformed/nested/trailing XML,
invalid declarations, mixed safe/unsafe relations and the 2048-item bound.

An empty valid self-closing Relationships root and normal Internal relations
remain accepted.

## Feishu-shaped vertical journey

The synthetic Feishu journey passed `2/2`:

- safe document: one export, one source, one assistant decision, one
  `save_knowledge`, one KnowledgeWriter publication, Outcome before one reply,
  matching retained/preserved DOCX hashes, and deleted exporter staging;
- safe hyperlink plus external image: one export, then
  `source_security_rejected` before AI and Writer, zero artifacts, one durable
  failure reply, and deleted source/export staging.

The journey used only synthetic local fixtures, a deterministic fake model and
a temporary Vault.

## Focused tests

- Relationship policy: `36/36`
- Source/Writer compatibility: `42/42`
- Feishu-shaped vertical journey: `2/2`
- Final focused candidate set: `106/106`

## Complete regression

The complete restricted run passed `673/674`. Its only failure was the known
macOS AVFoundation synthetic-video `Cannot Encode` condition already recorded
on the parent line. The branch does not modify that test, fixture script or
native helper. The exact unchanged native test passed `1/1` with normal local
media permissions. Effective complete regression: `674/674`.

The complete run was performed once because the changed inspector is shared by
DOCX, PPTX and XLSX intake. It was not mechanically repeated after the known
environment-only failure.

## Changed-file allowlist

Approved candidate files are limited to:

- `src/personal-assistant/source-security-inspector.mjs`
- `test/personal-assistant-source-security-inspector.test.mjs`
- `test/v444-feishu-cloud-document-ingest-journey.test.mjs`
- `docs/evidence/2026-08-01-v444-feishu-cloud-document-safety-baseline.md`
- `docs/reports/2026-08-01-v444-feishu-cloud-document-safety-candidate.md`
- `README.md`

The exporter, Source Preparer, TaskSourceWorkspace, Coordinator, Writer,
configuration, state, Skill and legacy `ooxml_processor.py` are unchanged.
There is no runtime reference to `ooxml_processor.py` on this candidate.

## Permissions and network

- Feishu/OAuth/system permissions added or changed: 0
- Network hosts or requests added: 0
- Hyperlink fetches: 0
- Agents, Routers, Writers, tools, services or dependencies added: 0
- User data or private platform identifiers copied into the candidate: 0

## Rollback

Before production switching, create an owner-only V4.4.3 rollback baseline
containing the pre-deploy inspector, Git bundle, configuration/state/plist
snapshots and SHA-256 inventory. Restore-test it in a fresh temporary directory
before stopping the single service.

## Production status

V4.4.4 is not deployed. The current system remains V4.4.3. No production file,
service, configuration, permission, user data or external API state was changed
while forming this candidate. The system version may change only after the
candidate is deployed and a real Feishu read-summary-save journey succeeds.
