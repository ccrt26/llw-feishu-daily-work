import {createHash,randomUUID} from "node:crypto";
import {createReadStream} from "node:fs";
import {
  chmod,constants as fsConstants,copyFile,lstat,open,readFile,
  realpath,rename,rm
} from "node:fs/promises";
import {isAbsolute,join,relative,resolve} from "node:path";
import {createSourceHandle} from "./source-handle.mjs";

const SOURCE_ID=/^source-00[1-8]$/u;
const SHA=/^[a-f0-9]{64}$/u;
const PRODUCER=/^[A-Za-z0-9._-]{1,128}$/u;
const PNG_SIGNATURE=Buffer.from([
  0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a
]);
const MAX_PAGES=16;
const MAX_TEXT_BYTES=256*1024;
const MAX_DERIVED_BYTES=100*1024*1024;
const INDEX_FIELDS=new Set([
  "version","sourceId","originalSha256","kind","pageCount",
  "extractedText","pages","coverageStatus","limitations"
]);
const TEXT_FIELDS=new Set([
  "relativePath","sha256","byteSize","textAvailable"
]);
const PAGE_FIELDS=new Set([
  "pageNumber","relativePath","sha256","byteSize","width","height"
]);

export async function publishTaskDerivedEvidence(options) {
  try {
    return await publish(options);
  } catch (error) {
    if (error?.name==="AbortError"||
        error?.message==="task_derived_evidence_invalid") {
      throw error;
    }
    throw invalid();
  }
}

async function publish(options) {
  if (!plain(options)) throw invalid();
  const allowed=new Set([
    "workspaceDir","source","stagedFiles","representationIndex",
    "producedBy","limitations","now","signal"
  ]);
  if (Object.keys(options).some(key=>!allowed.has(key))) throw invalid();
  const {
    workspaceDir,source,stagedFiles,representationIndex,
    producedBy,limitations,now,signal
  }=options;
  if (typeof workspaceDir!=="string"||!isAbsolute(workspaceDir)||
      !PRODUCER.test(producedBy||"")||
      !safeLimitations(limitations)||!canonicalIso(now)||
      !(signal===undefined||signal instanceof AbortSignal)) {
    throw invalid();
  }
  signal?.throwIfAborted();
  const actualWorkspace=await privateWorkspace(workspaceDir);
  const binding=await validateOriginal({
    source,workspaceDir:actualWorkspace
  });
  const index=validateIndex(
    representationIndex,binding.handle,limitations
  );
  const staged=await validateStagedFiles({
    stagedFiles,index,signal
  });
  signal?.throwIfAborted();

  const indexRelativePath=`${binding.handle.sourceId}.pdf-index.json`;
  const indexPath=join(actualWorkspace,indexRelativePath);
  const sidecarPath=join(
    actualWorkspace,`${binding.handle.sourceId}.manifest.json`
  );
  const existing=await loadExisting({
    workspaceDir:actualWorkspace,
    source:binding,
    expectedIndex:index,
    indexPath,indexRelativePath,sidecarPath,
    producedBy,limitations,signal
  });
  if (existing) return existing;

  const finalPaths=[
    ...staged.map(item=>join(actualWorkspace,item.relativePath)),
    indexPath,sidecarPath
  ];
  for (const file of finalPaths) {
    if (await exists(file)) throw invalid();
  }

  const temporaryPaths=[];
  const publishedPaths=[];
  try {
    for (const item of staged) {
      signal?.throwIfAborted();
      const final=join(actualWorkspace,item.relativePath);
      const temporary=join(
        actualWorkspace,`.derived-${randomUUID()}.tmp`
      );
      temporaryPaths.push(temporary);
      await copyFile(
        item.absolutePath,temporary,fsConstants.COPYFILE_EXCL
      );
      await chmod(temporary,0o600);
      await syncFile(temporary);
      await verifyPublishedFile(temporary,item);
      signal?.throwIfAborted();
      await rename(temporary,final);
      temporaryPaths.splice(temporaryPaths.indexOf(temporary),1);
      publishedPaths.push(final);
    }

    signal?.throwIfAborted();
    const indexBytes=Buffer.from(
      `${JSON.stringify(index,null,2)}\n`,"utf8"
    );
    await atomicWrite(indexPath,indexBytes,temporaryPaths);
    publishedPaths.push(indexPath);
    const indexSha256=sha256Bytes(indexBytes);

    signal?.throwIfAborted();
    const sidecar={
      version:1,
      original:{
        sourceId:binding.handle.sourceId,
        relativePath:binding.handle.relativePath,
        byteSize:binding.handle.byteSize,
        sha256:binding.handle.sha256,
        mime:"application/pdf"
      },
      derived:[{
        kind:"navigation",
        relativePath:indexRelativePath,
        sha256:indexSha256,
        producedBy,
        createdAt:now,
        limitations:[...limitations]
      }],
      createdAt:now,
      updatedAt:now
    };
    const sidecarBytes=Buffer.from(
      `${JSON.stringify(sidecar,null,2)}\n`,"utf8"
    );
    await atomicWrite(sidecarPath,sidecarBytes,temporaryPaths);
    publishedPaths.push(sidecarPath);
    signal?.throwIfAborted();

    return await buildResult({
      workspaceDir:actualWorkspace,index,
      indexRelativePath,producedBy,limitations
    });
  } catch (error) {
    for (const file of [...temporaryPaths,...publishedPaths].reverse()) {
      await rm(file,{force:true}).catch(()=>{});
    }
    throw error;
  }
}

