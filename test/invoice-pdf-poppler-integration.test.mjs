import test from "node:test";
import assert from "node:assert/strict";
import {access,mkdtemp,rm} from "node:fs/promises";
import {spawn} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {prepareInvoicePdf} from "../src/capabilities/invoice/pdf-preparer.mjs";

const python="/Users/ccrt/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3";
const pdfInfoPath="/Users/ccrt/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override/pdfinfo";
const pdfToTextPath="/Users/ccrt/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/poppler/poppler/bin/pdftotext";
const pdfToPpmPath="/Users/ccrt/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override/pdftoppm";

async function makePdf({pages=1,text=true}) {
  for (const tool of [python,pdfInfoPath,pdfToTextPath,pdfToPpmPath]) await access(tool);
  const job=await mkdtemp(join(tmpdir(),"llw-real-poppler-"));
  const file=join(job,"source.pdf");
  const script=[
    "from reportlab.pdfgen import canvas",
    "import sys",
    "path=sys.argv[1]",
    "pages=int(sys.argv[2])",
    "include_text=sys.argv[3] == 'yes'",
    "c=canvas.Canvas(path)",
    "for index in range(1,pages+1):",
    "    c.rect(72,500,200,100)",
    "    if include_text: c.drawString(72,700,f'SAFE-PDF-PAGE-{index}')",
    "    c.showPage()",
    "c.save()"
  ].join("\n");
  await run(python,["-c",script,file,String(pages),text?"yes":"no"]);
  return {job,file};
}

function run(command,args) {
  return new Promise((resolve,reject) => {
    const child=spawn(command,args,{stdio:["ignore","ignore","pipe"]});
    let stderrBytes=0;
    child.stderr.on("data",chunk => stderrBytes+=chunk.length);
    child.once("error",reject);
    child.once("close",code => code === 0 ? resolve() : reject(new Error(`fixture_failed:${code}:${stderrBytes}`)));
  });
}

function prepare(file) {
  return prepareInvoicePdf({file,pdfInfoPath,pdfToTextPath,pdfToPpmPath,maxPages:10,maxTextBytes:262144,maxRenderBytes:104857600,timeoutMs:60000});
}

test("real Poppler extracts and renders a one-page digital PDF",async () => {
  const f=await makePdf({pages:1,text:true});
  try {
    const result=await prepare(f.file);
    assert.equal(result.documentFacts.pageCount,1);
    assert.equal(result.documentFacts.textAvailable,true);
    assert.match(result.extractedText,/SAFE-PDF-PAGE-1/);
    assert.equal(result.pageImages.length,1);
  } finally { await rm(f.job,{recursive:true,force:true}); }
});

test("real Poppler renders all pages of a two-page PDF in order",async () => {
  const f=await makePdf({pages:2,text:true});
  try {
    const result=await prepare(f.file);
    assert.equal(result.documentFacts.pageCount,2);
    assert.match(result.extractedText,/SAFE-PDF-PAGE-1/);
    assert.match(result.extractedText,/SAFE-PDF-PAGE-2/);
    assert.deepEqual(result.pageImages.map(path => path.split("/").at(-1)),["page-1.png","page-2.png"]);
  } finally { await rm(f.job,{recursive:true,force:true}); }
});

test("real Poppler accepts a scanned-style PDF with no text layer",async () => {
  const f=await makePdf({pages:1,text:false});
  try {
    const result=await prepare(f.file);
    assert.equal(result.documentFacts.textAvailable,false);
    assert.equal(result.extractedText.trim(),"");
    assert.equal(result.pageImages.length,1);
  } finally { await rm(f.job,{recursive:true,force:true}); }
});
