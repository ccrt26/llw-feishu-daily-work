import {createHash,randomUUID} from "node:crypto";
import {
  chmod,copyFile,lstat,mkdir,mkdtemp,open,readFile,readdir,realpath,rename,rm
} from "node:fs/promises";
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from "node:path";

const TEXT_SOURCE_FIELDS=new Set([
  "version","sourceKind","detectedFormat","displayName","sizeBytes","sha256",
  "jobSourceName","safeSourceReference","extractionIntegrity",
  "extractionLimitations","content"
]);
const OFFICE_SOURCE_FIELDS=new Set([...TEXT_SOURCE_FIELDS,"sourceBytes"]);
const VISUAL_SOURCE_FIELDS=new Set([...OFFICE_SOURCE_FIELDS,"structure"]);
const OFFICE_FORMATS=new Set(["docx","pptx","xlsx"]);
const VISUAL_FORMATS=new Set(["pdf","image"]);
const BINARY_FORMATS=new Set([...OFFICE_FORMATS,...VISUAL_FORMATS]);
const OWNER_ONLY_FILE_MODES=new Set([0o600,0o700]);
const RESERVED=/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu;
const MAX_SCAN_DIRECTORIES=4096;

export class KnowledgeWriter {
  constructor({vaultRoot,libraries}) {
    this.vaultRoot=vaultRoot;
    this.libraries=structuredClone(libraries);
  }

  async createFolder({libraryKey,segments}) {
    try {
      const context=await this.#openContext(libraryKey);
      validateSegments(segments);
      const result=await ensureSegments(context.libraryReal,segments);
      return {
        status:result.created?"created":"existing",
        libraryKey,
        relativePath:portable(relative(context.vaultReal,result.path))
      };
    } catch {
      throw new Error("knowledge_write_rejected");
    }
  }

  async commit(input) {
    if (Array.isArray(input?.sources)) {
      return this.#commitSourceSet(input);
    }
    let stage="",lock;
    try {
      validateCommitInput(input);
      const context=await this.#openContext(input.libraryKey);
      validateSource(input.source);
      const knowledgeId=knowledgeIdentifier(input.libraryKey,input.source.sha256);
      const category=await ensureSegments(context.libraryReal,input.folderSegments);
      lock=await acquireLibraryLock(context.libraryReal);
      const existing=await findExisting(context.libraryReal,knowledgeId);
      const preserveSource=sourceHasFile(input.source);
      if (existing) {
        const verified=await verifyItem(existing.path,{
          knowledgeId,source:input.source,preserveSource
        });
        return resultFor("existing",context,input.libraryKey,knowledgeId,existing.path,verified.files);
      }
      const title=normalizeTitle(input.title);
      const target=await chooseTarget(category.path,title,input.source.sha256,knowledgeId);
      stage=await mkdtemp(join(category.path,`.llw-knowledge-stage-${randomUUID()}-`));
      await chmod(stage,0o700);
      const markdown=renderKnowledgeMarkdown({...input,knowledgeId});
      await writeSynced(join(stage,"knowledge.md"),markdown);
      if (preserveSource) {
        await writeSynced(
          join(stage,input.source.jobSourceName),
          input.source.sourceBytes||input.source.content
        );
      }
      await syncDirectory(stage);
      await verifyItem(stage,{knowledgeId,expectedMarkdown:markdown,source:input.source,
        preserveSource});
      await assertMissing(target);
      await rename(stage,target);
      stage="";
      await syncDirectory(category.path);
      const verified=await verifyItem(target,{knowledgeId,expectedMarkdown:markdown,
        source:input.source,preserveSource});
      return resultFor("created",context,input.libraryKey,knowledgeId,target,verified.files);
    } catch {
      throw new Error("knowledge_write_rejected");
    } finally {
      if (stage) await rm(stage,{recursive:true,force:true}).catch(()=>{});
      if (lock) await releaseLibraryLock(lock);
    }
  }

