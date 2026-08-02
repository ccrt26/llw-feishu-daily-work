import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {lstat,open,realpath} from "node:fs/promises";
import {isAbsolute,join,relative,resolve} from "node:path";

const SOURCE_ID=/^source-00[1-8]$/u;
const SAFE_PATH=/^[A-Za-z0-9._-]+$/u;
const SHA=/^[a-f0-9]{64}$/u;
const PNG_SIGNATURE=Buffer.from([
  0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a
]);
const PDF_FIELDS=new Set([
  "sourceId","relativePath","sha256","pageNumber"
]);
const VIDEO_FIELDS=new Set([
  "sourceId","relativePath","sha256","startMs","endMs"
]);
const DOCX_FIELDS=new Set([
  "sourceId","relativePath","sha256","documentOrder",
  "ownerPartName","relationshipId","targetMediaPartName"
]);

export async function validateModelImageEvidence(options) {
  try {
    return await validate(options);
  } catch (error) {
    if (error?.message==="model_image_evidence_invalid") throw error;
    throw invalid();
  }
}

async function validate(options) {
  if (!plain(options)) throw invalid();
  const allowed=new Set([
    "workspaceDir","files","maxFiles","maxTotalBytes",
    "maxDimension","maxPixels"
  ]);
  if (Object.keys(options).some(key=>!allowed.has(key))) throw invalid();
  const {
    workspaceDir,files,
    maxFiles=16,
    maxTotalBytes=100*1024*1024,
    maxDimension=3508,
    maxPixels=12_306_064
  }=options;
  if (typeof workspaceDir!=="string"||!isAbsolute(workspaceDir)||
      !bounded(maxFiles,1,16)||
      !bounded(maxTotalBytes,1,100*1024*1024)||
      !bounded(maxDimension,1,3508)||
      !bounded(maxPixels,1,12_306_064)||
      !Array.isArray(files)||files.length>maxFiles) {
    throw invalid();
  }
  const normalized=validateDescriptors(files);
  const actualWorkspace=await privateWorkspace(workspaceDir);
  let totalBytes=0;
  const paths=[];
  for (const item of normalized) {
    const file=join(actualWorkspace,item.relativePath);
    const info=await privateImageFile({
      file,workspaceDir:actualWorkspace
    });
    totalBytes+=info.size;
    if (!Number.isSafeInteger(totalBytes)||
        totalBytes>maxTotalBytes) {
      throw invalid();
    }
    const {width,height}=await readPngHeader(file);
    if (width>maxDimension||height>maxDimension||
        width*height>maxPixels) {
      throw invalid();
    }
    if (await sha256(file)!==item.sha256) throw invalid();
    paths.push(item.relativePath);
  }
  return Object.freeze(paths);
}

function validateDescriptors(files) {
  const seenPaths=new Set();
  const nextPage=new Map();
  const lastVideoEnd=new Map();
  const lastDocxOrder=new Map();
  return files.map(value=>{
    if (!plain(value)||
        !SOURCE_ID.test(value.sourceId||"")||
        typeof value.relativePath!=="string"||
        isAbsolute(value.relativePath)||
        value.relativePath.includes("/")||
        value.relativePath.includes("\\")||
        value.relativePath.includes("\0")||
        !SAFE_PATH.test(value.relativePath)||
        !value.relativePath.startsWith(`${value.sourceId}.`)||
        !value.relativePath.endsWith(".png")||
        !SHA.test(value.sha256||"")||
        seenPaths.has(value.relativePath)) {
      throw invalid();
    }
    seenPaths.add(value.relativePath);
    const hasPage=Object.hasOwn(value,"pageNumber");
    const hasTime=Object.hasOwn(value,"startMs")||
      Object.hasOwn(value,"endMs");
    const hasDocx=Object.hasOwn(value,"documentOrder")||
      Object.hasOwn(value,"ownerPartName")||
      Object.hasOwn(value,"relationshipId")||
      Object.hasOwn(value,"targetMediaPartName");
    if ([hasPage,hasTime,hasDocx].filter(Boolean).length!==1) throw invalid();
    if (hasPage) {
      if (!exact(value,PDF_FIELDS)||
          !bounded(value.pageNumber,1,16)) {
        throw invalid();
      }
      const expected=nextPage.get(value.sourceId)??1;
      if (value.pageNumber!==expected) throw invalid();
      nextPage.set(value.sourceId,expected+1);
    } else if (hasTime) {
      if (!exact(value,VIDEO_FIELDS)||
          !Number.isSafeInteger(value.startMs)||value.startMs<0||
          !Number.isSafeInteger(value.endMs)||
          value.endMs<=value.startMs||
          value.endMs>7*24*60*60*1000) {
        throw invalid();
      }
      const previous=lastVideoEnd.get(value.sourceId)??0;
      if (value.startMs<previous) throw invalid();
      lastVideoEnd.set(value.sourceId,value.endMs);
    } else {
      if (!exact(value,DOCX_FIELDS)||
          !bounded(value.documentOrder,1,8_999_999)||
          !/^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/u
            .test(value.ownerPartName||"")||
          !/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/u
            .test(value.relationshipId||"")||
          !/^word\/media\/[A-Za-z0-9._-]+\.png$/u
            .test(value.targetMediaPartName||"")||
          !new RegExp(
            `^${value.sourceId}\\.docx-image-[0-9]{3}\\.png$`,"u"
          ).test(value.relativePath)) throw invalid();
      const previous=lastDocxOrder.get(value.sourceId)??0;
      if (value.documentOrder<=previous) throw invalid();
      lastDocxOrder.set(value.sourceId,value.documentOrder);
    }
    return structuredClone(value);
  });
}

async function privateWorkspace(workspaceDir) {
  const info=await lstat(workspaceDir);
  if (!info.isDirectory()||info.isSymbolicLink()||
      info.uid!==process.getuid()||(info.mode&0o077)!==0) {
    throw invalid();
  }
  return realpath(workspaceDir);
}

async function privateImageFile({file,workspaceDir}) {
  const info=await lstat(file);
  const actual=await realpath(file);
  const fromWorkspace=relative(workspaceDir,actual);
  if (!info.isFile()||info.isSymbolicLink()||
      info.uid!==process.getuid()||(info.mode&0o077)!==0||
      fromWorkspace.startsWith("..")||isAbsolute(fromWorkspace)||
      resolve(workspaceDir,fromWorkspace)!==actual||
      actual!==file) {
    throw invalid();
  }
  return info;
}

async function readPngHeader(file) {
  const handle=await open(file,"r");
  try {
    const header=Buffer.alloc(24);
    const {bytesRead}=await handle.read(header,0,header.length,0);
    if (bytesRead!==header.length||
        !header.subarray(0,8).equals(PNG_SIGNATURE)||
        header.readUInt32BE(8)!==13||
        header.toString("ascii",12,16)!=="IHDR") {
      throw invalid();
    }
    const width=header.readUInt32BE(16);
    const height=header.readUInt32BE(20);
    if (!width||!height) throw invalid();
    return {width,height};
  } finally {
    await handle.close();
  }
}

async function sha256(file) {
  const hash=createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function bounded(value,min,max) {
  return Number.isSafeInteger(value)&&value>=min&&value<=max;
}

function exact(value,fields) {
  return plain(value)&&Object.keys(value).length===fields.size&&
    Object.keys(value).every(key=>fields.has(key));
}

function plain(value) {
  return value&&typeof value==="object"&&!Array.isArray(value)&&
    Object.getPrototypeOf(value)===Object.prototype;
}

function invalid() {
  return new Error("model_image_evidence_invalid");
}