async function validateOriginal({source,workspaceDir}) {
  if (!plain(source)) throw invalid();
  const handle=createSourceHandle(source.handle??source);
  if (handle.mediaClass!=="document"||handle.format!=="pdf") {
    throw invalid();
  }
  const absolutePath=source.absolutePath;
  if (typeof absolutePath!=="string"||!isAbsolute(absolutePath)) {
    throw invalid();
  }
  const info=await privateFile(absolutePath,workspaceDir);
  const actualPath=await realpath(absolutePath);
  if (resolve(workspaceDir,handle.relativePath)!==actualPath) {
    throw invalid();
  }
  if (info.size!==handle.byteSize||
      await sha256File(absolutePath)!==handle.sha256) {
    throw invalid();
  }
  return Object.freeze({handle,absolutePath:actualPath});
}

function validateIndex(value,handle,limitations) {
  if (!exact(value,INDEX_FIELDS)||
      value.version!==1||
      value.sourceId!==handle.sourceId||
      value.originalSha256!==handle.sha256||
      value.kind!=="pdf"||
      !Number.isSafeInteger(value.pageCount)||
      value.pageCount<1||value.pageCount>MAX_PAGES||
      !exact(value.extractedText,TEXT_FIELDS)||
      !Array.isArray(value.pages)||
      value.pages.length!==value.pageCount||
      value.coverageStatus!=="complete"||
      !sameArray(value.limitations,limitations)||
      !safeLimitations(value.limitations)) {
    throw invalid();
  }
  const text=value.extractedText;
  if (text.relativePath!==`${handle.sourceId}.extracted.txt`||
      !SHA.test(text.sha256||"")||
      !Number.isSafeInteger(text.byteSize)||text.byteSize<0||
      text.byteSize>MAX_TEXT_BYTES||
      typeof text.textAvailable!=="boolean") {
    throw invalid();
  }
  let total=text.byteSize;
  for (let index=0;index<value.pages.length;index+=1) {
    const page=value.pages[index];
    const pageNumber=index+1;
    if (!exact(page,PAGE_FIELDS)||
        page.pageNumber!==pageNumber||
        page.relativePath!==
          `${handle.sourceId}.page-${String(pageNumber).padStart(3,"0")}.png`||
        !SHA.test(page.sha256||"")||
        !Number.isSafeInteger(page.byteSize)||page.byteSize<PNG_SIGNATURE.length||
        !Number.isSafeInteger(page.width)||page.width<1||page.width>3508||
        !Number.isSafeInteger(page.height)||page.height<1||page.height>3508) {
      throw invalid();
    }
    total+=page.byteSize;
    if (!Number.isSafeInteger(total)||total>MAX_DERIVED_BYTES) {
      throw invalid();
    }
  }
  return structuredClone(value);
}

async function validateStagedFiles({stagedFiles,index,signal}) {
  if (!Array.isArray(stagedFiles)||
      stagedFiles.length!==index.pageCount+1) {
    throw invalid();
  }
  const expected=[
    index.extractedText,
    ...index.pages
  ];
  const result=[];
  for (let position=0;position<stagedFiles.length;position+=1) {
    signal?.throwIfAborted();
    const item=stagedFiles[position];
    const descriptor=expected[position];
    if (!exact(item,new Set(["absolutePath","relativePath"]))||
        typeof item.absolutePath!=="string"||
        !isAbsolute(item.absolutePath)||
        item.relativePath!==descriptor.relativePath||
        !safeRelative(item.relativePath,index.sourceId)) {
      throw invalid();
    }
    const info=await privateStagedFile(item.absolutePath);
    if (info.size!==descriptor.byteSize||
        await sha256File(item.absolutePath)!==descriptor.sha256) {
      throw invalid();
    }
    if (position===0) {
      let text;
      try {
        text=new TextDecoder("utf-8",{fatal:true}).decode(
          await readFile(item.absolutePath)
        );
      } catch {
        throw invalid();
      }
      if ((text.trim().length>0)!==descriptor.textAvailable) {
        throw invalid();
      }
    } else {
      await validatePngSignature(item.absolutePath);
    }
    result.push(Object.freeze({
      absolutePath:item.absolutePath,
      relativePath:item.relativePath,
      sha256:descriptor.sha256,
      byteSize:descriptor.byteSize
    }));
  }
  if (new Set(result.map(item=>item.relativePath)).size!==result.length) {
    throw invalid();
  }
  return result;
}

