import {createHash} from "node:crypto";
import {lstat,readFile} from "node:fs/promises";
import {posix} from "node:path";
import {inflateRawSync} from "node:zlib";

const HARD_MAX_FILE_BYTES=20*1024*1024;
const HARD_MAX_ENTRIES=2048;
const HARD_MAX_TOTAL_BYTES=64*1024*1024;
const HARD_MAX_ENTRY_BYTES=16*1024*1024;
const MAX_RELATIONSHIPS=2048;
const RELATIONSHIPS_NAMESPACE=
  "http://schemas.openxmlformats.org/package/2006/relationships";
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
const UNSAFE_ARCHIVE_PART=/(^|\/)(?:vbaproject\.bin|encryptedpackage|encryptioninfo|activex|embeddings|externallinks|customui|oleobjects)(?:\/|$)/i;
const UTF8=new TextDecoder("utf-8",{fatal:true});

export async function openBoundedOoxmlPackage(filePath,options={}) {
  if (typeof filePath!=="string"||!filePath) throw invalid();
  try {
    const info=await lstat(filePath);
    if (!info.isFile()||info.isSymbolicLink()||info.size<1) throw invalid();
    const maxFileBytes=limit(
      options.maxFileBytes,HARD_MAX_FILE_BYTES,HARD_MAX_FILE_BYTES
    );
    if (info.size>maxFileBytes) throw invalid();
    const bytes=await readFile(filePath);
    if (bytes.length!==info.size) throw invalid();
    return openBoundedOoxmlBytes(bytes,options);
  } catch (error) {
    if (error?.message==="bounded_ooxml_invalid") throw error;
    throw invalid();
  }
}

export function openBoundedOoxmlBytes(bytes,options={}) {
  try {
    if (!Buffer.isBuffer(bytes)||bytes.length<1) throw invalid();
    const maxFileBytes=limit(
      options.maxFileBytes,HARD_MAX_FILE_BYTES,HARD_MAX_FILE_BYTES
    );
    const maxEntries=limit(
      options.maxEntries,HARD_MAX_ENTRIES,HARD_MAX_ENTRIES
    );
    const maxEntryBytes=limit(
      options.maxEntryBytes,HARD_MAX_ENTRY_BYTES,HARD_MAX_ENTRY_BYTES
    );
    const maxTotalBytes=limit(
      options.maxTotalBytes,HARD_MAX_TOTAL_BYTES,HARD_MAX_TOTAL_BYTES
    );
    if (bytes.length>maxFileBytes) throw invalid();
    const sha256=createHash("sha256").update(bytes).digest("hex");
    if (options.expectedSha256!==undefined&&
        (!/^[0-9a-f]{64}$/u.test(options.expectedSha256)||
          options.expectedSha256!==sha256)) throw invalid();
    const parsed=parseZipEntries(bytes,{
      maxEntries,maxEntryBytes,maxTotalBytes
    });
    const entries=parsed.entries.map(entry=>Object.freeze({...entry}));
    const byName=new Map(entries.map(entry=>[entry.name,entry]));
    return Object.freeze({
      sha256,
      byteSize:bytes.length,
      entryNames:Object.freeze(entries.map(entry=>entry.name)),
      entries:Object.freeze(entries),
      hasEntry:name=>byName.has(canonicalLookupName(name)),
      readEntry(name) {
        const entry=byName.get(canonicalLookupName(name));
        if (!entry) throw invalid();
        return readZipEntry(bytes,entry,parsed.centralOffset,maxEntryBytes);
      }
    });
  } catch (error) {
    if (error?.message==="bounded_ooxml_invalid") throw error;
    throw invalid();
  }
}

export function assertSafeOoxmlXml(bytes) {
  try {
    const xml=UTF8.decode(bytes);
    if (FORBIDDEN_XML_MARKUP.test(xml)) throw invalid();
    return xml;
  } catch (error) {
    if (error?.message==="bounded_ooxml_invalid") throw error;
    throw invalid();
  }
}

export function parseOoxmlRelationships(bytes) {
  const xml=assertSafeOoxmlXml(bytes);
  return parseRelationshipElements(xml);
}

