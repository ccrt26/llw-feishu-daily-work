import test from "node:test";
import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {
  chmod,mkdir,mkdtemp,rm,symlink,writeFile
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname,join} from "node:path";
import {promisify} from "node:util";
import {
  inspectAssistantSource
} from "../src/personal-assistant/source-security-inspector.mjs";

const run=promisify(execFile);

async function officeFixture(root,{
  name="safe.docx",extraParts={},password=null
}={}) {
  const packageRoot=join(root,`${name}-package-${Math.random()}`);
  const parts={
    "[Content_Types].xml":`<?xml version="1.0"?><Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "word/document.xml":`<?xml version="1.0"?><document>UNIQUE-BODY-MARKER</document>`,
    ...extraParts
  };
  for (const [part,content] of Object.entries(parts)) {
    const target=join(packageRoot,part);
    await mkdir(dirname(target),{recursive:true,mode:0o700});
    await writeFile(target,content,{mode:0o600});
  }
  const output=join(root,name);
  const args=["-q","-r",...(password?["-P",password]:[]),output,"."];
  await run("/usr/bin/zip",args,{cwd:packageRoot});
  await chmod(output,0o600);
  return output;
}

test("validates an OOXML envelope without returning extracted business content",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v401-security-"));
  try {
    const file=await officeFixture(root);
    const result=await inspectAssistantSource(file,{
      claimedExtension:"docx",maxFileBytes:20*1024*1024
    });
    assert.equal(result.format,"docx");
    assert.equal(result.mediaClass,"document");
    assert.equal(result.archiveExtension,"docx");
    assert.equal(result.byteSize>0,true);
    assert.match(result.sha256,/^[0-9a-f]{64}$/);
    assert.equal("content" in result,false);
    assert.equal("extractionIntegrity" in result,false);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("rejects empty, symlinked and extension/header-mismatched sources",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v401-security-basic-"));
  try {
    const empty=join(root,"empty.pdf");
    const pdf=join(root,"real.pdf");
    const link=join(root,"linked.pdf");
    await writeFile(empty,"",{mode:0o600});
    await writeFile(pdf,"%PDF-1.7\nsafe",{mode:0o600});
    await symlink(pdf,link);
    for (const [file,claimedExtension] of [
      [empty,"pdf"],[link,"pdf"],[pdf,"docx"]
    ]) {
      await assert.rejects(
        ()=>inspectAssistantSource(file,{claimedExtension}),
        /assistant_source_invalid/
      );
    }
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("rejects OOXML macros, encryption, external relationships and bombs",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v401-security-archive-"));
  try {
    const macro=await officeFixture(root,{
      name:"macro.docx",
      extraParts:{"word/vbaProject.bin":"unsafe"}
    });
    const encrypted=await officeFixture(root,{
      name:"encrypted.docx",password:"secret"
    });
    const external=await officeFixture(root,{
      name:"external.docx",
      extraParts:{
        "word/_rels/document.xml.rels":
          `<Relationships><Relationship TargetMode="External" Target="https://example.invalid"/></Relationships>`
      }
    });
    const bomb=await officeFixture(root,{
      name:"bomb.docx",
      extraParts:{"word/large.bin":"0".repeat(2*1024*1024)}
    });
    for (const file of [macro,encrypted,external,bomb]) {
      await assert.rejects(
        ()=>inspectAssistantSource(file,{claimedExtension:"docx"}),
        /assistant_source_invalid/
      );
    }
  } finally { await rm(root,{recursive:true,force:true}); }
});
