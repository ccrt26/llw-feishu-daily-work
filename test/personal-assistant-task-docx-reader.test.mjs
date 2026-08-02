import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {
  access,chmod,mkdir,mkdtemp,readdir,readFile,rm,stat
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {fileURLToPath} from "node:url";
import {join} from "node:path";
import {
  prepareDocxEvidenceJob
} from "../src/personal-assistant/docx-evidence-helper.mjs";
import {
  TaskDocxReader
} from "../src/personal-assistant/task-docx-reader.mjs";
import {
  PNG_1X1,REL_BASE,buildDocxFixture,imageParagraph,paragraph,wordDocument
} from "./fixtures/docx-evidence-fixture.mjs";

const HELPER=fileURLToPath(new URL(
  "../src/personal-assistant/docx-evidence-helper.mjs",import.meta.url
));
const NOW="2026-08-02T01:00:00.000Z";

test("runs the DOCX helper in a child and returns durable trusted evidence",async()=>{
  const fixture=await readerFixture();
  try {
    const result=await fixture.reader.prepare(fixture.input);
    assert.equal(result.coverageBySource["source-001"].status,"complete");
    assert.deepEqual(
      result.modelImageFiles.map(item=>item.relationshipId),["rId1"]
    );
    assert.equal(JSON.parse(result.observations[0].content)
      .observations[0].text,"正文1");
    for (const name of [
      "source-001.docx-text.json","source-001.docx-image-001.png",
      "source-001.docx-index.json","source-001.manifest.json"
    ]) {
      assert.equal((await stat(join(fixture.workspaceDir,name))).mode&0o777,0o600);
    }
    assert.deepEqual(await readdir(fixture.tempRoot),[]);
  } finally { await rm(fixture.root,{recursive:true,force:true}); }
});

test("reuses exact DOCX evidence without running the helper again",async()=>{
  let calls=0;
  const fixture=await readerFixture({
    runHelper:async({job})=>{
      calls+=1;
      return prepareDocxEvidenceJob(job);
    }
  });
  try {
    const first=await fixture.reader.prepare(fixture.input);
    const second=await fixture.reader.prepare(fixture.input);
    assert.deepEqual(second,first);
    assert.equal(calls,1);
  } finally { await rm(fixture.root,{recursive:true,force:true}); }
});

test("enforces one parent deadline for the whole DOCX preparation",async()=>{
  let aborted=false;
  const fixture=await readerFixture({
    timeoutMs:50,
    runHelper:({signal})=>new Promise((_resolve,reject)=>{
      signal.addEventListener("abort",()=>{
        aborted=true;
        reject(signal.reason);
      },{once:true});
    })
  });
  try {
    const started=Date.now();
    await assert.rejects(
      fixture.reader.prepare(fixture.input),
      error=>error?.message==="docx_prepare_failed"
    );
    assert.equal(aborted,true);
    assert.equal(Date.now()-started<1_000,true);
    await access(fixture.sources[0].absolutePath);
    await assert.rejects(
      access(join(fixture.workspaceDir,"source-001.docx-index.json")),
      {code:"ENOENT"}
    );
    assert.deepEqual(await readdir(fixture.tempRoot),[]);
  } finally { await rm(fixture.root,{recursive:true,force:true}); }
});

test("stops an already-cancelled DOCX task before helper or publication",async()=>{
  let calls=0;
  const fixture=await readerFixture({runHelper:async()=>{calls+=1;}});
  const controller=new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      fixture.reader.prepare({...fixture.input,signal:controller.signal}),
      error=>error?.name==="AbortError"
    );
    assert.equal(calls,0);
    assert.deepEqual(await readdir(fixture.tempRoot),[]);
  } finally { await rm(fixture.root,{recursive:true,force:true}); }
});

test("keeps multiple DOCX sources disjoint and skips non-DOCX sources",async()=>{
  const fixture=await readerFixture({sourceCount:2,includeText:true});
  try {
    const result=await fixture.reader.prepare(fixture.input);
    assert.deepEqual(Object.keys(result.coverageBySource),[
      "source-001","source-002"
    ]);
    assert.deepEqual(result.modelImageFiles.map(item=>item.relativePath),[
      "source-001.docx-image-001.png",
      "source-002.docx-image-001.png"
    ]);
  } finally { await rm(fixture.root,{recursive:true,force:true}); }
});

async function readerFixture({
  runHelper,timeoutMs=2_000,sourceCount=1,includeText=false
}={}) {
  const root=await mkdtemp(join(tmpdir(),"llw-task-docx-reader-"));
  const workspaceDir=join(root,"task");
  const tempRoot=join(root,"jobs");
  await mkdir(workspaceDir,{mode:0o700});
  await mkdir(tempRoot,{mode:0o700});
  await chmod(workspaceDir,0o700);
  await chmod(tempRoot,0o700);
  const sources=[];
  for (let index=0;index<sourceCount;index+=1) {
    const sourceId=`source-${String(index+1).padStart(3,"0")}`;
    const absolutePath=await buildDocxFixture(workspaceDir,{
      name:`${sourceId}.docx`,
      documentXml:wordDocument(
        paragraph(`正文${index+1}`)+imageParagraph("rId1")
      ),
      extraParts:{[`word/media/body-${index+1}.png`]:PNG_1X1},
      relationsByOwner:{"word/document.xml":[
        {id:"rId1",type:`${REL_BASE}/image`,
          target:`media/body-${index+1}.png`}
      ]}
    });
    await rm(join(workspaceDir,`${sourceId}.docx-package`),{
      recursive:true,force:true
    });
    const bytes=await readFile(absolutePath);
    sources.push({
      handle:{
        sourceId,displayName:`材料${index+1}.docx`,mediaClass:"document",
        format:"docx",relativePath:`${sourceId}.docx`,byteSize:bytes.length,
        sha256:createHash("sha256").update(bytes).digest("hex"),
        availability:"ready"
      },
      absolutePath,archiveExtension:"docx"
    });
  }
  if (includeText) {
    const index=sources.length+1;
    const sourceId=`source-${String(index).padStart(3,"0")}`;
    sources.push({
      handle:{
        sourceId,displayName:"说明.txt",mediaClass:"document",format:"txt",
        relativePath:`${sourceId}.txt`,byteSize:1,
        sha256:"a".repeat(64),availability:"ready"
      },
      absolutePath:join(workspaceDir,`${sourceId}.txt`),archiveExtension:"txt"
    });
  }
  const reader=new TaskDocxReader({
    helperPath:HELPER,tempRoot,timeoutMs,
    ...(runHelper?{runHelper}:{})
  });
  return {
    root,workspaceDir,tempRoot,sources,reader,
    input:{workspaceDir,sources,now:NOW}
  };
}