  async #commitSourceSet(input) {
    let stage="",lock;
    try {
      validateSourceSetCommitInput(input);
      const context=await this.#openContext(input.libraryKey);
      const sources=await verifySourceInputs(
        input.sources,input.sourceSetDigest
      );
      const knowledgeId=knowledgeIdentifier(
        input.libraryKey,input.sourceSetDigest
      );
      const category=await ensureSegments(
        context.libraryReal,input.folderSegments
      );
      lock=await acquireLibraryLock(context.libraryReal);
      const existing=await findExisting(context.libraryReal,knowledgeId);
      if (existing) {
        const verified=await verifySourceSetItem(existing.path,{
          knowledgeId,sources
        });
        return resultFor(
          "existing",context,input.libraryKey,knowledgeId,
          existing.path,verified.files
        );
      }
      const title=normalizeTitle(input.title);
      const target=await chooseTarget(
        category.path,title,input.sourceSetDigest,knowledgeId
      );
      stage=await mkdtemp(join(
        category.path,`.llw-knowledge-stage-${randomUUID()}-`
      ));
      await chmod(stage,0o700);
      const markdown=renderSourceSetMarkdown({...input,knowledgeId});
      await writeSynced(join(stage,"knowledge.md"),markdown);
      for (const source of sources) {
        await verifyOneSourceInput(source);
        const destination=join(stage,`${source.sourceId}.${source.format}`);
        await copyFile(source.absolutePath,destination);
        await chmod(destination,0o600);
        await syncFile(destination);
      }
      await syncDirectory(stage);
      await verifySourceSetItem(stage,{
        knowledgeId,expectedMarkdown:markdown,sources
      });
      await assertMissing(target);
      await rename(stage,target);
      stage="";
      await syncDirectory(category.path);
      const verified=await verifySourceSetItem(target,{
        knowledgeId,expectedMarkdown:markdown,sources
      });
      return resultFor(
        "created",context,input.libraryKey,knowledgeId,
        target,verified.files
      );
    } catch {
      throw new Error("knowledge_write_rejected");
    } finally {
      if (stage) await rm(stage,{recursive:true,force:true}).catch(()=>{});
      if (lock) await releaseLibraryLock(lock);
    }
  }

  async #openContext(selectedKey) {
    if (!isAbsolute(this.vaultRoot)||!Array.isArray(this.libraries)||
        this.libraries.length<1||this.libraries.length>16) {
      throw new Error("invalid_configuration");
    }
    const vaultConfigured=resolve(this.vaultRoot);
    await assertOwnedDirectory(vaultConfigured);
    const vaultReal=await realpath(vaultConfigured);
    await assertOwnedDirectory(join(vaultReal,".obsidian"));
    await assertOwnedRegularFile(join(vaultReal,".llw-system","SYSTEM_MAP.md"));
    const seen=new Set(),configured=[];
    for (const library of this.libraries) {
      if (!library||typeof library!=="object"||
          !/^[a-z][a-z0-9_-]{0,63}$/u.test(library.libraryKey)||
          seen.has(library.libraryKey)||!isAbsolute(library.root)) {
        throw new Error("invalid_library");
      }
      seen.add(library.libraryKey);
      const root=resolve(library.root);
      if (root===vaultConfigured||!inside(vaultConfigured,root)) {
        throw new Error("invalid_library");
      }
      const relativeRoot=relative(vaultConfigured,root);
      configured.push({
        libraryKey:library.libraryKey,
        root,
        expectedReal:resolve(vaultReal,relativeRoot)
      });
    }
    for (let left=0;left<configured.length;left+=1) {
      for (let right=left+1;right<configured.length;right+=1) {
        if (inside(configured[left].root,configured[right].root)||
            inside(configured[right].root,configured[left].root)) {
          throw new Error("nested_library");
        }
      }
    }
    const selected=configured.find(item=>item.libraryKey===selectedKey);
    if (!selected) throw new Error("unknown_library");
    for (const library of configured) {
      await assertOwnedDirectory(library.root);
      const libraryReal=await realpath(library.root);
      if (libraryReal!==library.expectedReal) throw new Error("library_mismatch");
      library.libraryReal=libraryReal;
    }
    return {vaultReal,libraryReal:selected.libraryReal};
  }
}

export function knowledgeIdentifier(libraryKey,sourceSha256) {
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(libraryKey||"")||
      !/^[a-f0-9]{64}$/u.test(sourceSha256||"")) {
    throw new Error("invalid_knowledge_identifier");
  }
  return createHash("sha256").update(`${libraryKey}\0${sourceSha256}`,"utf8").digest("hex");
}

