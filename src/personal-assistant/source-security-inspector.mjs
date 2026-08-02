import {createHash} from "node:crypto";
import {lstat,readFile} from "node:fs/promises";
import {inflateRawSync} from "node:zlib";

const MAX_FILE_BYTES=20*1024*1024;
const MAX_ARCHIVE_ENTRIES=2048;
const MAX_ARCHIVE_TOTAL=64*1024*1024;
const MAX_ARCHIVE_ENTRY=16*1024*1024;
const MAX_RELATIONSHIPS=2048;
const MAX_RELATIONSHIP_TARGET_BYTES=2048;
const OFFICE=new Set(["docx","pptx","xlsx"]);
const TEXT=new Set(["txt","md"]);
const UNSAFE_ARCHIVE_PART=/(^|\/)(?:vbaproject\.bin|encryptedpackage|encryptioninfo|activex|embeddings|externallinks|customui|oleobjects)(?:\/|$)/i;
const RELATIONSHIPS_NAMESPACE=
  "http://schemas.openxmlformats.org/package/2006/relationships";
const HYPERLINK_RELATIONSHIP_TYPES=new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
  "http://purl.oclc.org/ooxml/officeDocument/relationships/hyperlink"
]);
const RELATIONSHIP_ATTRIBUTES=new Set([
  "Id","Type","Target","TargetMode"
]);
const XML_DECLARATION_ATTRIBUTES=new Set([
  "version","encoding","standalone"
]);
const XML_DECLARATION_ORDERS=new Set([
  "version","version,encoding","version,standalone",
  "version,encoding,standalone"
]);
const FORBIDDEN_XML_MARKUP=/<!DOCTYPE|<!ENTITY/iu;
const UTF8=new TextDecoder("utf-8",{fatal:true});

export async function inspectAssistantSource(file,{
  claimedExtension,maxFileBytes=MAX_FILE_BYTES
}={}) {
  if (typeof file!=="string"||!file||
      typeof claimedExtension!=="string"||
      !Number.isSafeInteger(maxFileBytes)||
      maxFileBytes<1||maxFileBytes>MAX_FILE_BYTES) {
    throw invalid();
  }
  try {
    const info=await lstat(file);
    if (!info.isFile()||info.isSymbolicLink()||
        info.size<1||info.size>maxFileBytes) {
      throw invalid();
    }
    const bytes=await readFile(file);
    if (bytes.length!==info.size) throw invalid();
    const detected=detectFormat(bytes,claimedExtension);
    if (!detected) throw invalid();
    if (OFFICE.has(detected.format)) {
      inspectOoxmlEnvelope(bytes,detected.format);
    } else if (TEXT.has(detected.format)) {
      inspectTextEnvelope(bytes);
    } else if (detected.format==="pdf"&&
        /\/Encrypt\b/.test(bytes.toString("latin1"))) {
      throw invalid();
    }
    return Object.freeze({
      format:detected.format,
      mediaClass:detected.mediaClass,
      archiveExtension:detected.archiveExtension,
      byteSize:bytes.length,
      sha256:createHash("sha256").update(bytes).digest("hex")
    });
  } catch (error) {
    if (error?.message==="assistant_source_invalid") throw error;
    throw invalid();
  }
}

