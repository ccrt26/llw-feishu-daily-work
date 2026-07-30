import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {
  chmod,constants as fsConstants,copyFile,lstat,mkdir,mkdtemp,
  open,readFile,realpath,rm,writeFile
} from "node:fs/promises";
import {isAbsolute,join} from "node:path";
import {
  prepareInvoicePdf
} from "../capabilities/invoice/pdf-preparer.mjs";
import {
  publishTaskDerivedEvidence
} from "./task-derived-evidence.mjs";

const PNG_SIGNATURE=Buffer.from([
  0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a
]);
const PRODUCED_BY="pypdfium2-5.11.0";

export class TaskPdfReader {
  constructor({
    pdfProcessorPath,
    preparePdf=prepareInvoicePdf,
    tempRoot,
    maxPages=10,
    maxTextBytes=262_144,
    maxRenderBytes=100*1024*1024,
    maxDimension=3508,
    timeoutMs=60_000
  }) {
    if (typeof pdfProcessorPath!=="string"||
        !isAbsolute(pdfProcessorPath)||
        typeof preparePdf!=="function"||
        typeof tempRoot!=="string"||!isAbsolute(tempRoot)||
        !boundedInteger(maxPages,1,16)||
        !boundedInteger(maxTextBytes,1,262_144)||
        !boundedInteger(maxRenderBytes,1,100*1024*1024)||
        !boundedInteger(maxDimension,1,3508)||
        !boundedInteger(timeoutMs,1,300_000)) {
      throw new Error("task_pdf_reader_invalid");
    }
    this.pdfProcessorPath=pdfProcessorPath;
    this.preparePdf=preparePdf;
    this.tempRoot=tempRoot;
    this.maxPages=maxPages;
    this.maxTextBytes=maxTextBytes;
    this.maxRenderBytes=maxRenderBytes;
    this.maxDimension=maxDimension;
    this.timeoutMs=timeoutMs;
  }

  async prepare({workspaceDir,sources,signal,now}) {
    try {
      if (typeof workspaceDir!=="string"||!isAbsolute(workspaceDir)||
          !Array.isArray(sources)||sources.length>8||
          !(signal===undefined||signal instanceof AbortSignal)||
          !canonicalIso(now)) {
        throw new Error("task_pdf_reader_invalid");
      }
      signal?.throwIfAborted();
      const observations=[];
      const modelImageFiles=[];
      for (const source of sources) {
        const handle=source?.handle??source;
        if (handle?.format!=="pdf") continue;
        signal?.throwIfAborted();
        const evidence=await this.prepareOne({
          workspaceDir,source,signal,now
        });
        observations.push(...evidence.observations);
        modelImageFiles.push(...evidence.modelImageFiles);
      }
      return Object.freeze({
        observations:Object.freeze(observations),
        modelImageFiles:Object.freeze(modelImageFiles)
      });
    } catch (error) {
      if (error?.name==="AbortError") throw error;
      throw new Error("pdf_prepare_failed");
    }
  }

  async prepareOne({workspaceDir,source,signal,now}) {
    const reused=await this.reuse({
      workspaceDir,source,signal,now
    });
    if (reused) return reused;
    await this.ensureTempRoot();
    const job=await mkdtemp(join(this.tempRoot,"llw-task-pdf-"));
    await chmod(job,0o700);
    try {
      signal?.throwIfAborted();
      const sourceCopy=join(job,"source.pdf");
      await copyFile(
        source.absolutePath,sourceCopy,fsConstants.COPYFILE_EXCL
      );
      await chmod(sourceCopy,0o600);
      if (await sha256File(sourceCopy)!==source.handle.sha256) {
        throw new Error("task_pdf_reader_invalid");
      }
      const prepared=await this.preparePdf({
        file:sourceCopy,
        pdfProcessorPath:this.pdfProcessorPath,
        maxPages:this.maxPages,
        maxTextBytes:this.maxTextBytes,
        maxRenderBytes:this.maxRenderBytes,
        maxDimension:this.maxDimension,
        timeoutMs:this.timeoutMs
      });
      signal?.throwIfAborted();
      validatePrepared(prepared,this.maxPages);
      const textBytes=Buffer.from(prepared.extractedText,"utf8");
      if (textBytes.length>this.maxTextBytes) {
        throw new Error("task_pdf_reader_invalid");
      }
      const stagedText=join(job,"derived-extracted.txt");
      await writeFile(stagedText,textBytes,{
        flag:"wx",mode:0o600
      });
      await chmod(stagedText,0o600);
      const pages=[];
      let renderBytes=0;
      for (let index=0;index<prepared.pageImages.length;index+=1) {
        signal?.throwIfAborted();
        const pageFile=prepared.pageImages[index];
        await chmod(pageFile,0o600);
        const info=await lstat(pageFile);
        const {width,height}=await readPngDimensions(pageFile);
        if (!info.isFile()||info.isSymbolicLink()||
            info.uid!==process.getuid()||(info.mode&0o077)!==0||
            width>this.maxDimension||height>this.maxDimension) {
          throw new Error("task_pdf_reader_invalid");
        }
        renderBytes+=info.size;
        if (!Number.isSafeInteger(renderBytes)||
            renderBytes>this.maxRenderBytes) {
          throw new Error("task_pdf_reader_invalid");
        }
        const pageNumber=index+1;
        pages.push({
          pageNumber,
          relativePath:
            `${source.handle.sourceId}.page-${String(pageNumber).padStart(3,"0")}.png`,
          sha256:await sha256File(pageFile),
          byteSize:info.size,
          width,height
        });
      }
      const limitations=[];
      const representationIndex={
        version:1,
        sourceId:source.handle.sourceId,
        originalSha256:source.handle.sha256,
        kind:"pdf",
        pageCount:pages.length,
        extractedText:{
          relativePath:`${source.handle.sourceId}.extracted.txt`,
          sha256:sha256Bytes(textBytes),
          byteSize:textBytes.length,
          textAvailable:textBytes.toString("utf8").trim().length>0
        },
        pages,
        coverageStatus:"complete",
        limitations
      };
      return await publishTaskDerivedEvidence({
        workspaceDir,
        source,
        stagedFiles:[
          {
            absolutePath:stagedText,
            relativePath:representationIndex.extractedText.relativePath
          },
          ...prepared.pageImages.map((absolutePath,index)=>({
            absolutePath,
            relativePath:pages[index].relativePath
          }))
        ],
        representationIndex,
        producedBy:PRODUCED_BY,
        limitations,
        now,
        signal
      });
    } finally {
      await rm(job,{recursive:true,force:true});
    }
  }