function validateCommitInput(input) {
  const fields=new Set([
    "libraryKey","folderSegments","title","summary","tags","knowledgeSections",
    "source","skillVersion","ingestedAt"
  ]);
  if (!input||typeof input!=="object"||Array.isArray(input)||
      Object.getPrototypeOf(input)!==Object.prototype||
      Object.keys(input).length!==fields.size||
      Object.keys(input).some(field=>!fields.has(field))||
      typeof input.libraryKey!=="string"||!Array.isArray(input.folderSegments)||
      typeof input.title!=="string"||!input.title.trim()||[...input.title].length>160||
      input.title.includes("\0")||typeof input.summary!=="string"||
      !input.summary.trim()||[...input.summary].length>4000||input.summary.includes("\0")||
      !Array.isArray(input.tags)||input.tags.length>20||
      new Set(input.tags).size!==input.tags.length||
      input.tags.some(tag=>typeof tag!=="string"||!tag||[...tag].length>64||tag.includes("\0"))||
      !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/iu.test(input.skillVersion||"")||
      typeof input.ingestedAt!=="string"||
      !Number.isFinite(Date.parse(input.ingestedAt))||
      new Date(input.ingestedAt).toISOString()!==input.ingestedAt) {
    throw new Error("invalid_commit");
  }
  validateKnowledgeSections(input.knowledgeSections);
  validateSegments(input.folderSegments,{allowRoot:true});
}

function validateSourceSetCommitInput(input) {
  const fields=new Set([
    "libraryKey","folderSegments","title","summary","tags",
    "knowledgeSections","sources","sourceSetDigest","skillVersion",
    "ingestedAt"
  ]);
  if (!input||typeof input!=="object"||Array.isArray(input)||
      Object.getPrototypeOf(input)!==Object.prototype||
      Object.keys(input).length!==fields.size||
      Object.keys(input).some(field=>!fields.has(field))||
      typeof input.libraryKey!=="string"||
      !Array.isArray(input.folderSegments)||
      typeof input.title!=="string"||!input.title.trim()||
      [...input.title].length>160||input.title.includes("\0")||
      typeof input.summary!=="string"||!input.summary.trim()||
      [...input.summary].length>4000||input.summary.includes("\0")||
      !Array.isArray(input.tags)||input.tags.length>20||
      new Set(input.tags).size!==input.tags.length||
      input.tags.some(tag=>typeof tag!=="string"||!tag||
        [...tag].length>64||tag.includes("\0"))||
      !Array.isArray(input.sources)||input.sources.length>8||
      !/^[a-f0-9]{64}$/u.test(input.sourceSetDigest||"")||
      !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/iu.test(
        input.skillVersion||""
      )||
      typeof input.ingestedAt!=="string"||
      !Number.isFinite(Date.parse(input.ingestedAt))||
      new Date(input.ingestedAt).toISOString()!==input.ingestedAt) {
    throw new Error("invalid_commit");
  }
  validateKnowledgeSections(input.knowledgeSections);
  validateSegments(input.folderSegments,{allowRoot:true});
}

async function verifySourceInputs(sources,sourceSetDigest) {
  const verified=[],ids=new Set();
  let workspaceReal=null,total=0;
  for (const source of sources) {
    validateSourceInputShape(source);
    if (ids.has(source.sourceId)) throw new Error("duplicate_source");
    ids.add(source.sourceId);
    const current=await verifyOneSourceInput(source);
    if (workspaceReal===null) workspaceReal=current.workspaceReal;
    else if (workspaceReal!==current.workspaceReal) {
      throw new Error("mixed_workspace");
    }
    total+=source.byteSize;
    if (total>80*1024*1024) throw new Error("source_set_too_large");
    verified.push({...source});
  }
  const expected=sources.length
    ?createHash("sha256").update(
      sources.map(source=>
        `${source.sourceId}\0${source.sha256}`
      ).join("\0")
    ).digest("hex")
    :sourceSetDigest;
  if (expected!==sourceSetDigest) throw new Error("source_digest_invalid");
  return verified;
}

