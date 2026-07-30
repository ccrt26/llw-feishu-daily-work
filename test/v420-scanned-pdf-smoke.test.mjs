import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {
  chmod,mkdtemp,readFile,rm
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {prepareInvoicePdf} from "../src/capabilities/invoice/pdf-preparer.mjs";
import {
  runScannedPdfSmoke,
  validateScannedPdfSmokeReport
} from "../scripts/v420-scanned-pdf-smoke.mjs";

const sourcePdf=fileURLToPath(
  new URL("./fixtures/v420/scanned-one-page.pdf",import.meta.url)
);
const fakePdfium=fileURLToPath(
  new URL("./fixtures/fake-pdfium-processor.mjs",import.meta.url)
);
const NOW="2026-07-30T03:00:00.000Z";

test("runs one bounded no-text-layer PDF smoke with image evidence and no Writer",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v420-smoke-test-"));
  const calls=[];
  try {
    await chmod(fakePdfium,0o700);
    const report=await runScannedPdfSmoke({
      sourcePdf,
      codexPath:"/test/codex",
      pdfProcessorPath:fakePdfium,
      skillBundle:syntheticSkillBundle(),
      tempRoot:root,
      timeoutMs:120_000,
      now:()=>NOW,
      clock:()=>1_000,
      preparePdf:options=>prepareInvoicePdf({
        ...options,
        environment:{
          ...process.env,
          FAKE_PDFIUM_PAGES:"1",
          FAKE_PDFIUM_TEXT:""
        }
      }),
      invokeCodex:async options=>{
        calls.push(options);
        return {type:"reply",text:"这是一份仅含扫描图像的合成材料。"};
      }
    });

    assert.equal(calls.length,1);
    assert.equal(calls[0].timeoutMs,120_000);
    assert.equal(calls[0].modelImageFiles.length,1);
    assert.deepEqual(report,{
      sourceSha256:createHash("sha256")
        .update(await readFile(sourcePdf))
        .digest("hex"),
      pageCount:1,
      pageImageSha256:calls[0].modelImageFiles[0].sha256,
      codexImageCount:1,
      elapsedMs:0,
      outcomeStatus:"reply",
      writerCalls:0,
      diagnosticCode:null
    });
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test("refuses a text-layer PDF advertised as the scanned fixture",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v420-smoke-text-"));
  try {
    await chmod(fakePdfium,0o700);
    await assert.rejects(
      runScannedPdfSmoke({
        sourcePdf,
        codexPath:"/test/codex",
        pdfProcessorPath:fakePdfium,
        skillBundle:syntheticSkillBundle(),
        tempRoot:root,
        timeoutMs:120_000,
        now:()=>NOW,
        preparePdf:options=>prepareInvoicePdf({
          ...options,
          environment:{
            ...process.env,
            FAKE_PDFIUM_PAGES:"1",
            FAKE_PDFIUM_TEXT:"hidden searchable text"
          }
        }),
        invokeCodex:async()=>({type:"reply",text:"unexpected"})
      }),
      error=>error?.message==="smoke_fixture_not_scanned"
    );
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test("refuses a timeout above the production-equivalent 120 second ceiling",async()=>{
  await assert.rejects(
    runScannedPdfSmoke({
      sourcePdf,
      codexPath:"/test/codex",
      pdfProcessorPath:fakePdfium,
      skillBundle:syntheticSkillBundle(),
      tempRoot:tmpdir(),
      timeoutMs:120_001,
      invokeCodex:async()=>({type:"reply",text:"unexpected"})
    }),
    error=>error?.message==="smoke_configuration_invalid"
  );
});

test("report schema refuses missing image evidence, Writer calls, and leaks",()=>{
  const safe={
    sourceSha256:"a".repeat(64),
    pageCount:1,
    pageImageSha256:"b".repeat(64),
    codexImageCount:1,
    elapsedMs:42,
    outcomeStatus:"reply",
    writerCalls:0,
    diagnosticCode:null
  };
  assert.deepEqual(validateScannedPdfSmokeReport(safe),safe);

  for (const changed of [
    {...safe,codexImageCount:0},
    {...safe,writerCalls:1},
    {...safe,sourcePath:"/private/tmp/source.pdf"},
    {...safe,sourceContent:"private source content"},
    {...safe,promptContent:"先总结，不保存"},
    {...safe,senderId:"ou_private_platform_identifier"}
  ]) {
    assert.throws(
      ()=>validateScannedPdfSmokeReport(changed),
      /smoke_report_invalid/
    );
  }
});

function syntheticSkillBundle() {
  const content="# Synthetic LLW Personal Assistant\n";
  return {
    content,
    fileCount:1,
    totalBytes:Buffer.byteLength(content,"utf8"),
    sha256:createHash("sha256").update(content).digest("hex")
  };
}
