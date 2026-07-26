import {randomUUID} from "node:crypto";
import {
  chmod,lstat,mkdir,open,readFile,rename,rm
} from "node:fs/promises";
import {join,resolve,sep} from "node:path";

const SESSION=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SESSION_FIELDS=new Set([
  "version","session_id","current_draft_version","started_at","updated_at"
]);
const SOURCES_FIELDS=new Set([
  "version","draft_version","updated_at","paths"
]);
const MAX_DRAFT_BYTES=1024*1024;

export class TaskWorkspace {
  constructor(root) {
    this.root=root;
  }

  async create({sessionId,startedAt}) {
    try {
      validateSessionId(sessionId); canonicalIso(startedAt);
      await ensurePrivateRoot(this.root);
      const directory=this.#sessionDirectory(sessionId);
      await mkdir(directory,{mode:0o700});
      await chmod(directory,0o700);
      await writeExclusive(join(directory,"session.json"),json({
        version:1,session_id:sessionId,current_draft_version:0,
        started_at:startedAt,updated_at:startedAt
      }));
      await writeExclusive(join(directory,"sources.json"),json({
        version:1,draft_version:0,updated_at:startedAt,paths:[]
      }));
    } catch {
      throw new Error("task_workspace_rejected");
    }
  }

  async saveDraft({sessionId,baseVersion,text,sourcePaths,updatedAt}) {
    let lock,draft,sessionTemporary,sourcesTemporary;
    try {
      validateSessionId(sessionId); canonicalIso(updatedAt);
      validateDraft(baseVersion,text,sourcePaths);
      const directory=await this.#openSession(sessionId);
      lock=join(directory,".write-lock");
      const lockHandle=await open(lock,"wx",0o600);
      await lockHandle.close();
      const metadata=await readMetadata(join(directory,"session.json"),sessionId);
      if (metadata.current_draft_version!==baseVersion||
          Date.parse(updatedAt)<Date.parse(metadata.updated_at)) {
        throw new Error("invalid");
      }
      const nextVersion=baseVersion+1;
      draft=join(directory,`draft-v${nextVersion}.md`);
      await writeExclusive(draft,text);
      sessionTemporary=join(directory,`.session-${randomUUID()}.tmp`);
      sourcesTemporary=join(directory,`.sources-${randomUUID()}.tmp`);
      await writeExclusive(sourcesTemporary,json({
        version:1,draft_version:nextVersion,updated_at:updatedAt,
        paths:sourcePaths
      }));
      await writeExclusive(sessionTemporary,json({
        ...metadata,current_draft_version:nextVersion,updated_at:updatedAt
      }));
      await rename(sourcesTemporary,join(directory,"sources.json"));
      sourcesTemporary="";
      await rename(sessionTemporary,join(directory,"session.json"));
      sessionTemporary="";
      return {version:nextVersion};
    } catch {
      if (draft) await rm(draft,{force:true}).catch(()=>{});
      throw new Error("task_workspace_rejected");
    } finally {
      if (sessionTemporary) await rm(sessionTemporary,{force:true}).catch(()=>{});
      if (sourcesTemporary) await rm(sourcesTemporary,{force:true}).catch(()=>{});
      if (lock) await rm(lock,{force:true}).catch(()=>{});
    }
  }

  async load(sessionId) {
    try {
      validateSessionId(sessionId);
      const directory=await this.#openSession(sessionId);
      const metadata=await readMetadata(join(directory,"session.json"),sessionId);
      const sources=readSources(
        JSON.parse(await readRegular(join(directory,"sources.json"),8192))
      );
      const effectiveVersion=sources.draft_version===metadata.current_draft_version
        ?metadata.current_draft_version
        :sources.draft_version===metadata.current_draft_version+1
          ?sources.draft_version
          :NaN;
      if (!Number.isInteger(effectiveVersion)) throw new Error("invalid");
      const currentDraft=effectiveVersion===0
        ?""
        :await readRegular(
          join(directory,`draft-v${effectiveVersion}.md`),
          MAX_DRAFT_BYTES
        );
      return {
        currentDraftVersion:effectiveVersion,currentDraft,
        sourcePaths:sources.paths,startedAt:metadata.started_at,
        updatedAt:effectiveVersion===metadata.current_draft_version
          ?metadata.updated_at:sources.updated_at
      };
    } catch {
      throw new Error("task_workspace_rejected");
    }
  }