function validateSourceInputShape(source) {
  const fields=new Set([
    "sourceId","displayName","format","absolutePath","byteSize","sha256"
  ]);
  if (!source||typeof source!=="object"||Array.isArray(source)||
      Object.getPrototypeOf(source)!==Object.prototype||
      Object.keys(source).length!==fields.size||
      Object.keys(source).some(field=>!fields.has(field))||
      !/^source-00[1-8]$/u.test(source.sourceId)||
      typeof source.displayName!=="string"||!source.displayName||
      [...source.displayName].length>255||
      /[\\/\u0000-\u001f\u007f]/u.test(source.displayName)||
      !new Set([
        "txt","md","docx","pptx","xlsx","pdf",
        "png","jpg","jpeg","webp"
      ]).has(source.format)||
      !isAbsolute(source.absolutePath)||
      basename(source.absolutePath)!==
        `${source.sourceId}.${source.format}`||
      !Number.isSafeInteger(source.byteSize)||source.byteSize<1||
      source.byteSize>20*1024*1024||
      !/^[a-f0-9]{64}$/u.test(source.sha256)) {
    throw new Error("invalid_source");
  }
}

async function verifyOneSourceInput(source) {
  validateSourceInputShape(source);
  const info=await lstat(source.absolutePath);
  if (!info.isFile()||info.isSymbolicLink()||
      info.uid!==process.getuid()||info.size!==source.byteSize||
      (info.mode&0o077)!==0) {
    throw new Error("invalid_source");
  }
  const workspace=dirname(source.absolutePath);
  const workspaceInfo=await lstat(workspace);
  const workspaceReal=await realpath(workspace);
  if (!workspaceInfo.isDirectory()||workspaceInfo.isSymbolicLink()||
      workspaceInfo.uid!==process.getuid()||
      (workspaceInfo.mode&0o077)!==0||
      !/^llw-turn-[A-Za-z0-9_-]+$/u.test(basename(workspaceReal))||
      dirname(await realpath(source.absolutePath))!==workspaceReal) {
    throw new Error("invalid_workspace");
  }
  const bytes=await readFile(source.absolutePath);
  if (bytes.length!==source.byteSize||
      createHash("sha256").update(bytes).digest("hex")!==source.sha256) {
    throw new Error("source_changed");
  }
  return {workspaceReal};
}

function validateKnowledgeSections(value) {
  const fields=new Set([
    "keyFacts","structureAndMainContent","reusableContent","sourceNotes",
    "contentIndex"
  ]);
  if (!value||typeof value!=="object"||Array.isArray(value)||
      Object.getPrototypeOf(value)!==Object.prototype||
      Object.keys(value).length!==fields.size||
      Object.keys(value).some(field=>!fields.has(field))||
      !validTextList(value.keyFacts,{min:1,max:50,length:1000})||
      !validText(value.structureAndMainContent,16000)||
      !validTextList(value.reusableContent,{min:0,max:50,length:1000})||
      !validText(value.sourceNotes,4000)||
      !validText(value.contentIndex,16000)) {
    throw new Error("invalid_sections");
  }
}

function validTextList(value,{min,max,length}) {
  return Array.isArray(value)&&value.length>=min&&value.length<=max&&
    new Set(value).size===value.length&&
    value.every(item=>validText(item,length));
}

function validText(value,max) {
  return typeof value==="string"&&value===value.trim()&&value.length>0&&
    [...value].length<=max&&!value.includes("\0");
}

