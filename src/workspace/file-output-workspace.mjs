import {constants as fsConstants} from "node:fs";
import {
  chmod,copyFile,link,lstat,mkdir,mkdtemp,readFile,readdir,rm,rmdir,unlink,
  writeFile
} from "node:fs/promises";
import {createHash,randomUUID} from "node:crypto";
import {basename,dirname,extname,isAbsolute,join,relative,resolve} from "node:path";

const KINDS=new Map([
  ["docx",{
    mime:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    required:"word/document.xml"
  }],
  ["pptx",{
    mime:"application/vnd.openxmlformats-officedocument.presentationml.presentation",
    required:"ppt/presentation.xml"
  }],
  ["xlsx",{
    mime:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    required:"xl/workbook.xml"
  }]
]);
const FORMAT_PATTERNS=new Map([
  ["docx",/(?:\bdocx\b|\bword\b|WPS\s*文字|文字文档)/iu],
  ["pptx",/(?:\bpptx?\b|powerpoint|WPS\s*演示|演示文稿|幻灯片)/iu],
  ["xlsx",/(?:\bxlsx\b|\bexcel\b|WPS\s*表格|电子表格)/iu]
]);

export function selectRequestedOutput(text) {
  if (typeof text!=="string"||!text.trim()) return null;
  const matches=[...FORMAT_PATTERNS].filter(([,pattern])=>pattern.test(text));
  return matches.length===1?matches[0][0]:null;
}

export class FileOutputWorkspace {
  constructor({tempRoot,outputRoot,maxOutputBytes,outputRetentionDays}) {
    if (![tempRoot,outputRoot].every(value=>typeof value==="string"&&value)||
        !Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<1024||
        maxOutputBytes>100*1024*1024||outputRetentionDays!==7||
        tempRoot===outputRoot) {
      throw new Error("invalid_file_output_workspace");
    }
    this.tempRoot=tempRoot;
    this.outputRoot=outputRoot;
    this.maxOutputBytes=maxOutputBytes;
    this.outputRetentionDays=outputRetentionDays;
  }

  async generate({
    sessionId,draftVersion,kind,displayName,draftText,generate
  }) {
    validateRequest({
      sessionId,draftVersion,kind,displayName,draftText,generate
    });
    await ensurePrivateDirectory(this.tempRoot);
    await ensurePrivateDirectory(this.outputRoot);
    const stableDirectory=join(
      this.outputRoot,sessionId,`draft-v${draftVersion}`
    );
    const stableFile=join(stableDirectory,displayName);
    const existing=await optionalArtifact(
      stableFile,{kind,displayName,maxBytes:this.maxOutputBytes}
    );
    if (existing) return existing;
    const jobRoot=await mkdtemp(join(this.tempRoot,"file-output-"));
    await chmod(jobRoot,0o700);
    try {
      const deliverable=join(jobRoot,"deliverable");
      await mkdir(deliverable,{mode:0o700});
      const draftFile=join(jobRoot,"current-draft.md");
      await writeFile(draftFile,draftText,{encoding:"utf8",mode:0o600,flag:"wx"});
      const outputFile=join(deliverable,`output.${kind}`);
      await generate({
        jobRoot,draftFile,outputFile,kind,displayName,
        sessionId,draftVersion
      });
      const entries=await readdir(deliverable,{withFileTypes:true});
      if (entries.length!==1||entries[0].name!==basename(outputFile)||
          !entries[0].isFile()||entries[0].isSymbolicLink()) {
        throw new Error("file_output_invalid");
      }
      const artifact=await inspectArtifact(outputFile,{
        kind,displayName,maxBytes:this.maxOutputBytes
      });
      await ensurePrivateDirectory(stableDirectory);
      const temporary=join(stableDirectory,`.publish-${randomUUID()}.tmp`);
      try {
        await copyFile(outputFile,temporary,fsConstants.COPYFILE_EXCL);
        await chmod(temporary,0o600);
        try { await link(temporary,stableFile); }
        catch (error) {
          if (error?.code!=="EEXIST") throw error;
        }
      } finally {
        await unlink(temporary).catch(()=>{});
      }
      const published=await inspectArtifact(stableFile,{
        kind,displayName,maxBytes:this.maxOutputBytes
      });
      if (published.sha256!==artifact.sha256||
          published.size!==artifact.size) {
        throw new Error("file_output_invalid");
      }
      return published;
    } catch {
      throw new Error("file_output_invalid");
    } finally {
      await rm(jobRoot,{recursive:true,force:true}).catch(()=>{});
    }
  }

