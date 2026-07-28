import {createHash} from "node:crypto";
import {lstat,readFile} from "node:fs/promises";
import {inflateRawSync} from "node:zlib";

const MAX_FILE_BYTES=20*1024*1024;
const MAX_ARCHIVE_ENTRIES=2048;
const MAX_ARCHIVE_TOTAL=64*1024*1024;
const MAX_ARCHIVE_ENTRY=16*1024*1024;
const OFFICE=new Set(["docx","pptx","xlsx"]);
const TEXT=new Set(["txt","md"]);
const UNSAFE_ARCHIVE_PART=/(^|\/)(?:vbaproject\.bin|encryptedpackage|encryptioninfo|activex|embeddings|externallinks|customui|oleobjects)(?:\/|$)/i;
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
    const relationships=readZipEntry(bytes,entry).toString("utf8");
    if (/TargetMode\s*=\s*["']External["']/i.test(relationships)) {
      throw invalid();
    }
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
