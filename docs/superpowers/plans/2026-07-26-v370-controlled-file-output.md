# V3.7.0 Controlled File Output Implementation Plan

1. Add failing tests for exact format selection, controlled OOXML validation,
   stable publishing, extra-file rejection and idempotent reuse.
2. Add a bounded file-generation client and wire verified file evidence into
   the existing `assistant-work` decision contract.
3. Add `replyFiles` to strict draft/outcome persistence and recovery without
   changing existing string `artifacts`.
4. Extend Feishu text-plus-file sending with separate idempotency keys; keep
   WeChat file output explicitly unsupported.
5. Extend the disabled v5 candidate configuration and composition.
6. Run targeted tests, adjacent state/transport tests and one full regression.
7. Generate synthetic DOCX, PPTX and XLSX samples with local Skills, validate
   their packages, and open them in WPS for compatibility acceptance.
8. Update project documentation, commit and push the validated integration
   branch. Do not merge, deploy, enable, migrate formal configuration or send a
   real platform message.
