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

test("main validates business routing contracts and injects one read-only intent router",async () => {
  const source=await readFile(fileURLToPath(new URL("../src/main.mjs",import.meta.url)),"utf8");
  assert.match(source,/import \{loadRoutingContract\} from "\.\/core\/routing-contract\.mjs"/);
  assert.match(source,/import \{validateIntentRouterSkill\} from "\.\/core\/intent-router-client\.mjs"/);
  assert.match(source,/import \{createRouterTextTask,createDailyWorkInterpretTask,createInvoiceVisualTask\} from "\.\/core\/semantic-tasks\.mjs"/);
  assert.match(source,/feishu-intent-router/);
  assert.ok(source.indexOf("await validateIntentRouterSkill(routerSkillRoot)")<source.indexOf("StateStore.open"));
  assert.match(source,/loadRoutingContract\(config\.capabilities\["daily-work"\]\.skillRoot,"daily-work"\)/);
  assert.match(source,/loadRoutingContract\(invoiceConfig\.skillRoot,"invoice"\)/);
  assert.match(source,/buildCapabilityRegistry\(\{dailyWork:dailyCapability,invoice:invoiceCapability,contracts,enabled:/);
  assert.match(source,/new Dispatcher\(\{binding,state,capabilities,intentRouter,messenger\}\)/);
  assert.match(source,/const routerText=createRouterTextTask\(\{/);
  assert.match(source,/const dailyWorkInterpret=createDailyWorkInterpretTask\(\{/);
  assert.match(source,/const invoiceVisual=createInvoiceVisualTask\(\{/);
  assert.match(source,/decide:dailyWorkInterpret/);
  assert.match(source,/decide:invoiceVisual/);
  assert.match(source,/const intentRouter=\{decide:routerText\}/);
});
