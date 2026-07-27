import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp,rm,symlink,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  prepareKnowledgeFile,prepareKnowledgeText
} from "../src/capabilities/knowledge-ingest/source-preparer.mjs";

test("prepares one exact bounded text source with program-owned metadata",()=>{
  const text="Save this synthetic note: Aurora uses staged communication.";
  const result=prepareKnowledgeText({text,maxSourceBytes:262144});
  assert.deepEqual(result,{
    version:1,
    sourceKind:"text",
    detectedFormat:"text",
    displayName:"message.txt",
    sizeBytes:Buffer.byteLength(text),
    sha256:createHash("sha256").update(text).digest("hex"),
    jobSourceName:"source.txt",
    safeSourceReference:"",
    extractionIntegrity:"complete",
    extractionLimitations:[]
  });
});

test("rejects empty, non-string, NUL, invalid limits and oversized direct text",()=>{
  for (const input of [
    {text:"",maxSourceBytes:262144},
    {text:"   ",maxSourceBytes:262144},
    {text:Buffer.from("text"),maxSourceBytes:262144},
    {text:"unsafe\0text",maxSourceBytes:262144},
    {text:"text",maxSourceBytes:0},
    {text:"x".repeat(11),maxSourceBytes:10}
  ]) {
    assert.throws(
      ()=>prepareKnowledgeText(input),
      /knowledge_source_invalid/
    );
  }
});

test("prepares one verified UTF-8 TXT or Markdown file without rereading it",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-knowledge-source-"));
  try {
    for (const [name,extension,content] of [
      ["交流方案.TXT","txt","第一行\r\n第二行。\n"],
      ["notes.md","md","# 标题\n\n正文。\n"]
    ]) {
      const file=join(root,name);
      await writeFile(file,content,{mode:0o600});
      assert.deepEqual(
        await prepareKnowledgeFile({
          file,displayName:name,extension,maxSourceBytes:262_144
        }),
        {
          version:1,sourceKind:"file",detectedFormat:extension,
          displayName:name,sizeBytes:Buffer.byteLength(content),
          sha256:createHash("sha256").update(content).digest("hex"),
          jobSourceName:`source.${extension}`,safeSourceReference:"",
          extractionIntegrity:"complete",extractionLimitations:[],
          content
        }
      );
    }
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("rejects extension mismatch, PDF or Office magic, NUL, invalid UTF-8 and oversized files",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-knowledge-source-invalid-"));
  try {
    const cases=[
      ["wrong.md","txt",Buffer.from("plain text")],
      ["document.txt","txt",Buffer.from("%PDF-1.4\n")],
      ["office.md","md",Buffer.from([0x50,0x4b,0x03,0x04,1,2,3])],
      ["nul.txt","txt",Buffer.from("before\0after")],
      ["binary.txt","txt",Buffer.from([0xff,0xfe,0x00,0x01])],
      ["large.txt","txt",Buffer.from("x".repeat(11))]
    ];
    for (const [name,extension,content] of cases) {
      const file=join(root,name);
      await writeFile(file,content,{mode:0o600});
      await assert.rejects(
        prepareKnowledgeFile({
          file,displayName:name,extension,
          maxSourceBytes:name==="large.txt"?10:262_144
        }),
        /knowledge_source_invalid/
      );
    }
    const target=join(root,"target.txt");
    await writeFile(target,"safe",{mode:0o600});
    const link=join(root,"link.txt");
    await symlink(target,link);
    await assert.rejects(
      prepareKnowledgeFile({
        file:link,displayName:"link.txt",extension:"txt",maxSourceBytes:262_144
      }),
      /knowledge_source_invalid/
    );
    const pdf=join(root,"invoice.pdf");
    await writeFile(pdf,"%PDF-1.4\n",{mode:0o600});
    await assert.rejects(
      prepareKnowledgeFile({
        file:pdf,displayName:"invoice.pdf",extension:"pdf",maxSourceBytes:262_144
      }),
      /knowledge_source_invalid/
    );
  } finally { await rm(root,{recursive:true,force:true}); }
});