function detectFormat(bytes,claimedExtension) {
  const claimed=claimedExtension.toLowerCase();
  const png=bytes.subarray(0,8).equals(
    Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])
  );
  const jpeg=bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff;
  const webp=bytes.subarray(0,4).toString("ascii")==="RIFF"&&
    bytes.subarray(8,12).toString("ascii")==="WEBP";
  const pdf=bytes.subarray(0,5).toString("ascii")==="%PDF-";
  const zip=bytes.subarray(0,4).equals(Buffer.from([0x50,0x4b,0x03,0x04]));
  if (png&&(claimed===""||claimed==="png")) {
    return {format:"png",archiveExtension:"png",mediaClass:"image"};
  }
  if (jpeg&&(claimed===""||claimed==="jpg"||claimed==="jpeg")) {
    const extension=claimed==="jpeg"?"jpeg":"jpg";
    return {format:extension,archiveExtension:extension,mediaClass:"image"};
  }
  if (webp&&(claimed===""||claimed==="webp")) {
    return {format:"webp",archiveExtension:"webp",mediaClass:"image"};
  }
  if (pdf&&claimed==="pdf") {
    return {format:"pdf",archiveExtension:"pdf",mediaClass:"document"};
  }
  if (zip&&OFFICE.has(claimed)) {
    return {format:claimed,archiveExtension:claimed,mediaClass:"document"};
  }
  if (!png&&!jpeg&&!webp&&!pdf&&!zip&&TEXT.has(claimed)) {
    return {format:claimed,archiveExtension:claimed,mediaClass:"document"};
  }
  return null;
}

function inspectTextEnvelope(bytes) {
  if (bytes.includes(0)) throw invalid();
  UTF8.decode(bytes);
}

function inspectOoxmlEnvelope(bytes,extension) {
  const entries=zipEntries(bytes);
  const names=new Set(entries.map(entry=>entry.name));
  const required={
    docx:"word/document.xml",
    pptx:"ppt/presentation.xml",
    xlsx:"xl/workbook.xml"
  }[extension];
  if (!names.has("[Content_Types].xml")||!names.has(required)) throw invalid();
  const contentTypes=readZipEntry(bytes,entryNamed(entries,"[Content_Types].xml"))
    .toString("utf8").toLowerCase();
  const expected={
    docx:"wordprocessingml.document.main+xml",
    pptx:"presentationml.presentation.main+xml",
    xlsx:"spreadsheetml.sheet.main+xml"
  }[extension];
  if (!contentTypes.includes(expected)||contentTypes.includes("macroenabled")) {
    throw invalid();
  }
  for (const entry of entries) {
    if (!entry.name.toLowerCase().endsWith(".rels")) continue;
    inspectRelationshipPart(readZipEntry(bytes,entry));
  }
}

function inspectRelationshipPart(bytes) {
  const xml=UTF8.decode(bytes);
  if (FORBIDDEN_XML_MARKUP.test(xml)) throw invalid();
  const relationships=parseRelationshipElements(xml);
  for (const attributes of relationships) {
    const mode=attributes.TargetMode;
    if (mode===undefined||mode==="Internal") continue;
    if (mode!=="External"||
        !HYPERLINK_RELATIONSHIP_TYPES.has(attributes.Type)||
        !safeExternalHyperlink(attributes.Target)) {
      throw invalid();
    }
  }
}

function parseRelationshipElements(xml) {
  let cursor=xml.codePointAt(0)===0xfeff?1:0;
  if (xml.startsWith("<?xml",cursor)) {
    cursor=parseXmlDeclaration(xml,cursor);
  }
  cursor=skipXmlTrivia(xml,cursor);
  const root=parseXmlStartTag(xml,cursor);
  const childName=relationshipChildName(root);
  cursor=root.end;
  if (root.selfClosing) {
    cursor=skipXmlTrivia(xml,cursor);
    if (cursor!==xml.length) throw invalid();
    return [];
  }
  const ids=new Set();
  const relationships=[];
  for (;;) {
    cursor=skipXmlTrivia(xml,cursor);
    if (xml.startsWith("</",cursor)) {
      const closing=parseXmlClosingTag(xml,cursor);
      if (closing.name!==root.name) throw invalid();
      cursor=skipXmlTrivia(xml,closing.end);
      if (cursor!==xml.length) throw invalid();
      return relationships;
    }
    const child=parseXmlStartTag(xml,cursor);
    if (child.name!==childName) throw invalid();
    const attributes=relationshipAttributes(child.attributes,ids);
    cursor=child.end;
    if (!child.selfClosing) {
      cursor=skipXmlTrivia(xml,cursor);
      const closing=parseXmlClosingTag(xml,cursor);
      if (closing.name!==childName) throw invalid();
      cursor=closing.end;
    }
    relationships.push(attributes);
    if (relationships.length>MAX_RELATIONSHIPS) throw invalid();
  }
}

