import test from "node:test";
import assert from "node:assert/strict";
import {chmod,mkdtemp,mkdir,readFile,rm,stat,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename,join} from "node:path";
import {fileURLToPath} from "node:url";
import {prepareInvoicePdf} from "../src/capabilities/invoice/pdf-preparer.mjs";

const fake=fileURLToPath(new URL("./fixtures/fake-pdfium-processor.mjs",import.meta.url));

async function fixture({
  mode="ok",pages=2,text="invoice text",maxTextBytes=262_144,
  maxRenderBytes=100*1024*1024,timeoutMs=2_000
}={}) {
  await chmod(fake,0o700);
  const job=await mkdtemp(join(tmpdir(),"llw-pdfium-unit-"));
  await chmod(job,0o700);
  const pdf=join(job,"source.pdf");
  const argsFile=join(job,"args.json"),countFile=join(job,"count");
  await writeFile(pdf,"%PDF-1.7\nfixture");
  return {
    job,pdf,argsFile,countFile,
    options:{
      file:pdf,pdfProcessorPath:fake,maxPages:10,maxTextBytes,maxRenderBytes,timeoutMs,
      environment:{
        ...process.env,
        FAKE_PDFIUM_MODE:mode,
        FAKE_PDFIUM_PAGES:String(pages),
        FAKE_PDFIUM_TEXT:text,
        FAKE_PDFIUM_ARGS:argsFile,
        FAKE_PDFIUM_COUNT:countFile
      }
    }
  };
}

test("uses one processor and returns every verified PDF page in order",async()=>{
  const f=await fixture({pages:2});
  try {
    const result=await prepareInvoicePdf(f.options);
    assert.equal(await readFile(f.countFile,"utf8"),"1");
    assert.equal(result.originalFile,f.pdf);
    assert.equal(result.detectedFormat,"pdf");
    assert.equal(result.archiveExtension,"pdf");
    assert.deepEqual(result.pageImages.map(image=>basename(image)),["page-1.png","page-2.png"]);
    assert.equal(result.extractedText,"invoice text");
    assert.deepEqual(result.documentFacts,{pageCount:2,textAvailable:true});
    const args=JSON.parse(await readFile(f.argsFile,"utf8"));
    assert.deepEqual(args,[
      "--input",f.pdf,
      "--output",join(f.job,"analysis"),
      "--max-pages","10",
      "--max-text-bytes","262144",
      "--max-render-bytes",String(100*1024*1024),
      "--max-dimension","3508"
    ]);
    assert.equal((await stat(join(f.job,"analysis"))).mode&0o077,0);
  } finally { await rm(f.job,{recursive:true,force:true}); }
});

test("allows an empty text layer after every page is rendered",async()=>{
  const f=await fixture({pages:1,text:""});
  try {
    const result=await prepareInvoicePdf(f.options);
    assert.equal(result.extractedText,"");
    assert.deepEqual(result.documentFacts,{pageCount:1,textAvailable:false});
  } finally { await rm(f.job,{recursive:true,force:true}); }
});

test("accepts exactly ten rendered pages",async()=>{
  const f=await fixture({pages:10});
  try { assert.equal((await prepareInvoicePdf(f.options)).pageImages.length,10); }
  finally { await rm(f.job,{recursive:true,force:true}); }
});

for (const [mode,code] of [
  ["encrypted","pdf_encrypted"],
  ["structure","pdf_structure_invalid"],
  ["page_limit","pdf_page_limit"],
  ["text_error","pdf_text_invalid"],
  ["render_error","pdf_render_invalid"],
  ["unknown_exit","pdf_structure_invalid"]
]) test(`maps processor ${mode} to ${code} without exposing paths`,async()=>{
  const f=await fixture({mode});
  try {
    await assert.rejects(()=>prepareInvoicePdf(f.options),error=>{
      assert.equal(error.code,code);
      assert.equal(error.message,code);
      assert.equal(error.message.includes(f.pdf),false);
      return true;
    });
  } finally { await rm(f.job,{recursive:true,force:true}); }
});

for (const mode of [
  "manifest_unknown","manifest_version","manifest_missing","manifest_duplicate",
  "manifest_wrong_count","manifest_bad_name","manifest_invalid_json","extra_file"
]) test(`rejects unsafe manifest output ${mode}`,async()=>{
  const f=await fixture({mode});
  try { await assert.rejects(()=>prepareInvoicePdf(f.options),error=>error.code==="pdf_render_invalid"); }
  finally { await rm(f.job,{recursive:true,force:true}); }
});

for (const [mode,code,limits] of [
  ["text_directory","pdf_text_invalid",{}],
  ["text_link","pdf_text_invalid",{}],
  ["text_nonutf8","pdf_text_invalid",{}],
  ["text_oversize","pdf_text_invalid",{maxTextBytes:1024}],
  ["page_directory","pdf_render_invalid",{}],
  ["page_link","pdf_render_invalid",{}],
  ["empty_png","pdf_render_invalid",{}],
  ["bad_png","pdf_render_invalid",{}],
  ["render_oversize","pdf_render_invalid",{maxRenderBytes:512}]
]) test(`rejects unsafe processor file output ${mode}`,async()=>{
  const f=await fixture({mode,...limits});
  try { await assert.rejects(()=>prepareInvoicePdf(f.options),error=>error.code===code); }
  finally { await rm(f.job,{recursive:true,force:true}); }
});

test("times out the one processor without exposing child output",async()=>{
  const f=await fixture({mode:"sleep",timeoutMs:50});
  try { await assert.rejects(()=>prepareInvoicePdf(f.options),error=>error.code==="pdf_prepare_timeout"); }
  finally { await rm(f.job,{recursive:true,force:true}); }
});

test("rejects a pre-existing analysis directory before spawning",async()=>{
  const f=await fixture();
  await mkdir(join(f.job,"analysis"));
  try {
    await assert.rejects(()=>prepareInvoicePdf(f.options),error=>error.code==="pdf_structure_invalid");
    await assert.rejects(()=>readFile(f.countFile,"utf8"));
  } finally { await rm(f.job,{recursive:true,force:true}); }
});
