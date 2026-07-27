import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {lstat,open} from "node:fs/promises";
import {extname,isAbsolute} from "node:path";
import {fileURLToPath} from "node:url";

const FORMATS=new Set(["docx","pptx","xlsx"]);
const ZIP_MAGIC=Buffer.from([0x50,0x4b,0x03,0x04]);

export async function prepareKnowledgeOfficeFile({
  file,displayName,extension,maxSourceBytes,maxExtractedBytes,
  processorPath,timeoutMs=30_000,pythonPath="/usr/bin/python3"
}) {
  let handle;
  try {
    const processor=processorPath instanceof URL
      ?fileURLToPath(processorPath):processorPath;
    if (typeof file!=="string"||!isAbsolute(file)||
        typeof displayName!=="string"||displayName!==displayName.trim()||
        !displayName||[...displayName].length>255||
        /[\\/\u0000-\u001f\u007f]/u.test(displayName)||
        !FORMATS.has(extension)||
        extname(displayName).slice(1).toLowerCase()!==extension||
        !Number.isSafeInteger(maxSourceBytes)||maxSourceBytes<1||
        maxSourceBytes>20*1024*1024||
        !Number.isSafeInteger(maxExtractedBytes)||maxExtractedBytes<1||
        maxExtractedBytes>262_144||
        typeof processor!=="string"||!isAbsolute(processor)||
        typeof pythonPath!=="string"||!isAbsolute(pythonPath)||
        !Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60_000) {
      throw new Error("invalid");
    }
    const [before,processorInfo]=await Promise.all([lstat(file),lstat(processor)]);
    if (!before.isFile()||before.isSymbolicLink()||before.uid!==process.getuid()||
        (before.mode&0o077)!==0||before.size<1||before.size>maxSourceBytes||
        !processorInfo.isFile()||processorInfo.isSymbolicLink()||
        processorInfo.uid!==process.getuid()||(processorInfo.mode&0o022)!==0) {
      throw new Error("invalid");
    }
    handle=await open(file);
    const opened=await handle.stat();
    if (!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino||
        opened.size!==before.size) {
      throw new Error("invalid");
    }
    const sourceBytes=await handle.readFile();
    if (sourceBytes.length!==before.size||
        !sourceBytes.subarray(0,4).equals(ZIP_MAGIC)) {
      throw new Error("invalid");
    }
    const parsed=await runProcessor({
      pythonPath,processor,extension,sourceBytes,maxExtractedBytes,timeoutMs
    });
    if (!parsed||typeof parsed!=="object"||Array.isArray(parsed)||
        Object.keys(parsed).length!==4||parsed.format!==extension||
        typeof parsed.content!=="string"||!parsed.content.trim()||
        parsed.content.includes("\0")||
        Buffer.byteLength(parsed.content,"utf8")>maxExtractedBytes||
        !new Set(["complete","partial"]).has(parsed.extraction_integrity)||
        !Array.isArray(parsed.extraction_limitations)||
        parsed.extraction_limitations.length>16||
        parsed.extraction_limitations.some(value=>
          typeof value!=="string"||!/^[a-z0-9_]{1,64}$/u.test(value)
        )||
        (parsed.extraction_integrity==="complete"&&
          parsed.extraction_limitations.length)||
        (parsed.extraction_integrity==="partial"&&
          !parsed.extraction_limitations.length)) {
      throw new Error("invalid");
    }
    return {
      version:1,
      sourceKind:"file",
      detectedFormat:extension,
      displayName,
      sizeBytes:sourceBytes.length,
      sha256:createHash("sha256").update(sourceBytes).digest("hex"),
      jobSourceName:`source.${extension}`,
      safeSourceReference:"",
      extractionIntegrity:parsed.extraction_integrity,
      extractionLimitations:[...parsed.extraction_limitations],
      content:parsed.content,
      sourceBytes
    };
  } catch {
    throw new Error("knowledge_source_invalid");
  } finally {
    if (handle) await handle.close().catch(()=>{});
  }
}
function runProcessor({
  pythonPath,processor,extension,sourceBytes,maxExtractedBytes,timeoutMs
}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(
      pythonPath,[processor,extension,String(maxExtractedBytes)],
      {stdio:["pipe","pipe","ignore"],env:{PATH:"/usr/bin:/bin",PYTHONNOUSERSITE:"1"}}
    );
    const chunks=[];
    let size=0,settled=false;
    const finish=(error,value)=>{
      if (settled) return;
      settled=true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer=setTimeout(()=>{
      child.kill("SIGKILL");
      finish(new Error("timeout"));
    },timeoutMs);
    child.stdout.on("data",chunk=>{
      size+=chunk.length;
      if (size>maxExtractedBytes+4096) {
        child.kill("SIGKILL");
        finish(new Error("oversized"));
      } else chunks.push(chunk);
    });
    child.once("error",finish);
    child.once("close",code=>{
      if (code!==0) return finish(new Error("processor_failed"));
      try {
        finish(null,JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        finish(new Error("processor_invalid"));
      }
    });
    child.stdin.once("error",()=>{});
    child.stdin.end(sourceBytes);
  });
}
