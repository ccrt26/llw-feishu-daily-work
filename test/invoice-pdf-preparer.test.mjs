import test from "node:test";
import assert from "node:assert/strict";
import {chmod,mkdtemp,mkdir,rm,stat,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename,join} from "node:path";
import {fileURLToPath} from "node:url";
import {prepareInvoicePdf} from "../src/capabilities/invoice/pdf-preparer.mjs";

const fake=fileURLToPath(new URL("./fixtures/fake-poppler.mjs",import.meta.url));

async function fixture({mode="ok",pages=2,text="invoice text",maxTextBytes=262144,maxRenderBytes=104857600,timeoutMs=2000}={}) {
  await chmod(fake,0o755);
  const job=await mkdtemp(join(tmpdir(),"llw-pdf-unit-"));
  await chmod(job,0o700);
  const pdf=join(job,"source.pdf");
  await writeFile(pdf,"%PDF-1.7\nfixture");
  return {
    job,pdf,
    options:{
      file:pdf,pdfInfoPath:fake,pdfToTextPath:fake,pdfToPpmPath:fake,
      maxPages:10,maxTextBytes,maxRenderBytes,timeoutMs,
      environment:{...process.env,FAKE_POPPLER_MODE:mode,FAKE_PAGES:String(pages),FAKE_TEXT:text}
    }
  };
}

test("prepares every PDF page in order and keeps original as archive source", async () => {
  const f=await fixture({pages:2});
  try {
    const result=await prepareInvoicePdf(f.options);
    assert.equal(result.originalFile,f.pdf);
    assert.equal(result.detectedFormat,"pdf");
    assert.equal(result.archiveExtension,"pdf");
    assert.deepEqual(result.pageImages.map(image => basename(image)),["page-1.png","page-2.png"]);
    assert.equal(result.extractedText,"invoice text");
    assert.deepEqual(result.documentFacts,{pageCount:2,textAvailable:true});
    assert.equal((await stat(join(f.job,"analysis"))).mode & 0o077,0);
  } finally { await rm(f.job,{recursive:true,force:true}); }
});

test("allows an empty text layer when all pages render", async () => {
  const f=await fixture({pages:1,text:""});
  try {
    const result=await prepareInvoicePdf(f.options);
    assert.equal(result.extractedText,"");
    assert.deepEqual(result.documentFacts,{pageCount:1,textAvailable:false});
    assert.equal(result.pageImages.length,1);
  } finally { await rm(f.job,{recursive:true,force:true}); }
});

test("accepts exactly ten rendered pages", async () => {
  const f=await fixture({pages:10});
  try { assert.equal((await prepareInvoicePdf(f.options)).pageImages.length,10); }
  finally { await rm(f.job,{recursive:true,force:true}); }
});

for (const [mode,code] of [
  ["encrypted","pdf_encrypted"], ["page0","pdf_page_limit"], ["page11","pdf_page_limit"],
  ["missing_pages","pdf_structure_invalid"], ["duplicate_pages","pdf_structure_invalid"],
  ["big_info","pdf_structure_invalid"], ["info_fail","pdf_structure_invalid"],
  ["text_fail","pdf_text_invalid"], ["text_missing","pdf_text_invalid"],
  ["text_directory","pdf_text_invalid"], ["text_link","pdf_text_invalid"],
  ["text_nonutf8","pdf_text_invalid"], ["text_oversize","pdf_text_invalid"],
  ["render_fail","pdf_render_invalid"], ["missing_page","pdf_render_invalid"],
  ["extra_page","pdf_render_invalid"], ["render_directory","pdf_render_invalid"],
  ["render_link","pdf_render_invalid"], ["empty_png","pdf_render_invalid"],
  ["bad_png","pdf_render_invalid"], ["render_oversize","pdf_render_invalid"],
  ["unexpected_directory","pdf_render_invalid"]
]) test(`rejects unsafe PDF preparation mode ${mode}`, async () => {
  const f=await fixture({mode,maxTextBytes:mode==="text_oversize"?1024:262144,maxRenderBytes:mode==="render_oversize"?512:104857600});
  try {
    await assert.rejects(() => prepareInvoicePdf(f.options),error => {
      assert.equal(error.code,code);
      assert.equal(error.message,code);
      assert.equal(error.message.includes(f.pdf),false);
      assert.equal(error.message.includes("secret"),false);
      return true;
    });
  } finally { await rm(f.job,{recursive:true,force:true}); }
});

for (const mode of ["sleep_info","sleep_text","sleep_render"]) test(`times out ${mode} without exposing child output`, async () => {
  const f=await fixture({mode,timeoutMs:50});
  try {
    await assert.rejects(() => prepareInvoicePdf(f.options),error => error.code === "pdf_prepare_timeout" && error.message === "pdf_prepare_timeout");
  } finally { await rm(f.job,{recursive:true,force:true}); }
});

test("rejects a pre-existing analysis directory", async () => {
  const f=await fixture();
  await mkdir(join(f.job,"analysis"));
  try { await assert.rejects(() => prepareInvoicePdf(f.options),error => error.code === "pdf_structure_invalid"); }
  finally { await rm(f.job,{recursive:true,force:true}); }
});
