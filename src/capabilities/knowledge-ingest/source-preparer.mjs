import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {lstat,open} from "node:fs/promises";
import {extname,isAbsolute} from "node:path";

export function prepareKnowledgeText({text,maxSourceBytes}) {
  if (typeof text!=="string"||!text.trim()||text.includes("\0")||
      !Number.isSafeInteger(maxSourceBytes)||maxSourceBytes<1||
      maxSourceBytes>262_144) {
    throw new Error("knowledge_source_invalid");
  }
  const sizeBytes=Buffer.byteLength(text,"utf8");
  if (sizeBytes>maxSourceBytes) throw new Error("knowledge_source_invalid");
  return {
    version:1,
    sourceKind:"text",
    detectedFormat:"text",
    displayName:"message.txt",
    sizeBytes,
    sha256:createHash("sha256").update(text,"utf8").digest("hex"),
    jobSourceName:"source.txt",
    safeSourceReference:"",
    extractionIntegrity:"complete",
    extractionLimitations:[]
  };
}

export async function prepareKnowledgeFile({
  file,displayName,extension,maxSourceBytes
}) {
  let handle;
  try {
    if (typeof file!=="string"||!isAbsolute(file)||
        typeof displayName!=="string"||displayName!==displayName.trim()||
        !displayName||[...displayName].length>255||
        /[\\/\u0000-\u001f\u007f]/u.test(displayName)||
        !new Set(["txt","md"]).has(extension)||
        extname(displayName).slice(1).toLowerCase()!==extension||
        !Number.isSafeInteger(maxSourceBytes)||maxSourceBytes<1||
        maxSourceBytes>262_144) {
      throw new Error("invalid");
    }
    const before=await lstat(file);
    if (!before.isFile()||before.isSymbolicLink()||before.uid!==process.getuid()||
        (before.mode&0o077)!==0||before.size<1||before.size>maxSourceBytes) {
      throw new Error("invalid");
    }
    handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
    const opened=await handle.stat();
    if (!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino||
        opened.size!==before.size) {
      throw new Error("invalid");
    }
    const bytes=await handle.readFile();
    if (bytes.length!==before.size||unsafeMagic(bytes)) throw new Error("invalid");
    const content=new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(bytes);
    if (!content.trim()||content.includes("\0")||
        /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(content)) {
      throw new Error("invalid");
    }
    return {
      version:1,
      sourceKind:"file",
      detectedFormat:extension,
      displayName,
      sizeBytes:bytes.length,
      sha256:createHash("sha256").update(bytes).digest("hex"),
      jobSourceName:`source.${extension}`,
      safeSourceReference:"",
      extractionIntegrity:"complete",
      extractionLimitations:[],
      content
    };
  } catch {
    throw new Error("knowledge_source_invalid");
  } finally {
    if (handle) await handle.close().catch(()=>{});
  }
}

function unsafeMagic(value) {
  return value.subarray(0,5).toString("ascii")==="%PDF-"||
    value.subarray(0,4).equals(Buffer.from([0x50,0x4b,0x03,0x04]))||
    value.subarray(0,8).equals(
      Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1])
    );
}
