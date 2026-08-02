# V4.4.5 Bounded AI Timeout Baseline

Date: 2026-08-02

- Real failure: `assistant_timeout` at exactly 120,000 ms.
- Source preparation: passed; one retained DOCX remains in the current Task
  Session.
- Writer calls: 0.
- Knowledge writes: 0.
- Document shape: 2,666,430 bytes, 26 OOXML entries, 14 media entries,
  84,340 `document.xml` bytes and approximately 6,673 text characters.
- Configuration before deployment: schema 7 with
  `personalAssistant.aiTimeoutMs=120000`.
- V4.4.4 safety inspector remains deployed and accepted the document before
  the model deadline began.
- No document name, content, Task/message/user/chat identifier or Vault path is
  retained in this evidence.

