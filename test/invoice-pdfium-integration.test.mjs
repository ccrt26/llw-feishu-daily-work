import test from "node:test";
import assert from "node:assert/strict";
import {access,mkdtemp,rm} from "node:fs/promises";
import {spawn} from "node:child_process";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {prepareInvoicePdf} from "../src/capabilities/invoice/pdf-preparer.mjs";
import {installPdfiumRuntime} from "../src/capabilities/invoice/pdfium-runtime.mjs";

const python="/Users/ccrt/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3";
const sourceVendor=process.env.LLW_PDFIUM_VENDOR||"/private/tmp/llw-pdf-debug.Ryokuf/pdfium-vendor";
const licenseRoot=process.env.LLW_PDFIUM_LICENSES||"/Users/ccrt/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/lib/python3.12/site-packages/pypdfium2-5.11.0.dist-info/licenses";
const processorSource=resolve("src/capabilities/invoice/pdfium-processor.py");
let suiteRoot,processor;

test.before(async()=>{
  await access(python);
  await access(sourceVendor);
  await access(licenseRoot);
  suiteRoot=await mkdtemp(join(tmpdir(),"llw-real-pdfium-suite-"));
  ({pdfProcessorPath:processor}=await installPdfiumRuntime({
    sourceRoot:sourceVendor,
    licenseRoot,
    processorSource,
    destinationRoot:join(suiteRoot,"runtime")
  }));
});
test.after(async()=>{ if (suiteRoot) await rm(suiteRoot,{recursive:true,force:true}); });

async function makePdf({pages=1,text=true,encrypted=false}) {
  const job=await mkdtemp(join(tmpdir(),"llw-real-pdfium-"));
  const file=join(job,"source.pdf");
  const script=[
    "from reportlab.pdfgen import canvas",
    "from pypdf import PdfReader, PdfWriter",
    "import os, sys",
    "path=sys.argv[1]",
    "pages=int(sys.argv[2])",
    "include_text=sys.argv[3] == 'yes'",
    "encrypted=sys.argv[4] == 'yes'",
    "plain=path+'.plain' if encrypted else path",
    "c=canvas.Canvas(plain)",
    "for index in range(1,pages+1):",
    "    c.rect(72,500,200,100)",
    "    if include_text: c.drawString(72,700,f'SAFE-PDF-PAGE-{index}')",
    "    c.showPage()",
    "c.save()",
    "if encrypted:",
    "    reader=PdfReader(plain); writer=PdfWriter()",
    "    for page in reader.pages: writer.add_page(page)",
    "    writer.encrypt('safe-test-password')",
    "    with open(path,'wb') as handle: writer.write(handle)",
    "    os.unlink(plain)"
  ].join("\n");
  await run(python,["-c",script,file,String(pages),text?"yes":"no",encrypted?"yes":"no"]);
  return {job,file};
}

function prepare(file,overrides={}) {
  return prepareInvoicePdf({
    file,pdfProcessorPath:processor,
    maxPages:10,maxTextBytes:262_144,maxRenderBytes:100*1024*1024,timeoutMs:60_000,
    ...overrides
  });
}

test("real PDFium extracts and renders a one-page digital PDF",async()=>{
  const f=await makePdf({pages:1,text:true});
  try {
    const result=await prepare(f.file);
    assert.deepEqual(result.documentFacts,{pageCount:1,textAvailable:true});
    assert.match(result.extractedText,/SAFE-PDF-PAGE-1/);
    assert.equal(result.pageImages.length,1);
  } finally { await rm(f.job,{recursive:true,force:true}); }
});

test("real PDFium renders all pages in order and accepts the ten-page boundary",async()=>{
  for (const pages of [2,10]) {
    const f=await makePdf({pages,text:true});
    try {
      const result=await prepare(f.file);
      assert.equal(result.documentFacts.pageCount,pages);
      assert.match(result.extractedText,/SAFE-PDF-PAGE-1/);
      assert.match(result.extractedText,new RegExp(`SAFE-PDF-PAGE-${pages}`));
      assert.deepEqual(result.pageImages.map(path=>path.split("/").at(-1)),Array.from({length:pages},(_,index)=>`page-${index+1}.png`));
    } finally { await rm(f.job,{recursive:true,force:true}); }
  }
});

test("real PDFium accepts scan-only pages with an empty text layer",async()=>{
  const f=await makePdf({pages:1,text:false});
  try {
    const result=await prepare(f.file);
    assert.deepEqual(result.documentFacts,{pageCount:1,textAvailable:false});
    assert.equal(result.extractedText.trim(),"");
  } finally { await rm(f.job,{recursive:true,force:true}); }
});

test("real PDFium rejects eleven pages and encrypted input before analysis",async()=>{
  for (const [options,code] of [[{pages:11},"pdf_page_limit"],[{pages:1,encrypted:true},"pdf_encrypted"]]) {
    const f=await makePdf(options);
    try { await assert.rejects(()=>prepare(f.file),error=>error.code===code); }
    finally { await rm(f.job,{recursive:true,force:true}); }
  }
});

function run(command,args) {
  return new Promise((resolvePromise,reject)=>{
    const child=spawn(command,args,{stdio:["ignore","ignore","pipe"]});
    let stderrBytes=0;
    child.stderr.on("data",chunk=>stderrBytes+=chunk.length);
    child.once("error",reject);
    child.once("close",code=>code===0?resolvePromise():reject(new Error(`fixture_failed:${code}:${stderrBytes}`)));
  });
}
