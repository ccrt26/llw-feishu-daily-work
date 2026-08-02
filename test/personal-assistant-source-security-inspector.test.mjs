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
const RELATIONSHIPS_NAMESPACE=
  "http://schemas.openxmlformats.org/package/2006/relationships";
const HYPERLINK_TYPE=
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";
const STRICT_HYPERLINK_TYPE=
  "http://purl.oclc.org/ooxml/officeDocument/relationships/hyperlink";
const IMAGE_TYPE=
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";

function relationships(items,{prefix="",suffix=""}={}) {
  return `<?xml version="1.0" encoding="UTF-8"?>${prefix}`+
    `<Relationships xmlns="${RELATIONSHIPS_NAMESPACE}">`+
    `${items.join("")}</Relationships>${suffix}`;
}

function relationship({
  id="rId1",type=HYPERLINK_TYPE,target,
  targetMode="External"
}) {
  const mode=targetMode===null
    ?""
    :` TargetMode="${targetMode}"`;
  return `<Relationship Id="${id}" Type="${type}" `+
    `Target="${target}"${mode}/>`;
}

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

test("rejects OOXML macros, encryption and bombs",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v401-security-archive-"));
  try {
    const macro=await officeFixture(root,{
      name:"macro.docx",
      extraParts:{"word/vbaProject.bin":"unsafe"}
    });
    const encrypted=await officeFixture(root,{
      name:"encrypted.docx",password:"secret"
    });
    const bomb=await officeFixture(root,{
      name:"bomb.docx",
      extraParts:{"word/large.bin":"0".repeat(2*1024*1024)}
    });
    for (const file of [macro,encrypted,bomb]) {
      await assert.rejects(
        ()=>inspectAssistantSource(file,{claimedExtension:"docx"}),
        /assistant_source_invalid/
      );
    }
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("accepts standard HTTP and HTTPS hyperlinks only as inert OOXML data",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v444-safe-hyperlink-"));
  try {
    const xml=relationships([
      relationship({
        id:"rId1",target:"https://example.invalid/reference?a=1&amp;b=2"
      }),
      `<Relationship Target='http://example.invalid/second' `+
        `TargetMode='External' Type='${STRICT_HYPERLINK_TYPE}' Id='rId2'/>`,
      relationship({
        id:"rId3",type:IMAGE_TYPE,target:"media/image.png",
        targetMode:null
      }),
      relationship({
        id:"rId4",type:IMAGE_TYPE,target:"media/second.png",
        targetMode:"Internal"
      })
    ],{prefix:"<!-- inert links only -->"});
    const file=await officeFixture(root,{
      name:"safe-hyperlink.docx",
      extraParts:{"word/_rels/document.xml.rels":xml}
    });
    const result=await inspectAssistantSource(file,{claimedExtension:"docx"});
    assert.equal(result.format,"docx");
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("rejects every unsafe OOXML relationship variant",async context=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v444-unsafe-relationships-"));
  try {
    const externalTypes=[
      ["image",IMAGE_TYPE,"https://example.invalid/image.png"],
      ["attached-template","http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate","https://example.invalid/template.dotx"],
      ["ole-object","http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject","https://example.invalid/object.bin"],
      ["attachment","http://schemas.openxmlformats.org/officeDocument/2006/relationships/package","https://example.invalid/attachment.bin"],
      ["external-workbook","http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink","https://example.invalid/workbook.xlsx"]
    ];
    const unsafeTargets=[
      ["file-target","file:///private/tmp/item"],
      ["ftp-target","ftp://example.invalid/item"],
      ["data-target","data:text/plain,unsafe"],
      ["javascript-target","javascript:alert(1)"],
      ["unc-target","file://server/share/item"],
      ["credential-target","https://user:pass@example.invalid/item"],
      ["control-target","https://example.invalid/a&#x0A;b"],
      ["oversized-target",`https://example.invalid/${"a".repeat(2049)}`]
    ];
    const cases=[
      {
        name:"missing-type",
        xml:relationships([
          `<Relationship Id="rId1" Target="https://example.invalid" TargetMode="External"/>`
        ])
      },
      {
        name:"fake-hyperlink-type",
        xml:relationships([relationship({
          type:"https://attacker.invalid/hyperlink",
          target:"https://example.invalid"
        })])
      },
      ...externalTypes.map(([name,type,target])=>({
        name,xml:relationships([relationship({type,target})])
      })),
      ...unsafeTargets.map(([name,target])=>({
        name,xml:relationships([relationship({target})])
      })),
      {
        name:"unknown-target-mode",
        xml:relationships([relationship({
          target:"https://example.invalid",targetMode:"Remote"
        })])
      },
      {
        name:"safe-and-dangerous-mixed",
        xml:relationships([
          relationship({
            id:"rId1",target:"https://example.invalid/reference"
          }),
          relationship({
            id:"rId2",type:IMAGE_TYPE,
            target:"https://example.invalid/image.png"
          })
        ])
      },
      {
        name:"duplicate-relationship-id",
        xml:relationships([
          relationship({
            id:"rId1",target:"https://example.invalid/first"
          }),
          relationship({
            id:"rId1",target:"https://example.invalid/second"
          })
        ])
      },
      {
        name:"wrong-root-namespace",
        xml:`<Relationships xmlns="https://example.invalid/relationships">`+
          relationship({target:"https://example.invalid"})+
          `</Relationships>`
      },
      {
        name:"duplicate-attribute",
        xml:relationships([
          `<Relationship Id="rId1" Type="${HYPERLINK_TYPE}" `+
            `Target="https://example.invalid" TargetMode="External" `+
            `TargetMode="External"/>`
        ])
      },
      {
        name:"doctype-entity",
        xml:`<?xml version="1.0"?><!DOCTYPE Relationships [`+
          `<!ENTITY remote "https://example.invalid">]>`+
          `<Relationships xmlns="${RELATIONSHIPS_NAMESPACE}">`+
          `<Relationship Id="rId1" Type="${HYPERLINK_TYPE}" `+
          `Target="&remote;" TargetMode="External"/></Relationships>`
      },
      {
        name:"malformed-closing-tag",
        xml:`<Relationships xmlns="${RELATIONSHIPS_NAMESPACE}">`+
          relationship({target:"https://example.invalid"})+
          `</Relationship>`
      },
      {
        name:"unknown-attribute",
        xml:relationships([
          `<Relationship Id="rId1" Type="${HYPERLINK_TYPE}" `+
            `Target="https://example.invalid" TargetMode="External" `+
            `Fetch="true"/>`
        ])
      },
      {
        name:"nested-content",
        xml:relationships([
          `<Relationship Id="rId1" Type="${HYPERLINK_TYPE}" `+
            `Target="https://example.invalid" TargetMode="External">`+
            `<Unexpected/></Relationship>`
        ])
      },
      {
        name:"processing-instruction",
        xml:relationships([
          relationship({target:"https://example.invalid"})
        ],{prefix:"<?unexpected value?>"})
      },
      {
        name:"trailing-content",
        xml:relationships([
          relationship({target:"https://example.invalid"})
        ],{suffix:"<Unexpected/>"})
      },
      {
        name:"too-many-relationships",
        xml:relationships(Array.from({length:2049},(_,index)=>
          relationship({
            id:`rId${index+1}`,
            target:`https://example.invalid/${index+1}`
          })
        ))
      }
    ];
    for (const item of cases) {
      await context.test(item.name,async()=>{
        const file=await officeFixture(root,{
          name:`${item.name}.docx`,
          extraParts:{"word/_rels/document.xml.rels":item.xml}
        });
        await assert.rejects(
          ()=>inspectAssistantSource(file,{claimedExtension:"docx"}),
          /assistant_source_invalid/
        );
      });
    }
  } finally { await rm(root,{recursive:true,force:true}); }
});
