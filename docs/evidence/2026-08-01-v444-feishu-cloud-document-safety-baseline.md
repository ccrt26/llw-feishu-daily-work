# V4.4.4 Feishu Cloud Document Safety Baseline

## Exact base

- Component: `606e63fc6535eba1a248c3910c65e384c30eabac`
- Branch: `fix/v444-feishu-cloud-document-safety`
- Focused baseline: `55/55` passed on Node.js `v24.16.0`

## Current failure

- Export: success, non-empty DOCX
- Stable outcome reason: `source_security_rejected`
- AI calls: 0
- Writer calls: 0
- Artifacts: 0

## Sanitized package evidence

- External relationships: 12
- Relationship types: hyperlink only
- Macro/encryption/unsafe parts/path/compression failures: 0

## Scope

- Permissions changed: no
- Production changed: no
- User data copied into evidence: no
- Raw URL, title, token, document text, hyperlink target or platform identifier recorded: no

## Root-cause RED

On 2026-08-02 the new relationship-policy test ran against the unchanged
`606e63f` production code:

- the valid standard HTTP/HTTPS hyperlink document failed with
  `assistant_source_invalid` at the unconditional External check;
- the unknown `TargetMode="Remote"` relationship was incorrectly accepted;
- all 26 other dangerous or malformed relationship variants were rejected;
- result: 27 passed subtests and the two intended behavior failures above.

This is a behavior RED: safe hyperlink classification and unknown-mode
fail-closed handling are both absent from the current implementation.

## Production status

V4.4.4 is not implemented or deployed. The current system remains V4.4.3.
