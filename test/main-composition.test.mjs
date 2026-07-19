import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";

test("main validates PDF tools before state and injects the bounded PDF preparer",async () => {
  const source=await readFile(fileURLToPath(new URL("../src/main.mjs",import.meta.url)),"utf8");
  assert.match(source,/import \{loadConfig,validatePdfTools\} from "\.\/config\.mjs"/);
  assert.match(source,/import \{prepareInvoicePdf\} from "\.\/capabilities\/invoice\/pdf-preparer\.mjs"/);
  assert.ok(source.indexOf("await validatePdfTools(invoiceConfig)") < source.indexOf("StateStore.open"));
  assert.match(source,/preparePdf:\(\{file\}\) => prepareInvoicePdf\(\{/);
  for (const field of ["pdfInfoPath","pdfToTextPath","pdfToPpmPath","maxPdfPages","maxPdfTextBytes","maxPdfRenderBytes","pdfPrepareTimeoutMs"]) {
    assert.match(source,new RegExp(`invoiceConfig\\.${field}`));
  }
});