async function loadExisting({
  workspaceDir,source,expectedIndex,indexPath,indexRelativePath,
  sidecarPath,producedBy,limitations,signal
}) {
  const indexExists=await exists(indexPath);
  const sidecarExists=await exists(sidecarPath);
  if (!indexExists&&!sidecarExists) return null;
  if (!indexExists||!sidecarExists) throw invalid();
  signal?.throwIfAborted();
  await privateFile(indexPath,workspaceDir);
  await privateFile(sidecarPath,workspaceDir);
  const index=JSON.parse(await readBounded(indexPath,512*1024));
  validateIndex(index,source.handle,limitations);
  if (JSON.stringify(index)!==JSON.stringify(expectedIndex)) {
    throw invalid();
  }
  const expectedFiles=[index.extractedText,...index.pages];
  for (const descriptor of expectedFiles) {
    const file=join(workspaceDir,descriptor.relativePath);
    const info=await privateFile(file,workspaceDir);
    if (info.size!==descriptor.byteSize||
        await sha256File(file)!==descriptor.sha256) {
      throw invalid();
    }
  }
  const sidecarBytes=await readBounded(sidecarPath,512*1024);
  const sidecar=JSON.parse(sidecarBytes);
  const indexSha256=await sha256File(indexPath);
  if (!validExistingSidecar({
    sidecar,source,indexRelativePath,indexSha256,
    producedBy,limitations
  })) {
    throw invalid();
  }
  signal?.throwIfAborted();
  return buildResult({
    workspaceDir,index,indexRelativePath,producedBy,limitations
  });
}

function validExistingSidecar({
  sidecar,source,indexRelativePath,indexSha256,producedBy,limitations
}) {
  if (!exact(sidecar,new Set([
    "version","original","derived","createdAt","updatedAt"
  ]))||
      sidecar.version!==1||
      !exact(sidecar.original,new Set([
        "sourceId","relativePath","byteSize","sha256","mime"
      ]))||
      sidecar.original.sourceId!==source.handle.sourceId||
      sidecar.original.relativePath!==source.handle.relativePath||
      sidecar.original.byteSize!==source.handle.byteSize||
      sidecar.original.sha256!==source.handle.sha256||
      sidecar.original.mime!=="application/pdf"||
      !Array.isArray(sidecar.derived)||sidecar.derived.length!==1||
      !canonicalIso(sidecar.createdAt)||
      !canonicalIso(sidecar.updatedAt)||
      Date.parse(sidecar.updatedAt)<Date.parse(sidecar.createdAt)) {
    return false;
  }
  const derived=sidecar.derived[0];
  return exact(derived,new Set([
    "kind","relativePath","sha256","producedBy","createdAt","limitations"
  ]))&&derived.kind==="navigation"&&
    derived.relativePath===indexRelativePath&&
    derived.sha256===indexSha256&&
    derived.producedBy===producedBy&&
    canonicalIso(derived.createdAt)&&
    sameArray(derived.limitations,limitations);
}

async function buildResult({
  workspaceDir,index,indexRelativePath,producedBy,limitations
}) {
  const text=await readBounded(
    join(workspaceDir,index.extractedText.relativePath),
    MAX_TEXT_BYTES
  );
  const content=boundedObservationContent({
    kind:"pdf",
    pageCount:index.pageCount,
    textAvailable:index.extractedText.textAvailable,
    coverageStatus:index.coverageStatus,
    extractedText:text
  });
  return Object.freeze({
    representationIndexPath:indexRelativePath,
    observations:Object.freeze([Object.freeze({
      sourceId:index.sourceId,
      view:"read_pdf",
      derivedRelativePath:index.extractedText.relativePath,
      sha256:index.extractedText.sha256,
      producedBy,
      content,
      limitations:Object.freeze([...limitations])
    })]),
    modelImageFiles:Object.freeze(
      index.pages.map(page=>Object.freeze({
        sourceId:index.sourceId,
        relativePath:page.relativePath,
        sha256:page.sha256,
        pageNumber:page.pageNumber
      }))
    )
  });
}

