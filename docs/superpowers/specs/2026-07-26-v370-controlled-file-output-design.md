# V3.7.0 Controlled File Output Design

## Scope

This batch implements R4 closed loop C only. It does not enable
`assistant-work`, migrate the formal configuration, restart a listener, send a
real message, write the Vault, or add an AI/cloud plugin.

The first output set is exactly DOCX, PPTX and XLSX. One request produces at
most one file. The desktop WPS installation is the preferred interactive
editor and the final compatibility acceptance application. Microsoft Office
is not required. WPS AI and WPS cloud automation are outside this design.

## Generation boundary

An explicit format request may use one bounded Codex generation job because
content/layout generation needs semantic work. The job receives only:

- the current versioned task draft;
- the current Task Session public state;
- bounded, verified source excerpts;
- one program-selected output kind and a fixed output filename.

The job is workspace-write only inside a private temporary directory. It uses
the already installed local document, presentation or spreadsheet Skill. It
cannot write the Vault or choose an arbitrary destination. Normal reads,
validation, publishing, retries and sending do not call AI.

If there is no current draft or the request does not name exactly one supported
format, the program asks for clarification before creating a job.

## Controlled output

`FileOutputWorkspace` owns two disjoint private roots:

- `tempRoot`: incomplete generation jobs;
- `outputRoot`: stable, validated files waiting to be sent.

The generator may write only `deliverable/output.<ext>`. The validator requires
one regular non-symlink file, the expected extension and OOXML ZIP signature,
the required OOXML package members, a bounded size and no extra deliverables.
Macro-enabled and encrypted packages are rejected. SHA-256, size, MIME type,
display name and the stable controlled path are recorded only after validation.

Publishing is no-overwrite and idempotent for one session, draft version and
format. A failed send always reuses the same stable file and never regenerates.
The owner confirmed a seven-day retention period measured from successful file
sending. Unreplied files are protected without a time limit until sending
succeeds. Startup and one bounded daily scan remove only expired, unprotected
regular OOXML files under the expected session/draft structure; foreign entries
and symbolic links are not followed.

## Outcome and transport

`replyFiles` is separate from internal string `artifacts`. Each reply file has
exactly:

- stable controlled path;
- display name;
- MIME type;
- SHA-256;
- byte size;
- independent send idempotency key.

The Dispatcher persists text and `replyFiles` before sending. It marks the
outcome replied only after the text and every file have completed. Recovery
replays the same text and stable files.

Feishu is the only first-batch file entry because the installed `lark-cli`
adapter has a real local-file upload and reply contract. It sends text first,
then one file with a separate idempotency key. The WeChat iLink adapter has only
a verified text message contract, so `entrySupportsFileReply` is false and no
file is generated for a WeChat request.

## Configuration and rollout

The candidate configuration adds `outputRoot`, `maxOutputBytes`,
`outputRetentionDays: 7` and the exact ordered output set
`["docx","pptx","xlsx"]`. Both the public allowlist and configuration remain
disabled. The owner selected the standard per-user macOS Application Support
location for the real `outputRoot`; its user-specific absolute path remains in
the private local deployment record rather than this public repository.

No generated file is automatically ingested into a knowledge library.
