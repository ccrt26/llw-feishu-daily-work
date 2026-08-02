import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {
  access,chmod,mkdir,mkdtemp,readFile,rm,stat,writeFile
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  publishTaskDocxEvidence,reuseTaskDocxEvidence
} from "../src/personal-assistant/task-docx-evidence.mjs";
import {
  PNG_1X1,REL_BASE,buildDocxFixture,imageParagraph,paragraph,wordDocument
} from "./fixtures/docx-evidence-fixture.mjs";

const NOW="2026-08-02T01:00:00.000Z";

test("atomically publishes and exactly reuses trusted DOCX evidence",async()=>{
  const fixture=await evidenceFixture();
  try {
    const first=await publishTaskDocxEvidence(fixture.input);
    assert.equal(first.coverage.status,"complete");
    assert.equal(
      first.coverage.indexRelativePath,"source-001.docx-index.json"
    );
    assert.deepEqual(first.modelImageFiles.map(item=>({
      ownerPartName:item.ownerPartName,
      relationshipId:item.relationshipId,
      targetMediaPartName:item.targetMediaPartName
    })),[{
      ownerPartName:"word/document.xml",relationshipId:"rId1",
      targetMediaPartName:"word/media/body.png"
    }]);
    assert.equal(
      JSON.parse(first.observations[0].content).observations[0].text,
      "正文"
    );
    for (const name of [
      "source-001.docx-text.json",
      "source-001.docx-image-001.png",
      "source-001.docx-index.json",
      "source-001.manifest.json"
    ]) {
      assert.equal((await stat(join(fixture.workspaceDir,name))).mode&0o777,0o600);
    }
    const reused=await reuseTaskDocxEvidence({
      workspaceDir:fixture.workspaceDir,source:fixture.source
    });
    assert.deepEqual(reused,first);
    await rm(fixture.stagingDir,{recursive:true,force:true});
    await access(join(fixture.workspaceDir,"source-001.docx-text.json"));
  } finally { await rm(fixture.root,{recursive:true,force:true}); }
});

test("publishes partial coverage for reply use without promoting it to complete",async()=>{
  const fixture=await evidenceFixture({
    status:"partial",limitations:["unsupported_image_format"]
  });
  try {
    const result=await publishTaskDocxEvidence(fixture.input);
    assert.equal(result.coverage.status,"partial");
    assert.deepEqual(result.coverage.limitations,["unsupported_image_format"]);
    assert.equal(JSON.parse(result.observations[0].content).coverageStatus,"partial");
  } finally { await rm(fixture.root,{recursive:true,force:true}); }
});

test("keeps full trusted limitations while bounding the model and sidecar view",async()=>{
  const limitations=[
    "alt_chunk","chart","comments","custom_xml_binding","equation",
    "smart_art","text_box","tracked_changes","unknown_visible_xml"
  ];
  const fixture=await evidenceFixture({status:"partial",limitations});
  try {
    const first=await publishTaskDocxEvidence(fixture.input);
    assert.deepEqual(first.coverage.limitations,limitations);
    assert.equal(first.observations[0].limitations.length,8);
    assert.equal(
      first.observations[0].limitations.includes("additional_limitations"),true
    );
    const second=await reuseTaskDocxEvidence({
      workspaceDir:fixture.workspaceDir,source:fixture.source
    });
    assert.deepEqual(second,first);
  } finally { await rm(fixture.root,{recursive:true,force:true}); }
});

for (const [name,mutate] of [
  ["stale original",async fixture=>{
    await writeFile(fixture.source.absolutePath,"changed",{mode:0o600});
  }],
  ["text hash mismatch",fixture=>{
    fixture.input.representationIndex.text.sha256="f".repeat(64);
  }],
  ["image hash mismatch",fixture=>{
    fixture.input.representationIndex.images[0].sha256="f".repeat(64);
  }],
  ["path escape",fixture=>{
    fixture.input.representationIndex.text.relativePath="../escape.json";
  }],
  ["wrong owner relationship scope",fixture=>{
    fixture.input.representationIndex.images[0].ownerPartName="word/header1.xml";
  }],
  ["wrong relationship id",fixture=>{
    fixture.input.representationIndex.images[0].relationshipId="rIdMissing";
  }],
  ["wrong media target",fixture=>{
    fixture.input.representationIndex.images[0].targetMediaPartName=
      "word/media/other.png";
  }],
  ["colliding document order",fixture=>{
    fixture.input.representationIndex.images[0].documentOrder=1;
  }],
  ["invalid heading level",async fixture=>{
    const file=fixture.input.stagedFiles[0].absolutePath;
    const value=JSON.parse(await readFile(file,"utf8"));
    value.observations[0].type="heading";
    value.observations[0].level=0;
    const bytes=Buffer.from(`${JSON.stringify(value,null,2)}\n`);
    await writeFile(file,bytes,{mode:0o600});
    fixture.input.representationIndex.text.sha256=sha256(bytes);
    fixture.input.representationIndex.text.byteSize=bytes.length;
  }]
]) {
  test(`rejects DOCX evidence with ${name} before publication`,async()=>{
    const fixture=await evidenceFixture();
    try {
      await mutate(fixture);
      await assert.rejects(
        publishTaskDocxEvidence(fixture.input),
        /task_docx_evidence_invalid/
      );
      await assert.rejects(
        access(join(fixture.workspaceDir,"source-001.docx-index.json")),
        {code:"ENOENT"}
      );
    } finally { await rm(fixture.root,{recursive:true,force:true}); }
  });
}