function validateSource(source) {
  const fields=VISUAL_FORMATS.has(source?.detectedFormat)
    ?VISUAL_SOURCE_FIELDS
    :OFFICE_FORMATS.has(source?.detectedFormat)
      ?OFFICE_SOURCE_FIELDS
      :TEXT_SOURCE_FIELDS;
  if (!source||typeof source!=="object"||Array.isArray(source)||
      Object.keys(source).length!==fields.size||
      Object.keys(source).some(field=>!fields.has(field))||
      source.version!==1||
      !new Set(["text","file","feishu_document"]).has(source.sourceKind)||
      !new Set(["text","txt","md","docx","pptx","xlsx","pdf","image"]).has(source.detectedFormat)||
      typeof source.displayName!=="string"||!source.displayName||
      [...source.displayName].length>255||/[\\/\u0000-\u001f\u007f]/u.test(source.displayName)||
      !Number.isSafeInteger(source.sizeBytes)||source.sizeBytes<1||
      !/^[a-f0-9]{64}$/u.test(source.sha256)||
      !/^source\.(?:txt|md|docx|pptx|xlsx|pdf|jpg|jpeg|png|webp)$/u
        .test(source.jobSourceName)||
      !validSourceReference(source.sourceKind,source.safeSourceReference)||
      source.extractionIntegrity!=="complete"||
      !Array.isArray(source.extractionLimitations)||
      source.extractionLimitations.length!==0||
      typeof source.content!=="string"||
      !source.content.trim()||source.content.includes("\0")) {
    throw new Error("invalid_source");
  }
  if (source.sourceKind==="text"&&
      (source.detectedFormat!=="text"||source.jobSourceName!=="source.txt")) {
    throw new Error("invalid_source");
  }
  if (source.sourceKind==="file"&&
      !sameFileFormat(source.detectedFormat,source.jobSourceName)) {
    throw new Error("invalid_source");
  }
  const contentBytes=Buffer.byteLength(source.content,"utf8");
  if (contentBytes>262_144) throw new Error("invalid_source");
  if (BINARY_FORMATS.has(source.detectedFormat)) {
    if (!new Set(["file","feishu_document"]).has(source.sourceKind)||
        !Buffer.isBuffer(source.sourceBytes)||
        source.sourceBytes.length!==source.sizeBytes||
        source.sourceBytes.length>20*1024*1024||
        createHash("sha256").update(source.sourceBytes).digest("hex")!==source.sha256||
        (VISUAL_FORMATS.has(source.detectedFormat)&&
          (!Array.isArray(source.structure)||source.structure.length>1000))) {
      throw new Error("invalid_source");
    }
  } else {
    const digest=createHash("sha256").update(source.content,"utf8").digest("hex");
    if (contentBytes!==source.sizeBytes||digest!==source.sha256) {
      throw new Error("invalid_source");
    }
  }
}

function sameFileFormat(format,name) {
  if (new Set(["txt","md","docx","pptx","xlsx","pdf"]).has(format)) {
    return name===`source.${format}`;
  }
  return format==="image"&&
    /^source\.(?:jpg|jpeg|png|webp)$/u.test(name);
}

function validSourceReference(kind,value) {
  if (kind==="feishu_document") return /^feishu:[a-f0-9]{64}$/u.test(value||"");
  return value==="";
}

function validateSegments(segments,{allowRoot=false}={}) {
  if (!Array.isArray(segments)||(!allowRoot&&segments.length<1)||segments.length>5||
      segments.some(segment=>!validSegment(segment))) {
    throw new Error("invalid_segments");
  }
}

function validSegment(value) {
  return typeof value==="string"&&value===value.trim()&&value===value.normalize("NFC")&&
    [...value].length>=1&&[...value].length<=64&&value!=="."&&value!==".."&&
    !value.startsWith(".")&&!RESERVED.test(value)&&
    !/[\\/\u0000-\u001f\u007f]/u.test(value);
}

async function ensureSegments(root,segments) {
  let current=root,created=false;
  for (const segment of segments) {
    const next=resolve(current,segment);
    if (!inside(root,next)) throw new Error("path_escape");
    try {
      await assertOwnedDirectory(next);
    } catch (error) {
      if (error?.code!=="ENOENT") throw error;
      try {
        await mkdir(next,{mode:0o700});
        created=true;
      } catch (mkdirError) {
        if (mkdirError?.code!=="EEXIST") throw mkdirError;
      }
      await chmod(next,0o700);
      await assertOwnedDirectory(next);
    }
    if (await realpath(next)!==next) throw new Error("path_mismatch");
    current=next;
  }
  return {path:current,created};
}

async function chooseTarget(parent,title,sourceSha256,knowledgeId) {
  const candidates=[
    title,
    `${title}--${sourceSha256.slice(0,8)}`,
    `${title}--${knowledgeId.slice(0,12)}`
  ];
  for (const name of candidates) {
    const target=resolve(parent,name);
    if (!inside(parent,target)) throw new Error("path_escape");
    try {
      const metadata=await lstat(target);
      if (metadata.isSymbolicLink()) throw new Error("unsafe_target");
    } catch (error) {
      if (error?.code==="ENOENT") return target;
      throw error;
    }
  }
  throw new Error("title_collision");
}

