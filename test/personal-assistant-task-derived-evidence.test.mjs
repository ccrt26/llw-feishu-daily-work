import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {
  access,chmod,lstat,mkdtemp,mkdir,readFile,rm,stat,symlink,writeFile
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  publishTaskDerivedEvidence
} from "../src/personal-assistant/task-derived-evidence.mjs";

const NOW="2026-07-30T01:00:00.000Z";

test("atomically retains ordered PDF evidence and reuses an identical publication",async()=>{
  const fixture=await evidenceFixture();
  try {
    const first=await publishTaskDerivedEvidence(fixture.input);
    assert.equal(first.representationIndexPath,"source-001.pdf-index.json");
    assert.deepEqual(
      first.modelImageFiles.map(item=>item.pageNumber),
      [1,2]
    );
    assert.deepEqual(
      first.modelImageFiles.map(item=>item.sha256),
      fixture.index.pages.map(page=>page.sha256)
    );
    assert.equal(
      JSON.parse(first.observations[0].content).textAvailable,
      true
    );
    for (const name of [
      "source-001.extracted.txt",
      "source-001.page-001.png",
      "source-001.page-002.png",
      "source-001.pdf-index.json",
      "source-001.manifest.json"
    ]) {
      assert.equal(
        (await stat(join(fixture.workspaceDir,name))).mode&0o777,
        0o600
      );
    }
    const publishedIndex=JSON.parse(await readFile(
      join(fixture.workspaceDir,first.representationIndexPath),
      "utf8"
    ));
    assert.deepEqual(
      publishedIndex.pages.map(page=>page.pageNumber),
      [1,2]
    );
    assert.deepEqual(
      publishedIndex.pages.map(page=>page.sha256),
      fixture.index.pages.map(page=>page.sha256)
    );
    const sidecar=JSON.parse(await readFile(
      join(fixture.workspaceDir,"source-001.manifest.json"),
      "utf8"
    ));
    assert.equal(sidecar.original.sourceId,"source-001");
    assert.equal(sidecar.original.sha256,fixture.source.handle.sha256);
    assert.equal(
      sidecar.derived[0].relativePath,
      "source-001.pdf-index.json"
    );

    const before=await lstat(
      join(fixture.workspaceDir,"source-001.page-001.png")
    );
    const second=await publishTaskDerivedEvidence(fixture.input);
    const after=await lstat(
      join(fixture.workspaceDir,"source-001.page-001.png")
    );
    assert.deepEqual(second,first);
    assert.equal(after.ino,before.ino);
    assert.equal(after.mtimeMs,before.mtimeMs);

    await rm(fixture.stagingDir,{recursive:true,force:true});
    await access(join(fixture.workspaceDir,"source-001.page-001.png"));
    await access(join(fixture.workspaceDir,"source-001.extracted.txt"));
  } finally {
    await rm(fixture.root,{recursive:true,force:true});
  }
});

test("keeps full bounded PDF text durable while bounding the model observation",async()=>{
  const fullText="汉".repeat(87_370);
  const fixture=await evidenceFixture({textValue:fullText});
  try {
    const result=await publishTaskDerivedEvidence(fixture.input);
    const observation=JSON.parse(result.observations[0].content);
    assert.equal(observation.textAvailable,true);
    assert.equal(observation.textTruncated,true);
    assert.ok(observation.extractedText.length<fullText.length);
    assert.ok(
      Buffer.byteLength(result.observations[0].content,"utf8")<=256*1024
    );
    assert.equal(
      await readFile(
        join(fixture.workspaceDir,"source-001.extracted.txt"),
        "utf8"
      ),
      fullText
    );
  } finally {
    await rm(fixture.root,{recursive:true,force:true});
  }
});