function boundedObservationContent(value) {
  const complete=JSON.stringify({...value,textTruncated:false});
  if (Buffer.byteLength(complete,"utf8")<=MAX_TEXT_BYTES) {
    return complete;
  }
  const characters=Array.from(value.extractedText);
  let low=0,high=characters.length;
  while (low<high) {
    const middle=Math.ceil((low+high)/2);
    const candidate=JSON.stringify({
      ...value,
      extractedText:characters.slice(0,middle).join(""),
      textTruncated:true
    });
    if (Buffer.byteLength(candidate,"utf8")<=MAX_TEXT_BYTES) {
      low=middle;
    } else {
      high=middle-1;
    }
  }
  const bounded=JSON.stringify({
    ...value,
    extractedText:characters.slice(0,low).join(""),
    textTruncated:true
  });
  if (Buffer.byteLength(bounded,"utf8")>MAX_TEXT_BYTES) throw invalid();
  return bounded;
}

async function privateWorkspace(value) {
  const info=await lstat(value);
  if (!info.isDirectory()||info.isSymbolicLink()||
      info.uid!==process.getuid()||(info.mode&0o077)!==0) {
    throw invalid();
  }
  return realpath(value);
}

async function privateFile(file,workspaceDir) {
  const info=await lstat(file);
  const actual=await realpath(file);
  const fromWorkspace=relative(workspaceDir,actual);
  if (!info.isFile()||info.isSymbolicLink()||
      info.uid!==process.getuid()||(info.mode&0o077)!==0||
      fromWorkspace.startsWith("..")||isAbsolute(fromWorkspace)||
      resolve(workspaceDir,fromWorkspace)!==actual) {
    throw invalid();
  }
  return info;
}

async function privateStagedFile(file) {
  const info=await lstat(file);
  if (!info.isFile()||info.isSymbolicLink()||
      info.uid!==process.getuid()||(info.mode&0o077)!==0) {
    throw invalid();
  }
  await realpath(file);
  return info;
}

async function validatePngSignature(file) {
  const handle=await open(file,"r");
  try {
    const header=Buffer.alloc(PNG_SIGNATURE.length);
    const {bytesRead}=await handle.read(header,0,header.length,0);
    if (bytesRead!==header.length||!header.equals(PNG_SIGNATURE)) {
      throw invalid();
    }
  } finally {
    await handle.close();
  }
}

async function verifyPublishedFile(file,expected) {
  const info=await lstat(file);
  if (!info.isFile()||info.isSymbolicLink()||
      info.uid!==process.getuid()||(info.mode&0o077)!==0||
      info.size!==expected.byteSize||
      await sha256File(file)!==expected.sha256) {
    throw invalid();
  }
}

async function atomicWrite(file,bytes,temporaryPaths) {
  const temporary=`${file}.${randomUUID()}.tmp`;
  temporaryPaths.push(temporary);
  const handle=await open(temporary,"wx",0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary,file);
  temporaryPaths.splice(temporaryPaths.indexOf(temporary),1);
  await chmod(file,0o600);
}

async function syncFile(file) {
  const handle=await open(file,"r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readBounded(file,maxBytes) {
  const info=await lstat(file);
  if (info.size>maxBytes) throw invalid();
  return readFile(file,"utf8");
}

async function sha256File(file) {
  const hash=createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error?.code==="ENOENT") return false;
    throw error;
  }
}

function safeRelative(value,sourceId) {
  return typeof value==="string"&&
    !isAbsolute(value)&&!value.includes("/")&&!value.includes("\\")&&
    !value.includes("\0")&&value.startsWith(`${sourceId}.`)&&
    /^[A-Za-z0-9._-]+$/u.test(value);
}

function safeLimitations(value) {
  return Array.isArray(value)&&value.length<=8&&
    value.every(item=>
      typeof item==="string"&&item.length>0&&
      Buffer.byteLength(item,"utf8")<=1_000
    );
}

function exact(value,fields) {
  return plain(value)&&Object.keys(value).length===fields.size&&
    Object.keys(value).every(key=>fields.has(key));
}

function plain(value) {
  return value&&typeof value==="object"&&!Array.isArray(value)&&
    Object.getPrototypeOf(value)===Object.prototype;
}

function sameArray(left,right) {
  return Array.isArray(left)&&Array.isArray(right)&&
    left.length===right.length&&
    left.every((value,index)=>value===right[index]);
}

function canonicalIso(value) {
  return typeof value==="string"&&Number.isFinite(Date.parse(value))&&
    new Date(value).toISOString()===value;
}

function invalid() {
  return new Error("task_derived_evidence_invalid");
}
