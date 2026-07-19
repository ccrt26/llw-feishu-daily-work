import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const skillRoot="/Volumes/ZHUTONG/LLW的私人助手/LLW/.agents/skills/filing-invoices";

test("invoice Skill is the explicit source for PDF document verification semantics",async () => {
  const [skill,schema]=await Promise.all([
    readFile(`${skillRoot}/SKILL.md`,"utf8"),
    readFile(`${skillRoot}/references/output-schema.json`,"utf8").then(JSON.parse)
  ]);
  for (const value of ["single_invoice","multiple_invoices","conflicting_fields","unclear"]) assert.match(skill,new RegExp(`\\b${value}\\b`));
  assert.match(skill,/只有.*single_invoice.*归档/s);
  assert.match(skill,/(?:多张发票|两张或更多独立发票).*拆分/s);
  assert.match(skill,/跨页.*冲突.*不得归档/s);
  assert.match(skill,/原始 PDF.*归档/s);
  assert.deepEqual(schema.properties.document_verification.enum,["single_invoice","multiple_invoices","conflicting_fields","unclear"]);
  assert.equal(schema.properties.invoice.properties.file_format.enum.includes("pdf"),true);
});