for (const [name,mutate] of [
  ["hash mismatch",fixture=>{
    fixture.input.representationIndex.pages[0].sha256="f".repeat(64);
  }],
  ["symlink",async fixture=>{
    await rm(fixture.pageFiles[0],{force:true});
    await symlink("/etc/hosts",fixture.pageFiles[0]);
  }],
  ["path escape",fixture=>{
    fixture.input.representationIndex.pages[0].relativePath="../escape.png";
  }],
  ["missing page",fixture=>{
    fixture.input.stagedFiles=fixture.input.stagedFiles.slice(0,-1);
  }],
  ["duplicate page",fixture=>{
    fixture.input.representationIndex.pages[1].pageNumber=1;
  }],
  ["wrong source",fixture=>{
    fixture.input.representationIndex.sourceId="source-002";
  }],
  ["cancelled task",fixture=>{
    const controller=new AbortController();
    controller.abort();
    fixture.input.signal=controller.signal;
  }]
]) {
  test(`rejects derived PDF evidence with ${name} before model exposure`,async()=>{
    const fixture=await evidenceFixture();
    try {
      await mutate(fixture);
      await assert.rejects(
        publishTaskDerivedEvidence(fixture.input),
        error=>error?.message==="task_derived_evidence_invalid"||
          error?.name==="AbortError"
      );
      await access(fixture.source.absolutePath);
      await assert.rejects(
        access(join(fixture.workspaceDir,"source-001.pdf-index.json")),
        {code:"ENOENT"}
      );
    } finally {
      await rm(fixture.root,{recursive:true,force:true});
    }
  });
}

async function evidenceFixture({
  textValue="第一页和第二页的可提取文字。"
}={}) {
  const root=await mkdtemp(join(tmpdir(),"llw-task-evidence-"));
  const workspaceDir=join(root,"task");
  const stagingDir=join(root,"processor");
  await mkdir(workspaceDir,{mode:0o700});
  await mkdir(stagingDir,{mode:0o700});
  await chmod(workspaceDir,0o700);
  await chmod(stagingDir,0o700);
  const original=Buffer.from("%PDF-1.7\nsynthetic");
  const originalPath=join(workspaceDir,"source-001.pdf");
  await writeFile(originalPath,original,{mode:0o600});
  const text=Buffer.from(textValue,"utf8");
  const textFile=join(stagingDir,"extracted.txt");
  const pageFiles=[
    join(stagingDir,"page-1.png"),
    join(stagingDir,"page-2.png")
  ];
  const pageBytes=[png(12,16,1),png(12,16,2)];
  await writeFile(textFile,text,{mode:0o600});
  await writeFile(pageFiles[0],pageBytes[0],{mode:0o600});
  await writeFile(pageFiles[1],pageBytes[1],{mode:0o600});
  const source={
    handle:{
      sourceId:"source-001",
      displayName:"扫描材料.pdf",
      mediaClass:"document",
      format:"pdf",
      relativePath:"source-001.pdf",
      byteSize:original.length,
      sha256:sha256(original),
      availability:"ready"
    },
    absolutePath:originalPath,
    archiveExtension:"pdf"
  };
  const index={
    version:1,
    sourceId:"source-001",
    originalSha256:source.handle.sha256,
    kind:"pdf",
    pageCount:2,
    extractedText:{
      relativePath:"source-001.extracted.txt",
      sha256:sha256(text),
      byteSize:text.length,
      textAvailable:true
    },
    pages:pageFiles.map((_,index)=>({
      pageNumber:index+1,
      relativePath:`source-001.page-${String(index+1).padStart(3,"0")}.png`,
      sha256:sha256(pageBytes[index]),
      byteSize:pageBytes[index].length,
      width:12,
      height:16
    })),
    coverageStatus:"complete",
    limitations:[]
  };
  const input={
    workspaceDir,
    source,
    stagedFiles:[
      {
        absolutePath:textFile,
        relativePath:index.extractedText.relativePath
      },
      ...pageFiles.map((absolutePath,index)=>({
        absolutePath,
        relativePath:index===0
          ?"source-001.page-001.png"
          :"source-001.page-002.png"
      }))
    ],
    representationIndex:structuredClone(index),
    producedBy:"pypdfium2-5.11.0",
    limitations:[],
    now:NOW
  };
  return {
    root,workspaceDir,stagingDir,textFile,pageFiles,
    pageBytes,source,index,input
  };
}

function png(width,height,marker) {
  const value=Buffer.alloc(33,0);
  Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])
    .copy(value,0);
  value.writeUInt32BE(13,8);
  value.write("IHDR",12,"ascii");
  value.writeUInt32BE(width,16);
  value.writeUInt32BE(height,20);
  value[24]=8;
  value[25]=6;
  value[32]=marker;
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
