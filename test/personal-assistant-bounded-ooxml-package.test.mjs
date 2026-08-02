import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {
  chmod,mkdir,mkdtemp,readFile,rm,writeFile
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname,join} from "node:path";
import {promisify} from "node:util";
import {
  assertSafeOoxmlXml,
  openBoundedOoxmlPackage,
  parseOoxmlRelationships,
  resolveOoxmlTarget
} from "../src/personal-assistant/bounded-ooxml-package.mjs";

const run=promisify(execFile);
const RELATIONSHIPS_NAMESPACE=
  "http://schemas.openxmlformats.org/package/2006/relationships";
const HYPERLINK_TYPE=
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";

async function zipFixture(root,{name="fixture.docx",parts}={}) {
  const packageRoot=join(root,`${name}-package`);
  for (const [part,content] of Object.entries(parts||{
    "[Content_Types].xml":"<Types/>",
    "word/document.xml":"<document>safe</document>"
  })) {
    const target=join(packageRoot,part);
    await mkdir(dirname(target),{recursive:true,mode:0o700});
    await writeFile(target,content,{mode:0o600});
  }
  const output=join(root,name);
  await run("/usr/bin/zip",["-q","-0","-r",output,"."],{
    cwd:packageRoot
  });
  await chmod(output,0o600);
  return output;
}

test("opens a bounded package only when its expected hash matches",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-bounded-ooxml-open-"));
  try {
    const file=await zipFixture(root);
    const bytes=await readFile(file);
    const sha256=createHash("sha256").update(bytes).digest("hex");
    const archive=await openBoundedOoxmlPackage(file,{
      expectedSha256:sha256,
      maxEntries:8,
      maxEntryBytes:1024,
      maxTotalBytes:4096
    });
    assert.deepEqual(archive.entryNames,[
      "[Content_Types].xml","word/","word/document.xml"
    ]);
    assert.equal(
      archive.readEntry("word/document.xml").toString("utf8"),
      "<document>safe</document>"
    );
    await assert.rejects(
      ()=>openBoundedOoxmlPackage(file,{
        expectedSha256:"0".repeat(64),maxEntries:8,
        maxEntryBytes:1024,maxTotalBytes:4096
      }),
      /bounded_ooxml_invalid/
    );
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("enforces entry and aggregate resource limits before extraction",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-bounded-ooxml-limits-"));
  try {
    const file=await zipFixture(root,{parts:{
      "[Content_Types].xml":"<Types/>",
      "word/document.xml":"x".repeat(128)
    }});
    for (const limits of [
      {maxEntries:2,maxEntryBytes:1024,maxTotalBytes:4096},
      {maxEntries:8,maxEntryBytes:64,maxTotalBytes:4096},
      {maxEntries:8,maxEntryBytes:1024,maxTotalBytes:64}
    ]) {
      await assert.rejects(
        ()=>openBoundedOoxmlPackage(file,limits),
        /bounded_ooxml_invalid/
      );
    }
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("rejects duplicate canonical names and CRC-mismatched stored content",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-bounded-ooxml-integrity-"));
  try {
    const duplicateRoot=join(root,"duplicate");
    await mkdir(join(duplicateRoot,"word"),{recursive:true,mode:0o700});
    await writeFile(join(duplicateRoot,"word/document.xml"),"a",{mode:0o600});
    await writeFile(join(duplicateRoot,"word\\document.xml"),"b",{mode:0o600});
    const duplicate=join(root,"duplicate.docx");
    await run("/usr/bin/zip",[
      "-q","-0",duplicate,"word/document.xml","word\\document.xml"
    ],{cwd:duplicateRoot});
    await assert.rejects(
      ()=>openBoundedOoxmlPackage(duplicate,{
        maxEntries:8,maxEntryBytes:1024,maxTotalBytes:4096
      }),
      /bounded_ooxml_invalid/
    );

    const corrupt=await zipFixture(root,{name:"corrupt.docx",parts:{
      "word/document.xml":"UNIQUE-STORED-MARKER"
    }});
    const bytes=await readFile(corrupt);
    const marker=Buffer.from("UNIQUE-STORED-MARKER");
    const at=bytes.indexOf(marker);
    assert.notEqual(at,-1);
    bytes[at]^=0x01;
    await writeFile(corrupt,bytes,{mode:0o600});
    const archive=await openBoundedOoxmlPackage(corrupt,{
      maxEntries:8,maxEntryBytes:1024,maxTotalBytes:4096
    });
    assert.throws(
      ()=>archive.readEntry("word/document.xml"),
      /bounded_ooxml_invalid/
    );
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("preflights XML and parses strict relationship parts",()=>{
  const xml=Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>`+
    `<Relationships xmlns="${RELATIONSHIPS_NAMESPACE}">`+
    `<Relationship Id="rId1" Type="${HYPERLINK_TYPE}" `+
    `Target="https://example.invalid/a?x=1&amp;y=2" `+
    `TargetMode="External"/>`+
    `<Relationship Id="rId2" Type="image" `+
    `Target="media/image1.png"/>`+
    `</Relationships>`
  );
  assert.equal(assertSafeOoxmlXml(xml).includes("Relationships"),true);
  assert.deepEqual(parseOoxmlRelationships(xml),[
    {
      Id:"rId1",Type:HYPERLINK_TYPE,
      Target:"https://example.invalid/a?x=1&y=2",
      TargetMode:"External"
    },
    {Id:"rId2",Type:"image",Target:"media/image1.png"}
  ]);
  for (const unsafe of [
    "<!DOCTYPE document><document/>",
    "<!ENTITY remote 'file:///tmp/a'><document/>"
  ]) {
    assert.throws(
      ()=>assertSafeOoxmlXml(Buffer.from(unsafe)),
      /bounded_ooxml_invalid/
    );
  }
});

test("resolves internal targets within the package and rejects escapes",()=>{
  assert.equal(
    resolveOoxmlTarget("word/document.xml","media/image1.png"),
    "word/media/image1.png"
  );
  assert.equal(
    resolveOoxmlTarget("word/header1.xml","/word/media/image2.png"),
    "word/media/image2.png"
  );
  for (const target of ["../../../outside","/../outside","","a\\b"]) {
    assert.throws(
      ()=>resolveOoxmlTarget("word/document.xml",target),
      /bounded_ooxml_invalid/
    );
  }
});
