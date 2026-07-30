import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {
  access,chmod,mkdtemp,mkdir,readFile,rm,writeFile
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {prepareInvoicePdf} from "../src/capabilities/invoice/pdf-preparer.mjs";
import {
  TaskPdfReader
} from "../src/personal-assistant/task-pdf-reader.mjs";

const fake=fileURLToPath(
  new URL("./fixtures/fake-pdfium-processor.mjs",import.meta.url)
);
const NOW="2026-07-30T01:00:00.000Z";

test("prepares a scanned PDF once and returns two ordered durable model pages",async()=>{
  const fixture=await pdfFixture({text:"",pages:2});
  try {
    const result=await fixture.reader.prepare(fixture.input);
    assert.equal(await readFile(fixture.countFile,"utf8"),"1");
    assert.deepEqual(
      result.modelImageFiles.map(item=>item.pageNumber),
      [1,2]
    );
    assert.equal(
      JSON.parse(result.observations[0].content).textAvailable,
      false
    );
    for (const item of result.modelImageFiles) {
      await access(join(fixture.workspaceDir,item.relativePath));
    }
    await assert.rejects(
      access(join(fixture.tempRoot,"analysis")),
      {code:"ENOENT"}
    );
  } finally {
    await rm(fixture.root,{recursive:true,force:true});
  }
});

for (const [name,text] of [
  ["text-layer","可提取的正文"],
  ["mixed","页面文字和扫描图并存"]
]) {
  test(`prepares ${name} PDF once and retains extracted text`,async()=>{
    const fixture=await pdfFixture({text,pages:2});
    try {
      const result=await fixture.reader.prepare(fixture.input);
      assert.equal(await readFile(fixture.countFile,"utf8"),"1");
      const observation=JSON.parse(result.observations[0].content);
      assert.equal(observation.textAvailable,true);
      assert.equal(observation.extractedText,text);
      assert.deepEqual(
        result.modelImageFiles.map(item=>item.pageNumber),
        [1,2]
      );
    } finally {
      await rm(fixture.root,{recursive:true,force:true});
    }
  });
}

test("reuses durable PDF evidence after an AI retry without rerunning PDFium",async()=>{
  const fixture=await pdfFixture({text:"",pages:2});
  try {
    const first=await fixture.reader.prepare(fixture.input);
    const second=await fixture.reader.prepare(fixture.input);
    assert.deepEqual(second,first);
    assert.equal(await readFile(fixture.countFile,"utf8"),"1");
    await access(fixture.sources[0].absolutePath);
  } finally {
    await rm(fixture.root,{recursive:true,force:true});
  }
});

for (const [mode,limits] of [
  ["encrypted",{}],
  ["structure",{}],
  ["page_missing",{}],
  ["manifest_duplicate",{}],
  ["page_limit",{}],
  ["text_oversize",{maxTextBytes:1024}],
  ["render_oversize",{maxRenderBytes:512}],
  ["sleep",{timeoutMs:50}]
]) {
  test(`maps PDF preparation ${mode} to one retryable failure`,async()=>{
    const fixture=await pdfFixture({mode,...limits});
    try {
      await assert.rejects(
        fixture.reader.prepare(fixture.input),
        error=>error?.message==="pdf_prepare_failed"&&
          Object.keys(error).length===0
      );
      await access(fixture.sources[0].absolutePath);
      await assert.rejects(
        access(join(fixture.workspaceDir,"source-001.pdf-index.json")),
        {code:"ENOENT"}
      );
    } finally {
      await rm(fixture.root,{recursive:true,force:true});
    }
  });
}

test("stops a cancelled PDF task before processor or evidence publication",async()=>{
  const fixture=await pdfFixture();
  const controller=new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      fixture.reader.prepare({...fixture.input,signal:controller.signal}),
      error=>error?.name==="AbortError"
    );
    await assert.rejects(readFile(fixture.countFile,"utf8"),{code:"ENOENT"});
    await assert.rejects(
      access(join(fixture.workspaceDir,"source-001.pdf-index.json")),
      {code:"ENOENT"}
    );
  } finally {
    await rm(fixture.root,{recursive:true,force:true});
  }
});

test("keeps two PDFs in disjoint source-derived evidence names",async()=>{
  const fixture=await pdfFixture({sourceCount:2,text:""});
  try {
    const result=await fixture.reader.prepare(fixture.input);
    assert.equal(await readFile(fixture.countFile,"utf8"),"2");
    assert.deepEqual(
      result.modelImageFiles.map(item=>
        `${item.sourceId}:${item.relativePath}`
      ),
      [
        "source-001:source-001.page-001.png",
        "source-001:source-001.page-002.png",
        "source-002:source-002.page-001.png",
        "source-002:source-002.page-002.png"
      ]
    );
  } finally {
    await rm(fixture.root,{recursive:true,force:true});
  }
});

async function pdfFixture({
  mode="ok",pages=2,text="",sourceCount=1,
  maxTextBytes=262_144,maxRenderBytes=100*1024*1024,
  timeoutMs=2_000
}={}) {
  const root=await mkdtemp(join(tmpdir(),"llw-task-pdf-reader-"));
  const workspaceDir=join(root,"task");
  const tempRoot=join(root,"processor-jobs");
  const countFile=join(root,"processor-count");
  await mkdir(workspaceDir,{mode:0o700});
  await mkdir(tempRoot,{mode:0o700});
  await chmod(workspaceDir,0o700);
  await chmod(tempRoot,0o700);
  await chmod(fake,0o700);
  const sources=[];
  for (let index=0;index<sourceCount;index+=1) {
    const sourceId=`source-${String(index+1).padStart(3,"0")}`;
    const bytes=Buffer.from(`%PDF-1.7\nsynthetic-${sourceId}`);
    const absolutePath=join(workspaceDir,`${sourceId}.pdf`);
    await writeFile(absolutePath,bytes,{mode:0o600});
    sources.push({
      handle:{
        sourceId,
        displayName:`材料-${index+1}.pdf`,
        mediaClass:"document",
        format:"pdf",
        relativePath:`${sourceId}.pdf`,
        byteSize:bytes.length,
        sha256:createHash("sha256").update(bytes).digest("hex"),
        availability:"ready"
      },
      absolutePath,
      archiveExtension:"pdf"
    });
  }
  const environment={
    ...process.env,
    FAKE_PDFIUM_MODE:mode,
    FAKE_PDFIUM_PAGES:String(pages),
    FAKE_PDFIUM_TEXT:text,
    FAKE_PDFIUM_COUNT:countFile
  };
  const reader=new TaskPdfReader({
    pdfProcessorPath:fake,
    preparePdf:options=>prepareInvoicePdf({...options,environment}),
    tempRoot,
    maxPages:10,
    maxTextBytes,
    maxRenderBytes,
    maxDimension:3508,
    timeoutMs
  });
  return {
    root,workspaceDir,tempRoot,countFile,sources,reader,
    input:{workspaceDir,sources,now:NOW}
  };
}