  #sessionDirectory(sessionId) {
    const root=resolve(this.root),directory=resolve(root,sessionId);
    if (!directory.startsWith(`${root}${sep}`)) throw new Error("invalid");
    return directory;
  }

  async #openSession(sessionId) {
    await ensurePrivateRoot(this.root);
    const directory=this.#sessionDirectory(sessionId);
    const metadata=await lstat(directory);
    if (!metadata.isDirectory()||metadata.isSymbolicLink()||
        metadata.uid!==process.getuid()||(metadata.mode&0o077)!==0) {
      throw new Error("invalid");
    }
    return directory;
  }
}

function readSources(value) {
  if (!value||typeof value!=="object"||Array.isArray(value)||
      Object.keys(value).length!==SOURCES_FIELDS.size||
      Object.keys(value).some(field=>!SOURCES_FIELDS.has(field))||
      value.version!==1||!Number.isInteger(value.draft_version)||
      value.draft_version<0||value.draft_version>1_000_000) {
    throw new Error("invalid");
  }
  canonicalIso(value.updated_at);
  validatePaths(value.paths);
  return value;
}

async function readMetadata(file,sessionId) {
  const value=JSON.parse(await readRegular(file,8192));
  if (!value||typeof value!=="object"||Array.isArray(value)||
      Object.keys(value).length!==SESSION_FIELDS.size||
      Object.keys(value).some(field=>!SESSION_FIELDS.has(field))||
      value.version!==1||value.session_id!==sessionId||
      !Number.isInteger(value.current_draft_version)||
      value.current_draft_version<0||value.current_draft_version>1_000_000) {
    throw new Error("invalid");
  }
  canonicalIso(value.started_at); canonicalIso(value.updated_at);
  if (Date.parse(value.updated_at)<Date.parse(value.started_at)) throw new Error("invalid");
  return value;
}

function validateDraft(baseVersion,text,sourcePaths) {
  if (!Number.isInteger(baseVersion)||baseVersion<0||baseVersion>=1_000_000||
      typeof text!=="string"||!text.trim()||text.includes("\0")||
      Buffer.byteLength(text,"utf8")>MAX_DRAFT_BYTES) throw new Error("invalid");
  validatePaths(sourcePaths);
}

function validatePaths(value) {
  if (!Array.isArray(value)||value.length>20||new Set(value).size!==value.length) {
    throw new Error("invalid");
  }
  for (const path of value) {
    if (typeof path!=="string"||!path||[...path].length>240||
        Buffer.byteLength(path,"utf8")>240||
        path.startsWith("/")||path.startsWith("~")||path.includes("\\")||
        /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(path)||
        path.split("/").some(segment=>!segment||segment==="."||segment==="..")) {
      throw new Error("invalid");
    }
  }
}

async function ensurePrivateRoot(root) {
  if (typeof root!=="string") throw new Error("invalid");
  await mkdir(root,{recursive:true,mode:0o700});
  await chmod(root,0o700);
  const metadata=await lstat(root);
  if (!metadata.isDirectory()||metadata.isSymbolicLink()||
      metadata.uid!==process.getuid()||(metadata.mode&0o077)!==0) {
    throw new Error("invalid");
  }
}

async function writeExclusive(file,content) {
  const handle=await open(file,"wx",0o600);
  try {
    await handle.writeFile(content,"utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readRegular(file,maxBytes) {
  const before=await lstat(file);
  if (!before.isFile()||before.isSymbolicLink()||before.uid!==process.getuid()||
      (before.mode&0o077)!==0||before.size<1||before.size>maxBytes) {
    throw new Error("invalid");
  }
  const handle=await open(file,"r");
  try {
    const after=await handle.stat();
    if (after.dev!==before.dev||after.ino!==before.ino||after.size!==before.size) {
      throw new Error("invalid");
    }
    return handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function validateSessionId(value) {
  if (typeof value!=="string"||!SESSION.test(value)) throw new Error("invalid");
}

function canonicalIso(value) {
  if (typeof value!=="string"||!Number.isFinite(Date.parse(value))||
      new Date(value).toISOString()!==value) throw new Error("invalid");
}

function json(value) {
  return `${JSON.stringify(value,null,2)}\n`;
}