function relationshipChildName(root) {
  const parts=root.name.split(":");
  let namespaceAttribute,childName;
  if (parts.length===1&&parts[0]==="Relationships") {
    namespaceAttribute="xmlns";
    childName="Relationship";
  } else if (parts.length===2&&parts[0]&&parts[1]==="Relationships") {
    namespaceAttribute=`xmlns:${parts[0]}`;
    childName=`${parts[0]}:Relationship`;
  } else {
    throw invalid();
  }
  if (root.attributes.size!==1||
      root.attributes.get(namespaceAttribute)!==RELATIONSHIPS_NAMESPACE) {
    throw invalid();
  }
  return childName;
}

function relationshipAttributes(attributes,ids) {
  if ([...attributes.keys()].some(
    name=>!RELATIONSHIP_ATTRIBUTES.has(name)
  )) throw invalid();
  const id=attributes.get("Id");
  const type=attributes.get("Type");
  const target=attributes.get("Target");
  if (!id||!type||!target||ids.has(id)) throw invalid();
  ids.add(id);
  return Object.freeze({
    Id:id,Type:type,Target:target,
    ...(attributes.has("TargetMode")
      ?{TargetMode:attributes.get("TargetMode")}
      :{})
  });
}

function parseXmlDeclaration(xml,start) {
  let cursor=start+5;
  if (!xmlWhitespace(xml[cursor])) throw invalid();
  const attributes=new Map();
  for (;;) {
    const beforeWhitespace=cursor;
    cursor=skipXmlWhitespace(xml,cursor);
    if (xml.startsWith("?>",cursor)) {
      cursor+=2;
      break;
    }
    if (cursor===beforeWhitespace) throw invalid();
    const attribute=parseXmlAttribute(xml,cursor);
    if (attributes.has(attribute.name)) throw invalid();
    attributes.set(attribute.name,attribute.value);
    cursor=attribute.end;
  }
  if (attributes.size<1||attributes.size>3||
      attributes.get("version")!=="1.0"||
      [...attributes.keys()].some(
        name=>!XML_DECLARATION_ATTRIBUTES.has(name)
      )||
      !XML_DECLARATION_ORDERS.has([...attributes.keys()].join(","))||
      (attributes.has("encoding")&&
        attributes.get("encoding").toLowerCase()!=="utf-8")||
      (attributes.has("standalone")&&
        !new Set(["yes","no"]).has(attributes.get("standalone")))) {
    throw invalid();
  }
  return cursor;
}

function parseXmlStartTag(xml,start) {
  if (xml[start]!=="<"||new Set(["/","!","?"]).has(xml[start+1])) {
    throw invalid();
  }
  const parsedName=parseXmlName(xml,start+1);
  const attributes=new Map();
  let cursor=parsedName.end;
  for (;;) {
    const beforeWhitespace=cursor;
    cursor=skipXmlWhitespace(xml,cursor);
    if (xml.startsWith("/>",cursor)) {
      return {
        name:parsedName.value,attributes,selfClosing:true,end:cursor+2
      };
    }
    if (xml[cursor]===">") {
      return {
        name:parsedName.value,attributes,selfClosing:false,end:cursor+1
      };
    }
    if (cursor===beforeWhitespace) throw invalid();
    const attribute=parseXmlAttribute(xml,cursor);
    if (attributes.has(attribute.name)) throw invalid();
    attributes.set(attribute.name,attribute.value);
    cursor=attribute.end;
  }
}

