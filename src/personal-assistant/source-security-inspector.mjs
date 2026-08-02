import {createHash} from "node:crypto";
import {lstat,readFile} from "node:fs/promises";
import {
  openBoundedOoxmlBytes,parseOoxmlRelationships
} from "./bounded-ooxml-package.mjs";

const MAX_FILE_BYTES=20*1024*1024;
const MAX_RELATIONSHIP_TARGET_BYTES=2048;
const OFFICE=new Set(["docx","pptx","xlsx"]);
const TEXT=new Set(["txt","md"]);
const HYPERLINK_RELATIONSHIP_TYPES=new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
  "http://purl.oclc.org/ooxml/officeDocument/relationships/hyperlink"
]);
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
  const archive=openBoundedOoxmlBytes(bytes);
  const names=new Set(archive.entryNames);
  const required={
    docx:"word/document.xml",
    pptx:"ppt/presentation.xml",
    xlsx:"xl/workbook.xml"
  }[extension];
  if (!names.has("[Content_Types].xml")||!names.has(required)) {
    throw invalid();
  }
  const contentTypes=archive.readEntry("[Content_Types].xml")
    .toString("utf8").toLowerCase();
  const expected={
    docx:"wordprocessingml.document.main+xml",
    pptx:"presentationml.presentation.main+xml",
    xlsx:"spreadsheetml.sheet.main+xml"
  }[extension];
  if (!contentTypes.includes(expected)||contentTypes.includes("macroenabled")) {
    throw invalid();
  }
  for (const name of archive.entryNames) {
    if (!name.toLowerCase().endsWith(".rels")) continue;
    inspectRelationshipPart(archive.readEntry(name));
  }
}

function inspectRelationshipPart(bytes) {
  const relationships=parseOoxmlRelationships(bytes);
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

function invalid() {
  return new Error("assistant_source_invalid");
}
