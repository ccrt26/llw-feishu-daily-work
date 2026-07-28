import test from "node:test";
import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {createHash} from "node:crypto";
import {chmod,mkdir,mkdtemp,readFile,rm,symlink,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname,join} from "node:path";
import {promisify} from "node:util";
import {
  prepareKnowledgeOfficeFile
} from "../src/capabilities/knowledge-ingest/office-source-preparer.mjs";

const run=promisify(execFile);

async function fixture(root,extension,{unsafePart,extraParts={}}={}) {
  const packageRoot=join(root,`${extension}-package`);
  const parts={
    docx:{
      "[Content_Types].xml":`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
      "word/document.xml":`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>交流方案正文</w:t></w:r></w:p></w:body></w:document>`
    },
    pptx:{
      "[Content_Types].xml":`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`,
      "ppt/presentation.xml":`<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`,
      "ppt/slides/slide1.xml":`<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>产品方案第一页</a:t></a:r></a:p></p:sld>`
    },
    xlsx:{
      "[Content_Types].xml":`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
      "xl/workbook.xml":`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="客户清单" sheetId="1"/></sheets></workbook>`,
      "xl/worksheets/sheet1.xml":`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>客户名称</t></is></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>`
    }
  }[extension];
  if (unsafePart) parts[unsafePart]=Buffer.from("unsafe");
  Object.assign(parts,extraParts);
  for (const [name,content] of Object.entries(parts)) {
    const target=join(packageRoot,name);
    await mkdir(dirname(target),{recursive:true,mode:0o700});
    await writeFile(target,content,{mode:0o600});
  }
  const output=join(root,`sample.${extension}`);
  await run("/usr/bin/zip",["-q","-r",output,"."],{cwd:packageRoot});
  await chmod(output,0o600);
  return output;
}

test("prepares one bounded DOCX, PPTX or XLSX with original bytes and extracted text",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-office-source-"));
  try {
    for (const [extension,expected] of [
      ["docx","交流方案正文"],["pptx","产品方案第一页"],["xlsx","客户名称"]
    ]) {
      const file=await fixture(root,extension);
      const bytes=await readFile(file);
      const result=await prepareKnowledgeOfficeFile({
        file,displayName:`sample.${extension}`,extension,
        maxSourceBytes:20*1024*1024,maxExtractedBytes:262_144,
        processorPath:new URL("../src/capabilities/knowledge-ingest/ooxml_processor.py",import.meta.url)
      });
      assert.equal(result.version,1);
      assert.equal(result.sourceKind,"file");
      assert.equal(result.detectedFormat,extension);
      assert.equal(result.jobSourceName,`source.${extension}`);
      assert.equal(result.sizeBytes,bytes.length);
      assert.equal(result.sha256,createHash("sha256").update(bytes).digest("hex"));
      assert.equal(Buffer.compare(result.sourceBytes,bytes),0);
      assert.match(result.content,new RegExp(expected));
      assert.equal(result.safeSourceReference,"");
      assert.equal(result.extractionIntegrity,"complete");
      assert.deepEqual(result.extractionLimitations,[]);
    }
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("extracts ordinary DOCX headers and footers instead of marking the source partial",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-office-source-header-footer-"));
  try {
    const file=await fixture(root,"docx",{
      extraParts:{
        "word/document.xml":`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>交流方案正文</w:t></w:r></w:p><w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/><w:footerReference w:type="default" r:id="rIdFooter"/></w:sectPr></w:body></w:document>`,
        "word/_rels/document.xml.rels":`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>`,
        "word/header1.xml":`<?xml version="1.0"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>内部资料</w:t></w:r></w:p></w:hdr>`,
        "word/footer1.xml":`<?xml version="1.0"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>第 1 页</w:t></w:r></w:p></w:ftr>`,
        "word/footer2.xml":`<?xml version="1.0"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>未引用内容</w:t></w:r></w:p></w:ftr>`
      }
    });
    const result=await prepareKnowledgeOfficeFile({
      file,displayName:"with-header-footer.docx",extension:"docx",
      maxSourceBytes:20*1024*1024,maxExtractedBytes:262_144,
      processorPath:new URL(
        "../src/capabilities/knowledge-ingest/ooxml_processor.py",
        import.meta.url
      )
    });
    assert.equal(result.extractionIntegrity,"complete");
    assert.deepEqual(result.extractionLimitations,[]);
    assert.match(result.content,/内部资料/u);
    assert.match(result.content,/第 1 页/u);
    assert.doesNotMatch(result.content,/未引用内容/u);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("marks Office content partial when important visual parts were not extracted",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-office-source-partial-"));
  try {
    const file=await fixture(root,"pptx",{
      unsafePart:"ppt/media/image1.png"
    });
    const result=await prepareKnowledgeOfficeFile({
      file,displayName:"visual.pptx",extension:"pptx",
      maxSourceBytes:20*1024*1024,maxExtractedBytes:262_144,
      processorPath:new URL(
        "../src/capabilities/knowledge-ingest/ooxml_processor.py",
        import.meta.url
      )
    });
    assert.equal(result.extractionIntegrity,"partial");
    assert.deepEqual(result.extractionLimitations,[
      "embedded_media_not_extracted"
    ]);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("rejects fake, symlinked, macro-enabled and malformed Office sources",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-office-source-invalid-"));
  try {
    const fake=join(root,"fake.docx");
    await writeFile(fake,"not a zip",{mode:0o600});
    const macro=await fixture(root,"docx",{unsafePart:"word/vbaProject.bin"});
    const target=await fixture(root,"pptx");
    const link=join(root,"link.pptx");
    await symlink(target,link);
    for (const [file,displayName,extension] of [
      [fake,"fake.docx","docx"],
      [macro,"macro.docx","docx"],
      [link,"link.pptx","pptx"],
      [target,"wrong.xlsx","xlsx"]
    ]) {
      await assert.rejects(
        prepareKnowledgeOfficeFile({
          file,displayName,extension,maxSourceBytes:20*1024*1024,
          maxExtractedBytes:262_144,
          processorPath:new URL("../src/capabilities/knowledge-ingest/ooxml_processor.py",import.meta.url)
        }),
        /knowledge_source_invalid/
      );
    }
  } finally { await rm(root,{recursive:true,force:true}); }
});
