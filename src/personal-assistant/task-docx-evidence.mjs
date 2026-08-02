import {createHash,randomUUID} from "node:crypto";
import {createReadStream} from "node:fs";
import {
  chmod,constants as fsConstants,copyFile,lstat,open,readFile,
  readdir,realpath,rename,rm
} from "node:fs/promises";
import {isAbsolute,join,relative,resolve} from "node:path";
import {
  openBoundedOoxmlPackage,parseOoxmlRelationships,resolveOoxmlTarget
} from "./bounded-ooxml-package.mjs";
import {createSourceHandle} from "./source-handle.mjs";

const SOURCE_ID=/^source-00[1-8]$/u;
const SHA=/^[a-f0-9]{64}$/u;
const PRODUCER=/^[A-Za-z0-9._-]{1,128}$/u;
const PNG_SIGNATURE=Buffer.from([
  0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a
]);
const INDEX_FIELDS=new Set([
  "version","sourceId","originalSha256","kind","text","images","coverage"
]);
const TEXT_FIELDS=new Set([
  "relativePath","sha256","byteSize","observationCount"
]);
const IMAGE_FIELDS=new Set([
  "relativePath","sha256","byteSize","width","height","documentOrder",
  "ownerPartName","relationshipId","targetMediaPartName"
]);
const COVERAGE_FIELDS=new Set(["status","limitations","parts"]);
const PARTS_FIELDS=new Set([
  "parsed","relationships","representedMedia"
]);
const TEXT_DOCUMENT_FIELDS=new Set([
  "version","sourceId","originalSha256","observations"
]);
const OBSERVATION_BASE_FIELDS=new Set([
  "ownerPartName","documentOrder","type","text"
]);
const OBSERVATION_LEVEL_FIELDS=new Set([
  ...OBSERVATION_BASE_FIELDS,"level"
]);
const IMAGE_RELATIONSHIP_TYPES=new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
  "http://purl.oclc.org/ooxml/officeDocument/relationships/image"
]);
const DOCX_MIME=
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOCX_PRODUCER="llw-task-docx-reader-v1";
const MAX_INDEX_BYTES=768*1024;
const MAX_TEXT_BYTES=256*1024;
const MAX_DERIVED_BYTES=100*1024*1024;

export async function publishTaskDocxEvidence(options) {
  try {
    return await publish(options);
  } catch (error) {
    if (error?.name==="AbortError"||
        error?.message==="task_docx_evidence_invalid") throw error;
    throw invalid();
  }
}

export async function reuseTaskDocxEvidence({workspaceDir,source,signal}={}) {
  try {
    if (typeof workspaceDir!=="string"||!isAbsolute(workspaceDir)||
        !(signal===undefined||signal instanceof AbortSignal)) throw invalid();
    signal?.throwIfAborted();
    const actualWorkspace=await privateWorkspace(workspaceDir);
    const binding=await validateOriginal({source,workspaceDir:actualWorkspace});
    const indexPath=join(
      actualWorkspace,`${binding.handle.sourceId}.docx-index.json`
    );
    const sidecarPath=join(
      actualWorkspace,`${binding.handle.sourceId}.manifest.json`
    );
    const indexExists=await exists(indexPath);
    const sidecarExists=await exists(sidecarPath);
    if (!indexExists&&!sidecarExists) return null;
    if (!indexExists||!sidecarExists) throw invalid();
    await privateFile(indexPath,actualWorkspace);
    await privateFile(sidecarPath,actualWorkspace);
    const index=validateIndex(
      JSON.parse(await readBounded(indexPath,MAX_INDEX_BYTES)),binding.handle
    );
    await validateDurableEvidence({
      workspaceDir:actualWorkspace,binding,index,signal
    });
    const indexSha256=await sha256File(indexPath);
    const sidecar=JSON.parse(await readBounded(sidecarPath,MAX_INDEX_BYTES));
    if (!validSidecar({
      sidecar,binding,indexRelativePath:`${binding.handle.sourceId}.docx-index.json`,
      indexSha256,index
    })) throw invalid();
    await assertExactDurableSet(actualWorkspace,index);
    signal?.throwIfAborted();
    return buildResult({
      workspaceDir:actualWorkspace,index,indexSha256,
      producedBy:sidecar.derived[0].producedBy
    });
  } catch (error) {
    if (error?.name==="AbortError"||
        error?.message==="task_docx_evidence_invalid") throw error;
    throw invalid();
  }
}