  async reuse({workspaceDir,source,signal,now}) {
    const sourceId=source?.handle?.sourceId;
    if (!/^source-00[1-8]$/u.test(sourceId||"")) {
      throw new Error("task_pdf_reader_invalid");
    }
    const indexPath=join(workspaceDir,`${sourceId}.pdf-index.json`);
    const sidecarPath=join(workspaceDir,`${sourceId}.manifest.json`);
    const indexInfo=await optionalPrivateFile(indexPath);
    const sidecarInfo=await optionalPrivateFile(sidecarPath);
    if (!indexInfo&&!sidecarInfo) return null;
    if (!indexInfo||!sidecarInfo||indexInfo.size>512*1024) {
      throw new Error("task_pdf_reader_invalid");
    }
    signal?.throwIfAborted();
    const representationIndex=JSON.parse(
      await readFile(indexPath,"utf8")
    );
    const refs=[
      representationIndex?.extractedText,
      ...(representationIndex?.pages||[])
    ];
    if (refs.some(item=>
      !item||typeof item.relativePath!=="string"
    )) {
      throw new Error("task_pdf_reader_invalid");
    }
    return publishTaskDerivedEvidence({
      workspaceDir,
      source,
      stagedFiles:refs.map(item=>({
        absolutePath:join(workspaceDir,item.relativePath),
        relativePath:item.relativePath
      })),
      representationIndex,
      producedBy:PRODUCED_BY,
      limitations:representationIndex.limitations,
      now,
      signal
    });
  }

  async ensureTempRoot() {
    await mkdir(this.tempRoot,{recursive:true,mode:0o700});
    await chmod(this.tempRoot,0o700);
    const info=await lstat(this.tempRoot);
    if (!info.isDirectory()||info.isSymbolicLink()||
        info.uid!==process.getuid()||(info.mode&0o077)!==0) {
      throw new Error("task_pdf_reader_invalid");
    }
    await realpath(this.tempRoot);
  }
}

function validatePrepared(value,maxPages) {
  if (!value||typeof value!=="object"||Array.isArray(value)||
      typeof value.extractedText!=="string"||
      !Array.isArray(value.pageImages)||
      value.pageImages.length<1||value.pageImages.length>maxPages||
      value.pageImages.some(path=>
        typeof path!=="string"||!isAbsolute(path)
      )||
      !value.documentFacts||
      value.documentFacts.pageCount!==value.pageImages.length||
      typeof value.documentFacts.textAvailable!=="boolean"||
      value.documentFacts.textAvailable!==
        (value.extractedText.trim().length>0)) {
    throw new Error("task_pdf_reader_invalid");
  }
}

async function readPngDimensions(file) {
  const handle=await open(file,"r");
  try {
    const header=Buffer.alloc(24);
    const {bytesRead}=await handle.read(header,0,header.length,0);
    if (bytesRead!==header.length||
        !header.subarray(0,8).equals(PNG_SIGNATURE)||
        header.readUInt32BE(8)!==13||
        header.toString("ascii",12,16)!=="IHDR") {
      throw new Error("task_pdf_reader_invalid");
    }
    const width=header.readUInt32BE(16);
    const height=header.readUInt32BE(20);
    if (!width||!height) throw new Error("task_pdf_reader_invalid");
    return {width,height};
  } finally {
    await handle.close();
  }
}

async function optionalPrivateFile(file) {
  try {
    const info=await lstat(file);
    if (!info.isFile()||info.isSymbolicLink()||
        info.uid!==process.getuid()||(info.mode&0o077)!==0) {
      throw new Error("task_pdf_reader_invalid");
    }
    return info;
  } catch (error) {
    if (error?.code==="ENOENT") return null;
    throw error;
  }
}

async function sha256File(file) {
  const hash=createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function boundedInteger(value,min,max) {
  return Number.isSafeInteger(value)&&value>=min&&value<=max;
}

function canonicalIso(value) {
  return typeof value==="string"&&Number.isFinite(Date.parse(value))&&
    new Date(value).toISOString()===value;
}