function normalizeTitle(value) {
  let normalized=value.normalize("NFC").trim()
    .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]+/gu,"-")
    .replace(/\s+/gu," ")
    .replace(/-+/gu,"-")
    .replace(/^[.\s-]+|[.\s-]+$/gu,"");
  if (!normalized) normalized="知识项";
  if (RESERVED.test(normalized)||normalized.startsWith(".")) normalized=`${normalized}-知识`;
  return [...normalized].slice(0,80).join("");
}

function renderKnowledgeMarkdown({
  libraryKey,title,summary,tags,knowledgeSections,source,skillVersion,
  ingestedAt,knowledgeId
}) {
  const preserveSource=sourceHasFile(source);
  const tagLines=tags.length
    ? tags.map(tag=>`  - ${JSON.stringify(tag)}`).join("\n")
    : "  []";
  const sourceReference=source.safeSourceReference
    ?[`safe_source_reference: ${JSON.stringify(source.safeSourceReference)}`]
    :[];
  return [
    "---",
    'llw_schema: "knowledge-item/v1"',
    `knowledge_id: ${JSON.stringify(knowledgeId)}`,
    `library_key: ${JSON.stringify(libraryKey)}`,
    `title: ${JSON.stringify(title.normalize("NFC").trim())}`,
    "tags:",
    tagLines,
    `source_kind: ${JSON.stringify(source.sourceKind)}`,
    `source_format: ${JSON.stringify(source.detectedFormat)}`,
    `source_display_name: ${JSON.stringify(source.displayName)}`,
    `source_sha256: ${JSON.stringify(source.sha256)}`,
    `source_size_bytes: ${source.sizeBytes}`,
    `source_extraction_integrity: ${JSON.stringify(source.extractionIntegrity)}`,
    `source_ingested_at: ${JSON.stringify(ingestedAt)}`,
    `source_preserved: ${preserveSource}`,
    ...sourceReference,
    `skill_version: ${JSON.stringify(skillVersion)}`,
    "---",
    "",
    `# ${title.normalize("NFC").trim()}`,
    "",
    "## 摘要",
    "",
    summary.normalize("NFC").trim(),
    "",
    "## 关键事实",
    "",
    renderList(knowledgeSections.keyFacts),
    "",
    "## 结构与主要内容",
    "",
    knowledgeSections.structureAndMainContent,
    "",
    "## 可复用内容",
    "",
    renderList(knowledgeSections.reusableContent),
    "",
    "## 来源说明",
    "",
    knowledgeSections.sourceNotes,
    "",
    "## 结构化原文或内容索引",
    "",
    knowledgeSections.contentIndex,
    "",
    "### 本地读取器提取内容",
    "",
    source.content,
    ""
  ].join("\n");
}

function renderSourceSetMarkdown({
  libraryKey,title,summary,tags,knowledgeSections,sources,sourceSetDigest,
  skillVersion,ingestedAt,knowledgeId
}) {
  const tagLines=tags.length
    ?tags.map(tag=>`  - ${JSON.stringify(tag)}`).join("\n")
    :"  []";
  const sourceLines=sources.length
    ?sources.flatMap(source=>[
      `  - source_id: ${JSON.stringify(source.sourceId)}`,
      `    display_name: ${JSON.stringify(source.displayName)}`,
      `    format: ${JSON.stringify(source.format)}`,
      `    file: ${JSON.stringify(`${source.sourceId}.${source.format}`)}`,
      `    sha256: ${JSON.stringify(source.sha256)}`,
      `    size_bytes: ${source.byteSize}`
    ])
    :["  []"];
  return [
    "---",
    'llw_schema: "knowledge-item/v2"',
    `knowledge_id: ${JSON.stringify(knowledgeId)}`,
    `library_key: ${JSON.stringify(libraryKey)}`,
    `title: ${JSON.stringify(title.normalize("NFC").trim())}`,
    "tags:",
    tagLines,
    `source_set_digest: ${JSON.stringify(sourceSetDigest)}`,
    `source_ingested_at: ${JSON.stringify(ingestedAt)}`,
    `skill_version: ${JSON.stringify(skillVersion)}`,
    "sources:",
    ...sourceLines,
    "---",
    "",
    `# ${title.normalize("NFC").trim()}`,
    "",
    "## 摘要",
    "",
    summary.normalize("NFC").trim(),
    "",
    "## 关键事实",
    "",
    renderList(knowledgeSections.keyFacts),
    "",
    "## 结构与主要内容",
    "",
    knowledgeSections.structureAndMainContent,
    "",
    "## 可复用内容",
    "",
    renderList(knowledgeSections.reusableContent),
    "",
    "## 来源说明",
    "",
    knowledgeSections.sourceNotes,
    "",
    "## 结构化原文或内容索引",
    "",
    knowledgeSections.contentIndex,
    "",
    "## 原始来源索引",
    "",
    sources.length
      ?sources.map(source=>
        `- ${source.sourceId}: ${source.displayName}（${source.format}）`
      ).join("\n")
      :"- 本知识项来自本轮明确文字，没有附件原件。",
    ""
  ].join("\n");
}