  async cleanup({protectedPaths=[],nowMs=Date.now()}={}) {
    if (!Array.isArray(protectedPaths)||!Number.isFinite(nowMs)) {
      throw new Error("file_output_cleanup_invalid");
    }
    await ensurePrivateDirectory(this.outputRoot);
    const root=resolve(this.outputRoot);
    const protectedSet=new Set(protectedPaths.map(path=>{
      if (typeof path!=="string"||!isAbsolute(path)) {
        throw new Error("file_output_cleanup_invalid");
      }
      const normalized=resolve(path);
      const child=relative(root,normalized);
      if (!child||child.startsWith("..")||isAbsolute(child)) {
        throw new Error("file_output_cleanup_invalid");
      }
      return normalized;
    }));
    const cutoff=nowMs-this.outputRetentionDays*24*60*60*1000;
    let removedFiles=0;
    for (const session of await readdir(root,{withFileTypes:true})) {
      if (!session.isDirectory()||session.isSymbolicLink()||
          !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(session.name)) continue;
      const sessionPath=join(root,session.name);
      if (!await isPrivateOwnedDirectory(sessionPath)) continue;
      for (const draft of await readdir(sessionPath,{withFileTypes:true})) {
        if (!draft.isDirectory()||draft.isSymbolicLink()||
            !/^draft-v[1-9][0-9]{0,6}$/u.test(draft.name)) continue;
        const draftPath=join(sessionPath,draft.name);
        if (!await isPrivateOwnedDirectory(draftPath)) continue;
        for (const entry of await readdir(draftPath,{withFileTypes:true})) {
          const kind=extname(entry.name).slice(1).toLowerCase();
          if (!entry.isFile()||entry.isSymbolicLink()||
              !KINDS.has(kind)) continue;
          const path=join(draftPath,entry.name);
          const metadata=await lstat(path);
          if (!metadata.isFile()||metadata.isSymbolicLink()||
              metadata.uid!==process.getuid()||protectedSet.has(resolve(path))||
              metadata.mtimeMs>cutoff) continue;
          try {
            await inspectArtifact(path,{
              kind,displayName:entry.name,maxBytes:this.maxOutputBytes
            });
          } catch {
            continue;
          }
          await unlink(path);
          removedFiles+=1;
        }
        await rmdir(draftPath).catch(error=>{
          if (!["ENOTEMPTY","EEXIST"].includes(error?.code)) throw error;
        });
      }
      await rmdir(sessionPath).catch(error=>{
        if (!["ENOTEMPTY","EEXIST"].includes(error?.code)) throw error;
      });
    }
    return {removedFiles};
  }
}

async function optionalArtifact(path,options) {
  try { return await inspectArtifact(path,options); }
  catch (error) {
    if (error?.code==="ENOENT") return null;
    throw new Error("file_output_invalid");
  }
}

async function inspectArtifact(path,{kind,displayName,maxBytes}) {
  const metadata=await lstat(path);
  if (!metadata.isFile()||metadata.isSymbolicLink()||
      metadata.uid!==process.getuid()||metadata.size<1||
      metadata.size>maxBytes||extname(path)!==`.${kind}`) {
    throw new Error("file_output_invalid");
  }
  const bytes=await readFile(path);
  const names=zipEntryNames(bytes);
  const specification=KINDS.get(kind);
  if (!names.has("[Content_Types].xml")||
      !names.has(specification.required)||
      [...names].some(name=>
        /(?:^|\/)(?:vbaProject\.bin|EncryptedPackage|EncryptionInfo)$/iu.test(name)
      )) {
    throw new Error("file_output_invalid");
  }
  return {
    kind,path,displayName,mime:specification.mime,
    sha256:createHash("sha256").update(bytes).digest("hex"),
    size:metadata.size
  };
}

function zipEntryNames(bytes) {
  if (bytes.length<22||bytes.readUInt32LE(0)!==0x04034b50) {
    throw new Error("file_output_invalid");
  }
  const floor=Math.max(0,bytes.length-65_557);
  let eocd=-1;
  for (let offset=bytes.length-22;offset>=floor;offset-=1) {
    if (bytes.readUInt32LE(offset)===0x06054b50) { eocd=offset; break; }
  }
  if (eocd<0) throw new Error("file_output_invalid");
  const count=bytes.readUInt16LE(eocd+10);
  let offset=bytes.readUInt32LE(eocd+16);
  if (count<1||count>10_000||offset>=eocd) {
    throw new Error("file_output_invalid");
  }
  const names=new Set();
  for (let index=0;index<count;index+=1) {
    if (offset+46>bytes.length||
        bytes.readUInt32LE(offset)!==0x02014b50) {
      throw new Error("file_output_invalid");
    }
    const nameLength=bytes.readUInt16LE(offset+28);
    const extraLength=bytes.readUInt16LE(offset+30);
    const commentLength=bytes.readUInt16LE(offset+32);
    const end=offset+46+nameLength;
    if (!nameLength||end>bytes.length) throw new Error("file_output_invalid");
    const name=bytes.subarray(offset+46,end).toString("utf8");
    if (!name||name.startsWith("/")||name.includes("\\")||
        name.split("/").some(segment=>segment===".."||segment===".")) {
      throw new Error("file_output_invalid");
    }
    names.add(name.replace(/\/$/u,""));
    offset=end+extraLength+commentLength;
  }
  return names;
}

async function ensurePrivateDirectory(path) {
  await mkdir(path,{recursive:true,mode:0o700});
  await chmod(path,0o700);
  const metadata=await lstat(path);
  if (!metadata.isDirectory()||metadata.isSymbolicLink()||
      metadata.uid!==process.getuid()||(metadata.mode&0o077)!==0) {
    throw new Error("file_output_invalid");
  }
}

async function isPrivateOwnedDirectory(path) {
  const metadata=await lstat(path);
  return metadata.isDirectory()&&!metadata.isSymbolicLink()&&
    metadata.uid===process.getuid()&&(metadata.mode&0o077)===0;
}

function validateRequest(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value.sessionId)||
      !Number.isInteger(value.draftVersion)||value.draftVersion<1||
      value.draftVersion>1_000_000||!KINDS.has(value.kind)||
      typeof value.displayName!=="string"||
      value.displayName!==value.displayName.trim()||
      [...value.displayName].length<1||[...value.displayName].length>160||
      basename(value.displayName)!==value.displayName||
      extname(value.displayName).toLowerCase()!==`.${value.kind}`||
      typeof value.draftText!=="string"||!value.draftText.trim()||
      Buffer.byteLength(value.draftText,"utf8")>1024*1024||
      typeof value.generate!=="function") {
    throw new Error("file_output_invalid");
  }
}