test("fails closed instead of reusing altered or incomplete durable evidence",async()=>{
  const fixture=await evidenceFixture();
  try {
    await publishTaskDocxEvidence(fixture.input);
    await writeFile(
      join(fixture.workspaceDir,"source-001.docx-text.json"),
      "{}\n",{mode:0o600}
    );
    await assert.rejects(
      reuseTaskDocxEvidence({
        workspaceDir:fixture.workspaceDir,source:fixture.source
      }),
      /task_docx_evidence_invalid/
    );
  } finally { await rm(fixture.root,{recursive:true,force:true}); }
});

for (const [name,mutate] of [
  ["altered limitations",sidecar=>{
    sidecar.derived[0].limitations=["altered"];
  }],
  ["altered producer",sidecar=>{
    sidecar.derived[0].producedBy="other-reader";
  }]
]) {
  test(`rejects reuse with ${name} in the sidecar`,async()=>{
    const fixture=await evidenceFixture();
    try {
      await publishTaskDocxEvidence(fixture.input);
      const file=join(fixture.workspaceDir,"source-001.manifest.json");
      const sidecar=JSON.parse(await readFile(file,"utf8"));
      mutate(sidecar);
      await writeFile(file,`${JSON.stringify(sidecar,null,2)}\n`,{mode:0o600});
      await assert.rejects(
        reuseTaskDocxEvidence({
          workspaceDir:fixture.workspaceDir,source:fixture.source
        }),
        /task_docx_evidence_invalid/
      );
    } finally { await rm(fixture.root,{recursive:true,force:true}); }
  });
}

async function evidenceFixture({status="complete",limitations=[]}={}) {
  const root=await mkdtemp(join(tmpdir(),"llw-task-docx-evidence-"));
  const workspaceDir=join(root,"task");
  const stagingDir=join(root,"staging");
  await mkdir(workspaceDir,{mode:0o700});
  await mkdir(stagingDir,{mode:0o700});
  await chmod(workspaceDir,0o700);
  await chmod(stagingDir,0o700);
  const originalPath=await buildDocxFixture(workspaceDir,{
    name:"source-001.docx",
    documentXml:wordDocument(paragraph("正文")+imageParagraph("rId1")),
    extraParts:{"word/media/body.png":PNG_1X1},
    relationsByOwner:{"word/document.xml":[
      {id:"rId1",type:`${REL_BASE}/image`,target:"media/body.png"}
    ]}
  });
  await rm(join(workspaceDir,"source-001.docx-package"),{
    recursive:true,force:true
  });
  const originalBytes=await readFile(originalPath);
  const source={
    handle:{
      sourceId:"source-001",displayName:"材料.docx",
      mediaClass:"document",format:"docx",
      relativePath:"source-001.docx",byteSize:originalBytes.length,
      sha256:sha256(originalBytes),availability:"ready"
    },
    absolutePath:originalPath,archiveExtension:"docx"
  };
  const textValue={
    version:1,sourceId:"source-001",originalSha256:source.handle.sha256,
    observations:[{
      ownerPartName:"word/document.xml",documentOrder:1,
      type:"paragraph",text:"正文"
    }]
  };
  const textBytes=Buffer.from(`${JSON.stringify(textValue,null,2)}\n`);
  const textFile=join(stagingDir,"text.json");
  const imageFile=join(stagingDir,"image.png");
  await writeFile(textFile,textBytes,{mode:0o600});
  await writeFile(imageFile,PNG_1X1,{mode:0o600});
  const index={
    version:1,sourceId:"source-001",originalSha256:source.handle.sha256,
    kind:"docx",
    text:{
      relativePath:"source-001.docx-text.json",sha256:sha256(textBytes),
      byteSize:textBytes.length,observationCount:1
    },
    images:[{
      relativePath:"source-001.docx-image-001.png",
      sha256:sha256(PNG_1X1),byteSize:PNG_1X1.length,width:1,height:1,
      documentOrder:2,ownerPartName:"word/document.xml",
      relationshipId:"rId1",targetMediaPartName:"word/media/body.png"
    }],
    coverage:{
      status,limitations:[...limitations],
      parts:{
        parsed:["word/document.xml"],
        relationships:["word/_rels/document.xml.rels"],
        representedMedia:["word/media/body.png"]
      }
    }
  };
  return {
    root,workspaceDir,stagingDir,source,index,
    input:{
      workspaceDir,source,
      stagedFiles:[
        {absolutePath:textFile,relativePath:index.text.relativePath},
        {absolutePath:imageFile,relativePath:index.images[0].relativePath}
      ],
      representationIndex:structuredClone(index),
      producedBy:"llw-task-docx-reader-v1",now:NOW
    }
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