function renderList(items) {
  if (!items.length) return "- （无）";
  return items.map(item=>`- ${item.replace(/\n/gu,"\n  ")}`).join("\n");
}

async function findExisting(root,knowledgeId) {
  const queue=[root];
  let visited=0;
  while (queue.length) {
    const directory=queue.shift();
    if (++visited>MAX_SCAN_DIRECTORIES) throw new Error("scan_limit");
    const entries=await readdir(directory,{withFileTypes:true});
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path=join(directory,entry.name);
      const metadata=await lstat(path);
      if (metadata.isSymbolicLink()) throw new Error("unsafe_scan");
      if (metadata.isDirectory()) queue.push(path);
      else if (metadata.isFile()&&entry.name==="knowledge.md") {
        if (metadata.size>512*1024) throw new Error("unsafe_item");
        const content=await readFile(path,"utf8");
        if (content.includes(`knowledge_id: "${knowledgeId}"`)) {
          return {path:directory};
        }
      }
    }
  }
  return null;
}

async function verifyItem(path,{knowledgeId,expectedMarkdown,source,preserveSource}={}) {
  const directory=await lstat(path);
  if (!directory.isDirectory()||directory.isSymbolicLink()||
      directory.uid!==process.getuid()||(directory.mode&0o777)!==0o700) {
    throw new Error("invalid_item");
  }
  const expected=["knowledge.md"];
  if (sourceHasFile(source)&&preserveSource) expected.push(source.jobSourceName);
  const logicalFiles=new Set(expected);
  const appleDoubleFiles=new Set(expected.map(name=>`._${name}`));
  const entries=(await readdir(path)).sort();
  if (expected.some(name=>!entries.includes(name))||
      entries.some(name=>!logicalFiles.has(name)&&!appleDoubleFiles.has(name))) {
    throw new Error("invalid_item_files");
  }
  for (const name of entries) {
    const metadata=await lstat(join(path,name));
    const mode=metadata.mode&0o777;
    if (!metadata.isFile()||metadata.isSymbolicLink()||
        metadata.uid!==process.getuid()||
        !OWNER_ONLY_FILE_MODES.has(mode)) {
      throw new Error("invalid_item_file");
    }
    if (appleDoubleFiles.has(name)) {
      await verifyAppleDouble(join(path,name),metadata);
    }
  }
  const markdown=await readFile(join(path,"knowledge.md"),"utf8");
  if (!markdown.includes(`knowledge_id: "${knowledgeId}"`)||
      (expectedMarkdown!==undefined&&markdown!==expectedMarkdown)) {
    throw new Error("invalid_item_content");
  }
  if (sourceHasFile(source)&&preserveSource) {
    const raw=await readFile(join(path,source.jobSourceName));
    if (createHash("sha256").update(raw).digest("hex")!==source.sha256) {
      throw new Error("invalid_source_copy");
    }
  }
  return {files:expected.sort()};
}

