import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {
  chmod,mkdtemp,rm,symlink,writeFile
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  validateModelImageEvidence
} from "../src/personal-assistant/model-image-evidence.mjs";

test("accepts ordered hashed PDF pages and returns only relative paths",async()=>{
  const fixture=await imageFixture();
  try {
    assert.deepEqual(
      await validateModelImageEvidence({
        workspaceDir:fixture.workspaceDir,
        files:fixture.files
      }),
      [
        "source-001.page-001.png",
        "source-001.page-002.png"
      ]
    );
  } finally {
    await rm(fixture.workspaceDir,{recursive:true,force:true});
  }
});

for (const [name,mutate] of [
  ["absolute path",fixture=>{
    fixture.files[0].relativePath=fixture.paths[0];
  }],
  ["parent traversal",fixture=>{
    fixture.files[0].relativePath="../page.png";
  }],
  ["NUL",fixture=>{
    fixture.files[0].relativePath="source-001.\0page.png";
  }],
  ["backslash",fixture=>{
    fixture.files[0].relativePath="source-001.\\page.png";
  }],
  ["wrong source prefix",fixture=>{
    fixture.files[0].sourceId="source-002";
  }],
  ["duplicate file",fixture=>{
    fixture.files[1].relativePath=fixture.files[0].relativePath;
    fixture.files[1].sha256=fixture.files[0].sha256;
  }],
  ["hash mismatch",fixture=>{
    fixture.files[0].sha256="f".repeat(64);
  }],
  ["noncontiguous page",fixture=>{
    fixture.files[1].pageNumber=3;
  }],
  ["duplicate page",fixture=>{
    fixture.files[1].pageNumber=1;
  }]
]) {
  test(`rejects derived image evidence with ${name}`,async()=>{
    const fixture=await imageFixture();
    try {
      mutate(fixture);
      await assert.rejects(
        validateModelImageEvidence({
          workspaceDir:fixture.workspaceDir,
          files:fixture.files
        }),
        /model_image_evidence_invalid/u
      );
    } finally {
      await rm(fixture.workspaceDir,{recursive:true,force:true});
    }
  });
}

test("rejects a symlink and a descriptor resolving outside the workspace",async()=>{
  const fixture=await imageFixture();
  try {
    await rm(fixture.paths[0]);
    await symlink("/etc/hosts",fixture.paths[0]);
    await assert.rejects(
      validateModelImageEvidence({
        workspaceDir:fixture.workspaceDir,
        files:fixture.files
      }),
      /model_image_evidence_invalid/u
    );
  } finally {
    await rm(fixture.workspaceDir,{recursive:true,force:true});
  }
});

for (const [name,bytes,limits] of [
  ["non-PNG",Buffer.from("not-png"),{}],
  ["malformed PNG",png(12,16,1).subarray(0,20),{}],
  ["zero dimension",png(0,16,1),{}],
  ["oversized dimension",png(3509,16,1),{}],
  ["oversized pixel count",png(3508,3508,1),{maxPixels:1000}],
  ["total bytes",png(12,16,1),{maxTotalBytes:16}]
]) {
  test(`rejects ${name} derived image bytes`,async()=>{
    const fixture=await imageFixture({firstBytes:bytes});
    try {
      await assert.rejects(
        validateModelImageEvidence({
          workspaceDir:fixture.workspaceDir,
          files:fixture.files,
          ...limits
        }),
        /model_image_evidence_invalid/u
      );
    } finally {
      await rm(fixture.workspaceDir,{recursive:true,force:true});
    }
  });
}

test("rejects too many images before reading them",async()=>{
  const fixture=await imageFixture();
  try {
    await assert.rejects(
      validateModelImageEvidence({
        workspaceDir:fixture.workspaceDir,
        files:Array.from({length:17},(_,index)=>({
          ...fixture.files[0],
          relativePath:`source-001.page-${String(index+1).padStart(3,"0")}.png`,
          pageNumber:index+1
        }))
      }),
      /model_image_evidence_invalid/u
    );
  } finally {
    await rm(fixture.workspaceDir,{recursive:true,force:true});
  }
});

for (const descriptor of [
  {
    sourceId:"source-001",
    relativePath:"source-001.frame-001.png",
    sha256:"a".repeat(64),
    startMs:-1,endMs:1_000
  },
  {
    sourceId:"source-001",
    relativePath:"source-001.frame-001.png",
    sha256:"a".repeat(64),
    startMs:1_000,endMs:1_000
  },
  {
    sourceId:"source-001",
    relativePath:"source-001.frame-001.png",
    sha256:"a".repeat(64),
    pageNumber:1,startMs:0,endMs:1_000
  }
]) {
  test("rejects an invalid video time-range descriptor",async()=>{
    const fixture=await imageFixture();
    try {
      await assert.rejects(
        validateModelImageEvidence({
          workspaceDir:fixture.workspaceDir,
          files:[descriptor]
        }),
        /model_image_evidence_invalid/u
      );
    } finally {
      await rm(fixture.workspaceDir,{recursive:true,force:true});
    }
  });
}

async function imageFixture({firstBytes=png(12,16,1)}={}) {
  const workspaceDir=await mkdtemp(join(tmpdir(),"llw-model-images-"));
  await chmod(workspaceDir,0o700);
  const paths=[
    join(workspaceDir,"source-001.page-001.png"),
    join(workspaceDir,"source-001.page-002.png")
  ];
  const bytes=[firstBytes,png(12,16,2)];
  await writeFile(paths[0],bytes[0],{mode:0o600});
  await writeFile(paths[1],bytes[1],{mode:0o600});
  return {
    workspaceDir,paths,
    files:paths.map((_,index)=>({
      sourceId:"source-001",
      relativePath:`source-001.page-${String(index+1).padStart(3,"0")}.png`,
      sha256:sha256(bytes[index]),
      pageNumber:index+1
    }))
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