export function resolveOoxmlTarget(ownerPartName,target) {
  try {
    const owner=canonicalLookupName(ownerPartName);
    if (owner.endsWith("/")||typeof target!=="string"||!target||
        target!==target.trim()||target.includes("\\")||
        /[\u0000-\u001f\u007f?#]/u.test(target)) throw invalid();
    let decoded;
    try { decoded=decodeURIComponent(target); } catch { throw invalid(); }
    if (!decoded||decoded.includes("\\")||
        /[\u0000-\u001f\u007f?#]/u.test(decoded)) throw invalid();
    const combined=decoded.startsWith("/")
      ?decoded.slice(1)
      :posix.join(posix.dirname(owner),decoded);
    const normalized=posix.normalize(combined);
    if (!normalized||normalized==="."||normalized===".."||
        normalized.startsWith("../")||normalized.startsWith("/")) {
      throw invalid();
    }
    return canonicalLookupName(normalized);
  } catch (error) {
    if (error?.message==="bounded_ooxml_invalid") throw error;
    throw invalid();
  }
}

function parseZipEntries(bytes,{maxEntries,maxEntryBytes,maxTotalBytes}) {
  const eocd=findEocd(bytes);
  const disk=bytes.readUInt16LE(eocd+4);
  const centralDisk=bytes.readUInt16LE(eocd+6);
  const diskEntries=bytes.readUInt16LE(eocd+8);
  const totalEntries=bytes.readUInt16LE(eocd+10);
  const centralSize=bytes.readUInt32LE(eocd+12);
  const centralOffset=bytes.readUInt32LE(eocd+16);
  const commentLength=bytes.readUInt16LE(eocd+20);
  if (disk!==0||centralDisk!==0||diskEntries!==totalEntries||
      totalEntries<1||totalEntries>maxEntries||totalEntries===0xffff||
      eocd+22+commentLength!==bytes.length||
      centralOffset+centralSize!==eocd) throw invalid();
  const entries=[];
  const names=new Set();
  let offset=centralOffset,total=0;
  for (let index=0;index<totalEntries;index+=1) {
    if (offset+46>eocd||bytes.readUInt32LE(offset)!==0x02014b50) {
      throw invalid();
    }
    const flags=bytes.readUInt16LE(offset+8);
    const method=bytes.readUInt16LE(offset+10);
    const crc32=bytes.readUInt32LE(offset+16);
    const compressedSize=bytes.readUInt32LE(offset+20);
    const size=bytes.readUInt32LE(offset+24);
    const nameLength=bytes.readUInt16LE(offset+28);
    const extraLength=bytes.readUInt16LE(offset+30);
    const entryCommentLength=bytes.readUInt16LE(offset+32);
    const localOffset=bytes.readUInt32LE(offset+42);
    const end=offset+46+nameLength+extraLength+entryCommentLength;
    if (end>eocd||flags&0x1||![0,8].includes(method)||
        size>maxEntryBytes||
        (size>1024*1024&&compressedSize*200<size)) throw invalid();
    const rawName=UTF8.decode(
      bytes.subarray(offset+46,offset+46+nameLength)
    );
    const name=canonicalEntryName(rawName);
    if (names.has(name)) throw invalid();
    names.add(name);
    total+=size;
    if (total>maxTotalBytes) throw invalid();
    entries.push({
      name,flags,method,crc32,compressedSize,size,localOffset
    });
    offset=end;
  }
  if (offset!==eocd) throw invalid();
  return {entries,centralOffset};
}

function readZipEntry(bytes,entry,centralOffset,maxEntryBytes) {
  try {
    const offset=entry.localOffset;
    if (offset+30>centralOffset||
        bytes.readUInt32LE(offset)!==0x04034b50) throw invalid();
    const flags=bytes.readUInt16LE(offset+6);
    const method=bytes.readUInt16LE(offset+8);
    const nameLength=bytes.readUInt16LE(offset+26);
    const extraLength=bytes.readUInt16LE(offset+28);
    const nameStart=offset+30;
    const nameEnd=nameStart+nameLength;
    const start=nameEnd+extraLength;
    const end=start+entry.compressedSize;
    if (flags!==entry.flags||method!==entry.method||end>centralOffset||
        canonicalEntryName(UTF8.decode(bytes.subarray(nameStart,nameEnd)))!==
          entry.name) throw invalid();
    const compressed=bytes.subarray(start,end);
    const content=entry.method===0
      ?Buffer.from(compressed)
      :inflateRawSync(compressed,{
        maxOutputLength:Math.min(entry.size+1,maxEntryBytes+1)
      });
    if (content.length!==entry.size||crc32(content)!==entry.crc32) {
      throw invalid();
    }
    return content;
  } catch (error) {
    if (error?.message==="bounded_ooxml_invalid") throw error;
    throw invalid();
  }
}

function canonicalEntryName(rawName) {
  if (typeof rawName!=="string"||!rawName) throw invalid();
  const name=rawName.replaceAll("\\","/");
  const directory=name.endsWith("/");
  const path=directory?name.slice(0,-1):name;
  if (!path||path.startsWith("/")||path.includes("\0")||
      path.split("/").some(part=>!part||part==="."||part==="..")||
      UNSAFE_ARCHIVE_PART.test(path)) throw invalid();
  return directory?`${path}/`:path;
}

function canonicalLookupName(name) {
  if (typeof name!=="string"||!name||name.includes("\\")) throw invalid();
  return canonicalEntryName(name);
}

function findEocd(bytes) {
  if (bytes.length<22) throw invalid();
  const start=Math.max(0,bytes.length-65_557);
  for (let offset=bytes.length-22;offset>=start;offset-=1) {
    if (bytes.readUInt32LE(offset)===0x06054b50) return offset;
  }
  throw invalid();
}

function parseRelationshipElements(xml) {
  let cursor=xml.codePointAt(0)===0xfeff?1:0;
  if (xml.startsWith("<?xml",cursor)) cursor=parseXmlDeclaration(xml,cursor);
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
  } else throw invalid();
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
      return {name:parsedName.value,attributes,selfClosing:true,end:cursor+2};
    }
    if (xml[cursor]===">") {
      return {name:parsedName.value,attributes,selfClosing:false,end:cursor+1};
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
  return {name:name.value,value:decodeXmlAttribute(raw),end:end+1};
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
    if (named!==undefined) decoded+=named;
    else {
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

function limit(value,fallback,hardMax) {
  const resolved=value===undefined?fallback:value;
  if (!Number.isSafeInteger(resolved)||resolved<1||resolved>hardMax) {
    throw invalid();
  }
  return resolved;
}

function crc32(bytes) {
  let crc=0xffffffff;
  for (const byte of bytes) {
    crc^=byte;
    for (let bit=0;bit<8;bit+=1) {
      crc=(crc>>>1)^((crc&1)?0xedb88320:0);
    }
  }
  return (crc^0xffffffff)>>>0;
}

function invalid() {
  return new Error("bounded_ooxml_invalid");
}
