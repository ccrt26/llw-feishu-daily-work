# V3.6.2 Invoice Date Normalization Design

## Status

Approved by the project owner on 2026-07-24 with the instruction: update the baseline, then fix the defect.

## Evidence and root cause

The supplied clear electronic invoice visibly contains `2026年07月21日`. A read-only replay through the production-equivalent `invoice.visual` path returned that exact value with `issue_date=clear`, `category=dining`, and `document_verification=single_invoice`.

The extraction Skill and prompt require raw visible values to be copied verbatim. The current Node.js validator accepts only `YYYY-MM-DD`, so it maps the correctly extracted Chinese date to `issue_date_invalid`. This is a deterministic contract conflict, not a visual recognition failure.

## Considered approaches

1. **Normalize two approved lexical forms in Node.js — selected.** Keep AI extraction verbatim, parse only `YYYY-MM-DD` and `YYYY年MM月DD日`, validate the calendar date, and pass canonical `YYYY-MM-DD` only to the writer. This preserves the V3.6.1 responsibility boundary.
2. Ask AI to emit `YYYY-MM-DD`. Rejected because it contradicts the extraction-only contract and makes archival formatting model-dependent.
3. Let the writer accept raw Chinese dates. Rejected because it couples business parsing to filesystem naming and duplicates validation below the rule-decision boundary.

## Architecture and data flow

`invoice.visual` continues to return an unchanged `InvoiceExtraction`. `deriveInvoiceRuleDecision` parses the clear raw date with one private deterministic helper:

```text
YYYY-MM-DD      ─┐
                 ├─ calendar validation ─ normalized YYYY-MM-DD
YYYY年MM月DD日 ─┘
```

All other forms return `issue_date_invalid`. On success, `InvoiceRuleDecision.invoice.issue_date` is the normalized value while the original extraction object remains unchanged. Existing buyer, category, document, invoice-number, amount, writer, receipt, transaction, hash, path, Feishu, WeChat, image, and PDF behavior remains unchanged.

## Exact accepted and rejected forms

Accepted:

- `2026-07-21`
- `2026年07月21日`

Rejected:

- `2026/07/21`
- `26-07-21`
- `2026年7月21日`
- values with leading or trailing whitespace
- impossible dates such as `2026-02-30`
- missing or unclear dates, which continue to use the existing field-quality clarification before parsing

No date library, new dependency, configuration, state version, model call, OCR step, service, route, or channel-specific branch is introduced.

## Reply behavior

The approved Chinese date no longer reaches `issue_date_invalid`. Unsupported clear date syntax or an impossible date continues to use the existing fixed date clarification. Missing and unclear values continue to use their more accurate existing field-quality replies.

## Verification

- RED: a clear `YYYY年MM月DD日` extraction must currently fail to receive `archive_dining/eligible`.
- GREEN: both accepted forms produce the same normalized decision and leave the extraction unchanged.
- Negative tests cover slash, whitespace, non-padded Chinese forms, and impossible calendar dates.
- Capability test proves the writer receives only canonical `YYYY-MM-DD`.
- Skill contract test proves the extraction/normalization responsibility remains explicit.
- Full regression, protected rollback restore, production health, and a real Feishu resend are required before completion.

## Scope stop

Stop and request a new decision if implementation requires accepting another date form, changing the AI output Schema, changing writer paths, modifying state/configuration, adding dependencies, or changing entry protocols.
