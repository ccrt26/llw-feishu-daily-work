import {execFile} from "node:child_process";
import {chmod,mkdir,writeFile} from "node:fs/promises";
import {dirname,join} from "node:path";
import {promisify} from "node:util";

const run=promisify(execFile);
export const W="http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const R="http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const A="http://schemas.openxmlformats.org/drawingml/2006/main";
export const RELS="http://schemas.openxmlformats.org/package/2006/relationships";
export const REL_BASE=
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const PNG_1X1=Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

export function wordDocument(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>`+
    `<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:a="${A}">`+
    `<w:body>${body}<w:sectPr/></w:body></w:document>`;
}

export function wordPart(rootName,body) {
  return `<?xml version="1.0" encoding="UTF-8"?>`+
    `<w:${rootName} xmlns:w="${W}" xmlns:r="${R}" xmlns:a="${A}">`+
    `${body}</w:${rootName}>`;
}

export function paragraph(text,{style,numId,level=0}={}) {
  const properties=style||numId!==undefined
    ?`<w:pPr>${style?`<w:pStyle w:val="${style}"/>`:""}`+
      `${numId!==undefined?`<w:numPr><w:ilvl w:val="${level}"/>`+
        `<w:numId w:val="${numId}"/></w:numPr>`:""}</w:pPr>`
    :"";
  return `<w:p>${properties}<w:r><w:t>${text}</w:t></w:r></w:p>`;
}

export function imageParagraph(relationshipId) {
  return `<w:p><w:r><w:drawing><a:graphic><a:graphicData>`+
    `<a:blip r:embed="${relationshipId}"/>`+
    `</a:graphicData></a:graphic></w:drawing></w:r></w:p>`;
}

export function relationships(items) {
  return `<?xml version="1.0" encoding="UTF-8"?>`+
    `<Relationships xmlns="${RELS}">${items.map(item=>
      `<Relationship Id="${item.id}" Type="${item.type}" `+
      `Target="${item.target}"${item.mode?` TargetMode="${item.mode}"`:""}/>`
    ).join("")}</Relationships>`;
}

export function relationshipPartName(ownerPartName) {
  const slash=ownerPartName.lastIndexOf("/");
  const directory=ownerPartName.slice(0,slash);
  const basename=ownerPartName.slice(slash+1);
  return `${directory}/_rels/${basename}.rels`;
}

export async function buildDocxFixture(root,{
  name="fixture.docx",documentXml,extraParts={},relationsByOwner={}
}={}) {
  const packageRoot=join(root,`${name}-package`);
  const parts={
    "[Content_Types].xml":`<?xml version="1.0"?>`+
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`+
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`+
      `<Default Extension="xml" ContentType="application/xml"/>`+
      `<Default Extension="png" ContentType="image/png"/>`+
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`+
      `</Types>`,
    "word/document.xml":documentXml||wordDocument(paragraph("正文")),
    ...extraParts
  };
  for (const [owner,items] of Object.entries(relationsByOwner)) {
    parts[relationshipPartName(owner)]=relationships(items);
  }
  for (const [part,content] of Object.entries(parts)) {
    const target=join(packageRoot,part);
    await mkdir(dirname(target),{recursive:true,mode:0o700});
    await writeFile(target,content,{mode:0o600});
  }
  const output=join(root,name);
  await run("/usr/bin/zip",["-q","-r",output,"."],{cwd:packageRoot});
  await chmod(output,0o600);
  return output;
}