function parseXmlClosingTag(xml,start) {
  if (!xml.startsWith("</",start)) throw invalid();
  const name=parseXmlName(xml,start+2);
  const cursor=skipXmlWhitespace(xml,name.end);
  if (xml[cursor]!==">") throw invalid();
  return {name:name.value,end:cursor+1};
}

function parseXmlAttribute(xml,start) {
  const name=parseXmlName(xml,start);
  let cursor=skipXmlWhitespace(xml,name.end);
  if (xml[cursor]!=="=") throw invalid();
  cursor=skipXmlWhitespace(xml,cursor+1);
  const quote=xml[cursor];
  if (quote!=="\""&&quote!=="'") throw invalid();
  const end=xml.indexOf(quote,cursor+1);
  if (end<0) throw invalid();
  const raw=xml.slice(cursor+1,end);
  if (raw.includes("<")) throw invalid();
  return {
    name:name.value,value:decodeXmlAttribute(raw),end:end+1
  };
}

function parseXmlName(xml,start) {
  if (!/[A-Za-z_]/u.test(xml[start]||"")) throw invalid();
  let cursor=start+1;
  while (/[A-Za-z0-9_.:-]/u.test(xml[cursor]||"")) cursor+=1;
  return {value:xml.slice(start,cursor),end:cursor};
}

function decodeXmlAttribute(raw) {
  let decoded="",cursor=0;
  while (cursor<raw.length) {
    const ampersand=raw.indexOf("&",cursor);
    if (ampersand<0) {
      decoded+=raw.slice(cursor);
      break;
    }
    decoded+=raw.slice(cursor,ampersand);
    const semicolon=raw.indexOf(";",ampersand+1);
    if (semicolon<0||semicolon-ampersand>12) throw invalid();
    const entity=raw.slice(ampersand+1,semicolon);
    const named={amp:"&",lt:"<",gt:">",apos:"'",quot:'"'}[entity];
    if (named!==undefined) {
      decoded+=named;
    } else {
      const hexadecimal=/^#x[0-9A-Fa-f]+$/u.test(entity);
      const decimal=/^#[0-9]+$/u.test(entity);
      if (!hexadecimal&&!decimal) throw invalid();
      const point=Number.parseInt(
        entity.slice(hexadecimal?2:1),hexadecimal?16:10
      );
      if (!xmlCodePoint(point)) throw invalid();
      decoded+=String.fromCodePoint(point);
    }
    cursor=semicolon+1;
  }
  for (const value of decoded) {
    if (!xmlCodePoint(value.codePointAt(0))) throw invalid();
  }
  return decoded;
}

function skipXmlTrivia(xml,start) {
  let cursor=skipXmlWhitespace(xml,start);
  while (xml.startsWith("<!--",cursor)) {
    const end=xml.indexOf("-->",cursor+4);
    if (end<0) throw invalid();
    const content=xml.slice(cursor+4,end);
    if (content.includes("--")||content.endsWith("-")) throw invalid();
    cursor=skipXmlWhitespace(xml,end+3);
  }
  return cursor;
}

function skipXmlWhitespace(xml,start) {
  let cursor=start;
  while (xmlWhitespace(xml[cursor])) cursor+=1;
  return cursor;
}

function xmlWhitespace(value) {
  return value===" "||value==="\t"||value==="\r"||value==="\n";
}

function xmlCodePoint(value) {
  return value===0x9||value===0xa||value===0xd||
    (value>=0x20&&value<=0xd7ff)||
    (value>=0xe000&&value<=0xfffd)||
    (value>=0x10000&&value<=0x10ffff);
}

function safeExternalHyperlink(value) {
  if (typeof value!=="string"||!value||value!==value.trim()||
      Buffer.byteLength(value,"utf8")>MAX_RELATIONSHIP_TARGET_BYTES||
      /[\u0000-\u001f\u007f]/u.test(value)) return false;
  try {
    const url=new URL(value);
    return (url.protocol==="http:"||url.protocol==="https:")&&
      !url.username&&!url.password;
  } catch {
    return false;
  }
}

