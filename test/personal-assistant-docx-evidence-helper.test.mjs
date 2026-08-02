import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp,mkdir,readFile,rm,stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  prepareDocxEvidenceJob
} from "../src/personal-assistant/docx-evidence-helper.mjs";
import {
  PNG_1X1,REL_BASE,W,buildDocxFixture,imageParagraph,
  paragraph,relationships,wordDocument,wordPart
} from "./fixtures/docx-evidence-fixture.mjs";

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function runFixture(root,options={},limits={}) {
  const inputPath=await buildDocxFixture(root,options);
  const outputDir=join(root,"output");
  await mkdir(outputDir,{mode:0o700});
  return {
    inputPath,outputDir,
    result:await prepareDocxEvidenceJob({
      inputPath,expectedSha256:await sha256(inputPath),outputDir,
      limits:{maxTextBytes:64*1024,maxImages:16,...limits}
    })
  };
}

test("prepares ordered text and owner-scoped PNG evidence with complete coverage",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-docx-evidence-complete-"));
  try {
    const documentXml=wordDocument(
      paragraph("标题",{style:"Heading1"})+
      paragraph("列表项",{numId:1,level:0})+
      paragraph("正文段落")+
      `<w:tbl><w:tr><w:tc>${paragraph("表格内容")}</w:tc></w:tr></w:tbl>`+
      imageParagraph("rId1")
    );
    const {outputDir,result}=await runFixture(root,{
      documentXml,
      extraParts:{
        "word/styles.xml":wordPart("styles",
          `<w:style w:type="paragraph" w:styleId="Heading1">`+
          `<w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>`+
          `<w:pPr><w:outlineLvl w:val="0"/>`+
          `</w:pPr></w:style>`),
        "word/numbering.xml":wordPart("numbering",""),
        "word/header1.xml":wordPart("hdr",
          paragraph("页眉")+imageParagraph("rId1")),
        "word/footer1.xml":wordPart("ftr",paragraph("页脚")),
        "word/footnotes.xml":wordPart("footnotes",
          `<w:footnote w:id="1">${paragraph("脚注")}</w:footnote>`),
        "word/endnotes.xml":wordPart("endnotes",
          `<w:endnote w:id="1">${paragraph("尾注")}</w:endnote>`),
        "word/media/body.png":PNG_1X1,
        "word/media/header.png":PNG_1X1
      },
      relationsByOwner:{
        "word/document.xml":[
          {id:"rId1",type:`${REL_BASE}/image`,target:"media/body.png"},
          {id:"rIdHeader",type:`${REL_BASE}/header`,target:"header1.xml"},
          {id:"rIdFooter",type:`${REL_BASE}/footer`,target:"footer1.xml"},
          {id:"rIdFootnotes",type:`${REL_BASE}/footnotes`,target:"footnotes.xml"},
          {id:"rIdEndnotes",type:`${REL_BASE}/endnotes`,target:"endnotes.xml"},
          {id:"rIdStyles",type:`${REL_BASE}/styles`,target:"styles.xml"},
          {id:"rIdNumbering",type:`${REL_BASE}/numbering`,target:"numbering.xml"}
        ],
        "word/header1.xml":[
          {id:"rId1",type:`${REL_BASE}/image`,target:"media/header.png"}
        ]
      }
    });
    assert.equal(result.coverage.status,"complete");
    assert.deepEqual(result.coverage.limitations,[]);
    assert.deepEqual(
      result.observations.map(({type,text,ownerPartName})=>({
        type,text,ownerPartName
      })),
      [
        {type:"heading",text:"标题",ownerPartName:"word/document.xml"},
        {type:"list_item",text:"列表项",ownerPartName:"word/document.xml"},
        {type:"paragraph",text:"正文段落",ownerPartName:"word/document.xml"},
        {type:"table_cell",text:"表格内容",ownerPartName:"word/document.xml"},
        {type:"paragraph",text:"页眉",ownerPartName:"word/header1.xml"},
        {type:"paragraph",text:"页脚",ownerPartName:"word/footer1.xml"},
        {type:"paragraph",text:"脚注",ownerPartName:"word/footnotes.xml"},
        {type:"paragraph",text:"尾注",ownerPartName:"word/endnotes.xml"}
      ]
    );
    assert.deepEqual(
      result.imageCandidates.map(item=>({
        ownerPartName:item.ownerPartName,
        relationshipId:item.relationshipId,
        targetMediaPartName:item.targetMediaPartName
      })),
      [
        {
          ownerPartName:"word/document.xml",relationshipId:"rId1",
          targetMediaPartName:"word/media/body.png"
        },
        {
          ownerPartName:"word/header1.xml",relationshipId:"rId1",
          targetMediaPartName:"word/media/header.png"
        }
      ]
    );
    assert.equal(
      result.imageCandidates[0].documentOrder<
        result.imageCandidates[1].documentOrder,
      true
    );
    assert.equal(
      result.imageCandidates[0].documentOrder<
        result.observations.find(item=>item.text==="页眉").documentOrder,
      true
    );
    for (const image of result.imageCandidates) {
      const file=join(outputDir,image.jobRelativePath);
      assert.equal((await stat(file)).mode&0o777,0o600);
      assert.equal((await readFile(file)).subarray(0,8).equals(
        Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])
      ),true);
    }
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("marks every unsupported or possibly-visible internal feature partial",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-docx-evidence-partial-"));
  try {
    const unsupported=`
      <w:p><w:ins><w:r><w:t>修订</w:t></w:r></w:ins></w:p>
      <w:commentRangeStart w:id="1"/>
      <w:p><w:r><w:drawing><a:graphic><a:graphicData>
        <c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>
      </a:graphicData></a:graphic></w:drawing></w:r></w:p>
      <dgm:relIds xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram"/>
      <m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"/>
      <w:txbxContent>${paragraph("文本框")}</w:txbxContent>
      <w:altChunk r:id="rIdAlt" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>
      <w:sdtPr><w:dataBinding w:xpath="/x"/></w:sdtPr>
      <x:widget xmlns:x="https://example.invalid/visible"><x:value>未知</x:value></x:widget>`;
    const {result}=await runFixture(root,{
      documentXml:wordDocument(unsupported),
      extraParts:{
        "word/comments.xml":wordPart("comments",""),
        "word/unknown-visible.xml":wordPart("unknown",paragraph("未知"))
      },
      relationsByOwner:{
        "word/document.xml":[
          {id:"rIdAlt",type:`${REL_BASE}/aFChunk`,target:"unknown-visible.xml"}
        ]
      }
    });
    assert.equal(result.coverage.status,"partial");
    for (const limitation of [
      "tracked_changes","comments","chart","smart_art","equation","text_box",
      "alt_chunk","custom_xml_binding","unknown_visible_part",
      "unknown_visible_xml","unsupported_drawing"
    ]) {
      assert.equal(result.coverage.limitations.includes(limitation),true);
    }
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("marks unsupported images and evidence budgets partial",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-docx-evidence-budget-"));
  try {
    const {result}=await runFixture(root,{
      documentXml:wordDocument(
        paragraph("超过很小的文字预算")+imageParagraph("rIdJpeg")
      ),
      extraParts:{"word/media/photo.jpg":Buffer.from([0xff,0xd8,0xff,0xd9])},
      relationsByOwner:{
        "word/document.xml":[
          {id:"rIdJpeg",type:`${REL_BASE}/image`,target:"media/photo.jpg"}
        ]
      }
    },{maxTextBytes:4,maxImages:0});
    assert.equal(result.coverage.status,"partial");
    assert.equal(result.coverage.limitations.includes("text_budget_exceeded"),true);
    assert.equal(result.coverage.limitations.includes("unsupported_image_format"),true);
    assert.deepEqual(result.imageCandidates,[]);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("fails closed on malformed, stale, unsafe or dangling DOCX evidence",async context=>{
  const root=await mkdtemp(join(tmpdir(),"llw-docx-evidence-invalid-"));
  try {
    const cases=[
      {
        name:"malformed-xml",
        options:{documentXml:`<w:document xmlns:w="${W}"><w:body></w:document>`}
      },
      {
        name:"forbidden-entity",
        options:{documentXml:`<!DOCTYPE x [<!ENTITY y SYSTEM "file:///tmp/y">]>`+
          `<w:document xmlns:w="${W}"><w:body>&y;</w:body></w:document>`}
      },
      {
        name:"dangling-image",
        options:{
          documentXml:wordDocument(imageParagraph("rIdMissing")),
          relationsByOwner:{"word/document.xml":[
            {id:"rIdMissing",type:`${REL_BASE}/image`,target:"media/missing.png"}
          ]}
        }
      },
      {
        name:"unsafe-external-image",
        options:{
          documentXml:wordDocument(imageParagraph("rIdRemote")),
          relationsByOwner:{"word/document.xml":[
            {id:"rIdRemote",type:`${REL_BASE}/image`,
              target:"https://example.invalid/image.png",mode:"External"}
          ]}
        }
      },
      {
        name:"wrong-document-root",
        options:{documentXml:wordPart("hdr",paragraph("不是正文"))}
      },
      {
        name:"dangling-unvisited-relationship-part",
        options:{extraParts:{
          "_rels/.rels":relationships([
            {id:"rIdRoot",type:`${REL_BASE}/officeDocument`,
            target:"word/missing.xml"}
          ])
        }}
      },
      {
        name:"dangling-content-type-override",
        options:{extraParts:{
          "[Content_Types].xml":`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`+
            `<Default Extension="xml" ContentType="application/xml"/>`+
            `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`+
            `<Override PartName="/word/missing.xml" ContentType="application/xml"/>`+
            `</Types>`
        }}
      }
    ];
    for (const item of cases) {
      await context.test(item.name,async()=>{
        const inputPath=await buildDocxFixture(root,{
          name:`${item.name}.docx`,...item.options
        });
        const outputDir=join(root,`${item.name}-output`);
        await mkdir(outputDir,{mode:0o700});
        const expectedSha256=await sha256(inputPath);
        await assert.rejects(
          ()=>prepareDocxEvidenceJob({
            inputPath,expectedSha256,outputDir,
            limits:{maxTextBytes:64*1024,maxImages:16}
          }),
          /docx_evidence_invalid/
        );
      });
    }
    const valid=await buildDocxFixture(root,{name:"stale.docx"});
    const outputDir=join(root,"stale-output");
    await mkdir(outputDir,{mode:0o700});
    await assert.rejects(
      ()=>prepareDocxEvidenceJob({
        inputPath:valid,expectedSha256:"0".repeat(64),outputDir,
        limits:{maxTextBytes:64*1024,maxImages:16}
      }),
      /docx_evidence_invalid/
    );
  } finally { await rm(root,{recursive:true,force:true}); }
});