async function verifySourceSetItem(path,{
  knowledgeId,expectedMarkdown,sources
}) {
  const directory=await lstat(path);
  if (!directory.isDirectory()||directory.isSymbolicLink()||
      directory.uid!==process.getuid()||(directory.mode&0o777)!==0o700) {
    throw new Error("invalid_item");
  }
  const expected=[
    "knowledge.md",
    ...sources.map(source=>`${source.sourceId}.${source.format}`)
  ].sort();
  const logicalFiles=new Set(expected);
  const appleDoubleFiles=new Set(expected.map(name=>`._${name}`));
  const entries=(await readdir(path)).sort();
  if (expected.some(name=>!entries.includes(name))||
      entries.some(name=>
        !logicalFiles.has(name)&&!appleDoubleFiles.has(name)
      )) {
    throw new Error("invalid_item_files");
  }
  for (const name of entries) {
    const metadata=await lstat(join(path,name));
    if (!metadata.isFile()||metadata.isSymbolicLink()||
        metadata.uid!==process.getuid()||
        !OWNER_ONLY_FILE_MODES.has(metadata.mode&0o777)) {
      throw new Error("invalid_item_file");
    }
    if (appleDoubleFiles.has(name)) {
      await verifyAppleDouble(join(path,name),metadata);
    }
  }
  const markdown=await readFile(join(path,"knowledge.md"),"utf8");
  if (!markdown.includes(`knowledge_id: "${knowledgeId}"`)||
      (expectedMarkdown!==undefined&&markdown!==expectedMarkdown)) {
    throw new Error("invalid_item_content");
  }
  for (const source of sources) {
    const file=join(path,`${source.sourceId}.${source.format}`);
    const bytes=await readFile(file);
    if (bytes.length!==source.byteSize||
        createHash("sha256").update(bytes).digest("hex")!==source.sha256) {
      throw new Error("invalid_source_copy");
    }
  }
  return {files:expected};
}

async function verifyAppleDouble(path,metadata) {
  if (metadata.size<4||metadata.size>64*1024) {
    throw new Error("invalid_appledouble");
  }
  const content=await readFile(path);
  if (content.length!==metadata.size||
      !content.subarray(0,4).equals(Buffer.from([0x00,0x05,0x16,0x07]))) {
    throw new Error("invalid_appledouble");
  }
}

async function writeSynced(path,content) {
  const handle=await open(path,"wx",0o600);
  try {
    await handle.writeFile(content,typeof content==="string"?"utf8":undefined);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path,0o600);
}

async function syncFile(path) {
  const handle=await open(path,"r+");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(path) {
  const handle=await open(path,"r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function acquireLibraryLock(root) {
  const path=join(root,".llw-knowledge-publish.lock");
  for (let attempt=0;attempt<200;attempt+=1) {
    try {
      const handle=await open(path,"wx",0o600);
      await handle.writeFile(String(process.pid),"utf8");
      await handle.sync();
      return {path,handle};
    } catch (error) {
      if (error?.code!=="EEXIST") throw error;
      await delay(10);
    }
  }
  throw new Error("publish_lock_timeout");
}

async function releaseLibraryLock(lock) {
  await lock.handle.close().catch(()=>{});
  await rm(lock.path,{force:true}).catch(()=>{});
}

async function assertMissing(path) {
  try {
    await lstat(path);
    throw new Error("target_exists");
  } catch (error) {
    if (error?.code!=="ENOENT") throw error;
  }
}

async function assertOwnedDirectory(path) {
  const metadata=await lstat(path);
  if (!metadata.isDirectory()||metadata.isSymbolicLink()||metadata.uid!==process.getuid()) {
    throw new Error("unsafe_directory");
  }
}

async function assertOwnedRegularFile(path) {
  const metadata=await lstat(path);
  if (!metadata.isFile()||metadata.isSymbolicLink()||metadata.uid!==process.getuid()) {
    throw new Error("unsafe_file");
  }
}

function resultFor(status,context,libraryKey,knowledgeId,path,files) {
  const base=portable(relative(context.vaultReal,path));
  return {
    status,knowledgeId,libraryKey,relativePath:base,
    files:files.map(name=>`${base}/${name}`)
  };
}

function sourceHasFile(source) {
  return source&&new Set(["file","feishu_document"]).has(source.sourceKind);
}

function inside(parent,child) {
  return child.startsWith(`${parent}${sep}`);
}
function portable(value) { return value.split(sep).join("/"); }
function delay(milliseconds) { return new Promise(resolve=>setTimeout(resolve,milliseconds)); }