async function publish(options) {
  if (!plain(options)||!exactKeys(options,new Set([
    "workspaceDir","source","stagedFiles","representationIndex",
    "producedBy","now"
  ]),new Set(["signal"]))) throw invalid();
  const {
    workspaceDir,source,stagedFiles,representationIndex,
    producedBy,now,signal
  }=options;
  if (typeof workspaceDir!=="string"||!isAbsolute(workspaceDir)||
      producedBy!==DOCX_PRODUCER||!PRODUCER.test(producedBy)||
      !canonicalIso(now)||
      !(signal===undefined||signal instanceof AbortSignal)) throw invalid();
  signal?.throwIfAborted();
  const actualWorkspace=await privateWorkspace(workspaceDir);
  const binding=await validateOriginal({source,workspaceDir:actualWorkspace});
  const index=validateIndex(representationIndex,binding.handle);
  const staged=await validateStagedEvidence({
    stagedFiles,index,binding,signal
  });
  const indexRelativePath=`${binding.handle.sourceId}.docx-index.json`;
  const indexPath=join(actualWorkspace,indexRelativePath);
  const sidecarPath=join(
    actualWorkspace,`${binding.handle.sourceId}.manifest.json`
  );
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
      const temporary=join(actualWorkspace,`.docx-${randomUUID()}.tmp`);
      temporaryPaths.push(temporary);
      await copyFile(item.absolutePath,temporary,fsConstants.COPYFILE_EXCL);
      await chmod(temporary,0o600);
      await syncFile(temporary);
      await verifyFile(temporary,item);
      signal?.throwIfAborted();
      await rename(temporary,final);
      temporaryPaths.splice(temporaryPaths.indexOf(temporary),1);
      publishedPaths.push(final);
    }
    const indexBytes=Buffer.from(`${JSON.stringify(index,null,2)}\n`,"utf8");
    if (indexBytes.length>MAX_INDEX_BYTES) throw invalid();
    await atomicWrite(indexPath,indexBytes,temporaryPaths);
    publishedPaths.push(indexPath);
    const indexSha256=sha256Bytes(indexBytes);
    const sidecar={
      version:1,
      original:{
        sourceId:binding.handle.sourceId,
        relativePath:binding.handle.relativePath,
        byteSize:binding.handle.byteSize,
        sha256:binding.handle.sha256,
        mime:DOCX_MIME
      },
      derived:[{
        kind:"navigation",relativePath:indexRelativePath,
        sha256:indexSha256,producedBy,createdAt:now,
        limitations:boundedModelLimitations(index.coverage.limitations)
      }],
      createdAt:now,updatedAt:now
    };
    await atomicWrite(
      sidecarPath,
      Buffer.from(`${JSON.stringify(sidecar,null,2)}\n`,"utf8"),
      temporaryPaths
    );
    publishedPaths.push(sidecarPath);
    signal?.throwIfAborted();
    return await buildResult({
      workspaceDir:actualWorkspace,index,indexSha256,producedBy
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
  if (handle.mediaClass!=="document"||handle.format!=="docx"||
      source.archiveExtension!=="docx"||
      typeof source.absolutePath!=="string"||
      !isAbsolute(source.absolutePath)) throw invalid();
  const info=await privateFile(source.absolutePath,workspaceDir);
  const actual=await realpath(source.absolutePath);
  if (resolve(workspaceDir,handle.relativePath)!==actual||
      info.size!==handle.byteSize||await sha256File(actual)!==handle.sha256) {
    throw invalid();
  }
  return Object.freeze({handle,absolutePath:actual});
}

function validateIndex(value,handle) {
  if (!exact(value,INDEX_FIELDS)||value.version!==1||
      value.sourceId!==handle.sourceId||
      value.originalSha256!==handle.sha256||value.kind!=="docx"||
      !exact(value.text,TEXT_FIELDS)||!Array.isArray(value.images)||
      value.images.length>16||!exact(value.coverage,COVERAGE_FIELDS)) {
    throw invalid();
  }
  const text=value.text;
  if (text.relativePath!==`${handle.sourceId}.docx-text.json`||
      !SHA.test(text.sha256||"")||!bounded(text.byteSize,2,MAX_TEXT_BYTES)||
      !bounded(text.observationCount,0,100_000)) throw invalid();
  const images=[];
  let total=text.byteSize,lastOrder=0;
  const relationships=new Set();
  for (let index=0;index<value.images.length;index+=1) {
    const image=value.images[index];
    const expectedName=
      `${handle.sourceId}.docx-image-${String(index+1).padStart(3,"0")}.png`;
    if (!exact(image,IMAGE_FIELDS)||image.relativePath!==expectedName||
        !SHA.test(image.sha256||"")||
        !bounded(image.byteSize,PNG_SIGNATURE.length,20*1024*1024)||
        !bounded(image.width,1,3508)||!bounded(image.height,1,3508)||
        image.width*image.height>12_306_064||
        !bounded(image.documentOrder,1,8_999_999)||
        image.documentOrder<=lastOrder||
        !ownerPart(image.ownerPartName)||
        !/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/u.test(image.relationshipId||"")||
        !/^word\/media\/[A-Za-z0-9._-]+\.png$/u
          .test(image.targetMediaPartName||"")) throw invalid();
    const relationKey=`${image.ownerPartName}\0${image.relationshipId}`;
    if (relationships.has(relationKey)) throw invalid();
    relationships.add(relationKey);
    lastOrder=image.documentOrder;
    total+=image.byteSize;
    if (!Number.isSafeInteger(total)||total>MAX_DERIVED_BYTES) throw invalid();
    images.push(structuredClone(image));
  }
  const coverage=validateCoverage(value.coverage,images);
  return {
    version:1,sourceId:value.sourceId,originalSha256:value.originalSha256,
    kind:"docx",text:structuredClone(text),images,coverage
  };
}

function validateCoverage(value,images) {
  if (!exact(value,COVERAGE_FIELDS)||
      !new Set(["complete","partial"]).has(value.status)||
      !safeLimitations(value.limitations)||
      (value.status==="complete")!==(value.limitations.length===0)||
      !exact(value.parts,PARTS_FIELDS)) throw invalid();
  const parts={};
  for (const key of PARTS_FIELDS) {
    const list=value.parts[key];
    if (!Array.isArray(list)||list.length>2048||
        !sameSortedUnique(list)||list.some(item=>!safePackagePart(item))) {
      throw invalid();
    }
    parts[key]=[...list];
  }
  for (const image of images) {
    if (!parts.parsed.includes(image.ownerPartName)||
        !parts.relationships.includes(relationshipPartName(image.ownerPartName))||
        !parts.representedMedia.includes(image.targetMediaPartName)) {
      throw invalid();
    }
  }
  return {
    status:value.status,limitations:[...value.limitations],parts
  };
}

async function validateStagedEvidence({stagedFiles,index,binding,signal}) {
  if (!Array.isArray(stagedFiles)||
      stagedFiles.length!==index.images.length+1) throw invalid();
  const expected=[index.text,...index.images];
  const result=[];
  for (let position=0;position<stagedFiles.length;position+=1) {
    signal?.throwIfAborted();
    const item=stagedFiles[position];
    const descriptor=expected[position];
    if (!exact(item,new Set(["absolutePath","relativePath"]))||
        typeof item.absolutePath!=="string"||!isAbsolute(item.absolutePath)||
        item.relativePath!==descriptor.relativePath||
        !safeRelative(item.relativePath,binding.handle.sourceId)) throw invalid();
    const info=await privateStagedFile(item.absolutePath);
    if (info.size!==descriptor.byteSize||
        await sha256File(item.absolutePath)!==descriptor.sha256) throw invalid();
    result.push(Object.freeze({
      absolutePath:item.absolutePath,relativePath:item.relativePath,
      sha256:descriptor.sha256,byteSize:descriptor.byteSize
    }));
  }
  const textDocument=await validateTextDocument(
    await readFile(result[0].absolutePath),index
  );
  const documentOrders=new Set(
    textDocument.observations.map(item=>item.documentOrder)
  );
  for (let position=1;position<result.length;position+=1) {
    const dimensions=await readPngHeader(result[position].absolutePath);
    const descriptor=index.images[position-1];
    if (dimensions.width!==descriptor.width||
        dimensions.height!==descriptor.height||
        documentOrders.has(descriptor.documentOrder)) throw invalid();
    documentOrders.add(descriptor.documentOrder);
  }
  await validateImageBindings(binding.absolutePath,index);
  return result;
}

async function validateDurableEvidence({workspaceDir,binding,index,signal}) {
  const descriptors=[index.text,...index.images];
  const durableOrders=new Set();
  for (const [position,descriptor] of descriptors.entries()) {
    signal?.throwIfAborted();
    const file=join(workspaceDir,descriptor.relativePath);
    const info=await privateFile(file,workspaceDir);
    if (info.size!==descriptor.byteSize||
        await sha256File(file)!==descriptor.sha256) throw invalid();
    if (position===0) {
      const textDocument=await validateTextDocument(await readFile(file),index);
      for (const observation of textDocument.observations) {
        durableOrders.add(observation.documentOrder);
      }
    }
    else {
      const dimensions=await readPngHeader(file);
      if (dimensions.width!==descriptor.width||
          dimensions.height!==descriptor.height||
          durableOrders.has(descriptor.documentOrder)) throw invalid();
      durableOrders.add(descriptor.documentOrder);
    }
  }
  await validateImageBindings(binding.absolutePath,index);
}

async function validateTextDocument(bytes,index) {
  if (bytes.length!==index.text.byteSize) throw invalid();
  let value;
  try {
    value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
  } catch { throw invalid(); }
  if (!exact(value,TEXT_DOCUMENT_FIELDS)||value.version!==1||
      value.sourceId!==index.sourceId||
      value.originalSha256!==index.originalSha256||
      !Array.isArray(value.observations)||
      value.observations.length!==index.text.observationCount) throw invalid();
  let lastOrder=0;
  for (const observation of value.observations) {
    const hasLevel=Object.hasOwn(observation??{},"level");
    if (!exact(observation,hasLevel?OBSERVATION_LEVEL_FIELDS:OBSERVATION_BASE_FIELDS)||
        !ownerPart(observation.ownerPartName)||
        !bounded(observation.documentOrder,1,8_999_999)||
        observation.documentOrder<=lastOrder||
        !new Set(["heading","list_item","paragraph","table_cell"])
          .has(observation.type)||
        typeof observation.text!=="string"||!observation.text.trim()||
        observation.text.includes("\0")||
        Buffer.byteLength(observation.text,"utf8")>64*1024||
        (hasLevel&&(
          (observation.type==="heading"&&!bounded(observation.level,1,9))||
          (observation.type==="list_item"&&!bounded(observation.level,0,8))||
          !new Set(["heading","list_item"]).has(observation.type)
        ))) throw invalid();
    lastOrder=observation.documentOrder;
  }
  return value;
}

async function validateImageBindings(originalPath,index) {
  if (index.images.length===0) return;
  const archive=await openBoundedOoxmlPackage(originalPath,{
    expectedSha256:index.originalSha256
  });
  const maps=new Map();
  for (const image of index.images) {
    let relations=maps.get(image.ownerPartName);
    if (!relations) {
      const part=relationshipPartName(image.ownerPartName);
      if (!archive.hasEntry(part)) throw invalid();
      relations=new Map(parseOoxmlRelationships(
        archive.readEntry(part)
      ).map(value=>[value.Id,value]));
      maps.set(image.ownerPartName,relations);
    }
    const relation=relations.get(image.relationshipId);
    if (!relation||relation.TargetMode==="External"||
        !IMAGE_RELATIONSHIP_TYPES.has(relation.Type)||
        resolveOoxmlTarget(image.ownerPartName,relation.Target)!==
          image.targetMediaPartName||
        !archive.hasEntry(image.targetMediaPartName)||
        sha256Bytes(archive.readEntry(image.targetMediaPartName))!==image.sha256) {
      throw invalid();
    }
  }
}

async function buildResult({workspaceDir,index,indexSha256,producedBy}) {
  const text=JSON.parse(await readBounded(
    join(workspaceDir,index.text.relativePath),MAX_TEXT_BYTES
  ));
  const modelLimitations=boundedModelLimitations(index.coverage.limitations);
  const content=JSON.stringify({
    kind:"docx",coverageStatus:index.coverage.status,
    limitations:modelLimitations,observations:text.observations
  });
  if (Buffer.byteLength(content,"utf8")>MAX_TEXT_BYTES) throw invalid();
  return Object.freeze({
    representationIndexPath:`${index.sourceId}.docx-index.json`,
    observations:Object.freeze([Object.freeze({
      sourceId:index.sourceId,view:"read_docx",
      derivedRelativePath:index.text.relativePath,
      sha256:index.text.sha256,producedBy,content,
      limitations:Object.freeze(modelLimitations)
    })]),
    modelImageFiles:Object.freeze(index.images.map(image=>Object.freeze({
      sourceId:index.sourceId,relativePath:image.relativePath,
      sha256:image.sha256,documentOrder:image.documentOrder,
      ownerPartName:image.ownerPartName,relationshipId:image.relationshipId,
      targetMediaPartName:image.targetMediaPartName
    }))),
    coverage:Object.freeze({
      sourceId:index.sourceId,originalSha256:index.originalSha256,
      indexRelativePath:`${index.sourceId}.docx-index.json`,
      indexSha256,status:index.coverage.status,
      limitations:Object.freeze([...index.coverage.limitations])
    })
  });
}

function validSidecar({
  sidecar,binding,indexRelativePath,indexSha256,index
}) {
  if (!exact(sidecar,new Set([
    "version","original","derived","createdAt","updatedAt"
  ]))||sidecar.version!==1||!exact(sidecar.original,new Set([
    "sourceId","relativePath","byteSize","sha256","mime"
  ]))||sidecar.original.sourceId!==binding.handle.sourceId||
      sidecar.original.relativePath!==binding.handle.relativePath||
      sidecar.original.byteSize!==binding.handle.byteSize||
      sidecar.original.sha256!==binding.handle.sha256||
      sidecar.original.mime!==DOCX_MIME||
      !Array.isArray(sidecar.derived)||sidecar.derived.length!==1||
      !canonicalIso(sidecar.createdAt)||!canonicalIso(sidecar.updatedAt)||
      Date.parse(sidecar.updatedAt)<Date.parse(sidecar.createdAt)) return false;
  const derived=sidecar.derived[0];
  return exact(derived,new Set([
    "kind","relativePath","sha256","producedBy","createdAt","limitations"
  ]))&&derived.kind==="navigation"&&
    derived.relativePath===indexRelativePath&&derived.sha256===indexSha256&&
    derived.producedBy===DOCX_PRODUCER&&canonicalIso(derived.createdAt)&&
    safeLimitations(derived.limitations)&&
    JSON.stringify(derived.limitations)===JSON.stringify(
      boundedModelLimitations(index.coverage.limitations)
    );
}

async function assertExactDurableSet(workspaceDir,index) {
  const prefix=`${index.sourceId}.docx-`;
  const actual=(await readdir(workspaceDir)).filter(name=>name.startsWith(prefix))
    .sort();
  const expected=[
    index.text.relativePath,...index.images.map(image=>image.relativePath),
    `${index.sourceId}.docx-index.json`
  ].sort();
  if (JSON.stringify(actual)!==JSON.stringify(expected)) throw invalid();
}

async function privateWorkspace(value) {
  const info=await lstat(value);
  if (!info.isDirectory()||info.isSymbolicLink()||
      info.uid!==process.getuid()||(info.mode&0o077)!==0) throw invalid();
  return realpath(value);
}

async function privateFile(file,workspaceDir) {
  const info=await lstat(file);
  const actual=await realpath(file);
  const fromWorkspace=relative(workspaceDir,actual);
  if (!info.isFile()||info.isSymbolicLink()||
      info.uid!==process.getuid()||(info.mode&0o077)!==0||
      fromWorkspace.startsWith("..")||isAbsolute(fromWorkspace)||
      resolve(workspaceDir,fromWorkspace)!==actual) throw invalid();
  return info;
}

async function privateStagedFile(file) {
  const info=await lstat(file);
  if (!info.isFile()||info.isSymbolicLink()||
      info.uid!==process.getuid()||(info.mode&0o077)!==0) throw invalid();
  await realpath(file);
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
        header.toString("ascii",12,16)!=="IHDR") throw invalid();
    const width=header.readUInt32BE(16);
    const height=header.readUInt32BE(20);
    if (!width||!height) throw invalid();
    return {width,height};
  } finally { await handle.close(); }
}