function zipEntries(bytes) {
  const eocd=findEocd(bytes);
  const disk=bytes.readUInt16LE(eocd+4);
  const centralDisk=bytes.readUInt16LE(eocd+6);
  const diskEntries=bytes.readUInt16LE(eocd+8);
  const totalEntries=bytes.readUInt16LE(eocd+10);
  const centralSize=bytes.readUInt32LE(eocd+12);
  const centralOffset=bytes.readUInt32LE(eocd+16);
  const commentLength=bytes.readUInt16LE(eocd+20);
  if (disk!==0||centralDisk!==0||diskEntries!==totalEntries||
      totalEntries<1||totalEntries>MAX_ARCHIVE_ENTRIES||
      totalEntries===0xffff||
      eocd+22+commentLength!==bytes.length||
      centralOffset+centralSize!==eocd) {
    throw invalid();
  }
  const entries=[],names=new Set();
  let offset=centralOffset,total=0;
  for (let index=0;index<totalEntries;index+=1) {
    if (offset+46>eocd||bytes.readUInt32LE(offset)!==0x02014b50) {
      throw invalid();
    }
    const flags=bytes.readUInt16LE(offset+8);
    const method=bytes.readUInt16LE(offset+10);
    const compressedSize=bytes.readUInt32LE(offset+20);
    const size=bytes.readUInt32LE(offset+24);
    const nameLength=bytes.readUInt16LE(offset+28);
    const extraLength=bytes.readUInt16LE(offset+30);
    const entryCommentLength=bytes.readUInt16LE(offset+32);
    const localOffset=bytes.readUInt32LE(offset+42);
    const end=offset+46+nameLength+extraLength+entryCommentLength;
    if (end>eocd||flags&0x1||![0,8].includes(method)||
        size>MAX_ARCHIVE_ENTRY||
        (size>1024*1024&&compressedSize*200<size)) {
      throw invalid();
    }
    const name=UTF8.decode(bytes.subarray(offset+46,offset+46+nameLength))
      .replaceAll("\\","/");
    const path=name.endsWith("/")?name.slice(0,-1):name;
    if (!path||path.startsWith("/")||path.includes("\0")||
        path.split("/").some(part=>!part||part==="."||part==="..")||
        names.has(name)||UNSAFE_ARCHIVE_PART.test(path)) {
      throw invalid();
    }
    names.add(name);
    total+=size;
    if (total>MAX_ARCHIVE_TOTAL) throw invalid();
    entries.push({name,flags,method,compressedSize,size,localOffset});
    offset=end;
  }
  if (offset!==eocd) throw invalid();
  return entries;
}

function findEocd(bytes) {
  const start=Math.max(0,bytes.length-65_557);
  for (let offset=bytes.length-22;offset>=start;offset-=1) {
    if (bytes.readUInt32LE(offset)===0x06054b50) return offset;
  }
  throw invalid();
}

function readZipEntry(bytes,entry) {
  const offset=entry.localOffset;
  if (offset+30>bytes.length||bytes.readUInt32LE(offset)!==0x04034b50) {
    throw invalid();
  }
  const nameLength=bytes.readUInt16LE(offset+26);
  const extraLength=bytes.readUInt16LE(offset+28);
  const start=offset+30+nameLength+extraLength;
  const end=start+entry.compressedSize;
  if (end>bytes.length) throw invalid();
  const compressed=bytes.subarray(start,end);
  const content=entry.method===0?Buffer.from(compressed):inflateRawSync(compressed,{
    maxOutputLength:Math.min(entry.size+1,MAX_ARCHIVE_ENTRY+1)
  });
  if (content.length!==entry.size) throw invalid();
  return content;
}

function entryNamed(entries,name) {
  const entry=entries.find(value=>value.name===name);
  if (!entry) throw invalid();
  return entry;
}

function invalid() {
  return new Error("assistant_source_invalid");
}