async function verifyFile(file,expected) {
  const info=await lstat(file);
  if (!info.isFile()||info.isSymbolicLink()||
      info.uid!==process.getuid()||(info.mode&0o077)!==0||
      info.size!==expected.byteSize||await sha256File(file)!==expected.sha256) {
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
  } finally { await handle.close(); }
  await rename(temporary,file);
  temporaryPaths.splice(temporaryPaths.indexOf(temporary),1);
  await chmod(file,0o600);
}

async function syncFile(file) {
  const handle=await open(file,"r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function readBounded(file,maxBytes) {
  const info=await lstat(file);
  if (info.size<2||info.size>maxBytes) throw invalid();
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
  try { await lstat(file); return true; }
  catch (error) {
    if (error?.code==="ENOENT") return false;
    throw error;
  }
}

function safeRelative(value,sourceId) {
  return typeof value==="string"&&!isAbsolute(value)&&
    /^[A-Za-z0-9._-]+$/u.test(value)&&!value.includes("..")&&
    !value.includes("\\")&&!value.includes("\0")&&
    value.startsWith(`${sourceId}.`);
}

function safePackagePart(value) {
  return typeof value==="string"&&value.length>0&&value.length<=512&&
    !value.startsWith("/")&&!value.includes("\\")&&!value.includes("\0")&&
    value.split("/").every(part=>part&&part!=="."&&part!=="..");
}

function ownerPart(value) {
  return typeof value==="string"&&
    /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/u
      .test(value);
}

function relationshipPartName(ownerPartName) {
  const slash=ownerPartName.lastIndexOf("/");
  return `${ownerPartName.slice(0,slash)}/_rels/`+
    `${ownerPartName.slice(slash+1)}.rels`;
}

function safeLimitations(value) {
  return Array.isArray(value)&&value.length<=32&&sameSortedUnique(value)&&
    value.every(item=>typeof item==="string"&&
      /^[a-z0-9_]{1,64}$/u.test(item));
}

function boundedModelLimitations(value) {
  return value.length<=8
    ?[...value]
    :[...value.slice(0,7),"additional_limitations"].sort();
}

function sameSortedUnique(value) {
  return new Set(value).size===value.length&&
    JSON.stringify(value)===JSON.stringify([...value].sort());
}

function bounded(value,min,max) {
  return Number.isSafeInteger(value)&&value>=min&&value<=max;
}

function exact(value,fields) {
  return plain(value)&&Object.keys(value).length===fields.size&&
    Object.keys(value).every(key=>fields.has(key));
}

function exactKeys(value,required,optional) {
  if (!plain(value)) return false;
  const keys=new Set(Object.keys(value));
  return [...required].every(key=>keys.has(key))&&
    [...keys].every(key=>required.has(key)||optional.has(key));
}

function plain(value) {
  return value&&typeof value==="object"&&!Array.isArray(value)&&
    Object.getPrototypeOf(value)===Object.prototype;
}

function canonicalIso(value) {
  return typeof value==="string"&&Number.isFinite(Date.parse(value))&&
    new Date(value).toISOString()===value;
}

function invalid() {
  return new Error("task_docx_evidence_invalid");
}
