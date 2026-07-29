import {createHash,randomUUID} from "node:crypto";
import {
  chmod,constants as fsConstants,copyFile,lstat,mkdir,open,readFile,
  readdir,rename,rm
} from "node:fs/promises";
import {isAbsolute,join} from "node:path";
import {createSourceHandle} from "./source-handle.mjs";
import {validateTaskSession} from "./task-session.mjs";

const TASK_ID=/^[A-Za-z0-9_-]{43}$/u;
const MANIFEST="task-sources.json";
const SOURCE_INTAKE_FAILURES=new Set([
  "source_receive_failed","source_security_rejected",
  "source_limit_exceeded","assistant_model_unsupported"
]);

export class TaskSourceWorkspace {
  constructor({root,prepareTurnSources,now=Date.now}) {
    if (typeof root!=="string"||!isAbsolute(root)||
        typeof prepareTurnSources!=="function"||
        typeof now!=="function") {
      throw new Error("task_source_workspace_invalid");
    }
    this.root=root;
    this.prepareTurnSources=prepareTurnSources;
    this.now=now;
  }

  async prepareAndMerge({session,message}) {
    const current=validateTaskSession(session);
    if (!message||message.source!==current.source) {
      throw new Error("task_source_workspace_invalid");
    }
    let prepared;
    try {
      prepared=await this.prepareTurnSources(message);
      await this.ensureRoot();
      const workspaceDir=this.workspace(current.taskId);
      let manifest;
      try {
        manifest=await this.readManifest(current.taskId);
      } catch (error) {
        if (error?.code!=="ENOENT") throw error;
        await mkdir(workspaceDir,{mode:0o700});
        await chmod(workspaceDir,0o700);
        manifest={
          version:1,
          taskId:current.taskId,
          createdAt:current.startedAt,
          updatedAt:message.receivedAt,
          sources:[]
        };
      }
      const manifestIds=manifest.sources.map(
        entry=>entry.handle.sourceId
      );
      if (!sameArray(manifestIds,current.sourceIds)||
          manifest.sources.length+(prepared.sources?.length||0)>8) {
        throw new Error("task_source_workspace_invalid");
      }
      const next=structuredClone(manifest);
      const addedSourceIds=[];
      const addedPaths=[];
      try {
        for (const source of prepared.sources||[]) {
          const index=next.sources.length+1;
          const sourceId=`source-${String(index).padStart(3,"0")}`;
          const archiveExtension=source.archiveExtension||
            source.handle?.relativePath?.split(".").at(-1);
          if (!/^[a-z0-9]{1,16}$/u.test(archiveExtension||"")) {
            throw new Error("task_source_workspace_invalid");
          }
          const relativePath=`${sourceId}.${archiveExtension}`;
          const handle=createSourceHandle({
            ...structuredClone(source.handle),
            sourceId,
            relativePath
          });
          const destination=join(workspaceDir,relativePath);
          await copyFile(
            source.absolutePath,destination,fsConstants.COPYFILE_EXCL
          );
          addedPaths.push(destination);
          await chmod(destination,0o600);
          await verifySource(destination,handle);
          next.sources.push({handle,archiveExtension});
          addedSourceIds.push(sourceId);
        }
        next.updatedAt=message.receivedAt;
        await this.writeManifest(next);
      } catch (error) {
        for (const file of addedPaths) {
          await rm(file,{force:true}).catch(()=>{});
        }
        throw error;
      }
      const loaded=await this.load({
        taskId:current.taskId,
        expectedSourceIds:next.sources.map(entry=>entry.handle.sourceId)
      });
      return Object.freeze({
        ...loaded,
        instructionText:prepared.instructionText,
        addedSourceIds:Object.freeze(addedSourceIds)
      });
    } catch (error) {
      if (error?.message==="task_source_workspace_invalid"||
          SOURCE_INTAKE_FAILURES.has(error?.message)) throw error;
      throw new Error("task_source_workspace_invalid");
    } finally {
      if (prepared?.cleanup) {
        await prepared.cleanup().catch(()=>{});
      }
    }
  }

  async load({taskId,expectedSourceIds}) {
    if (!TASK_ID.test(taskId||"")||
        !Array.isArray(expectedSourceIds)||
        expectedSourceIds.length>8) {
      throw new Error("task_source_workspace_invalid");
    }
    await this.ensureRoot();
    const manifest=await this.readManifest(taskId);
    const ids=manifest.sources.map(entry=>entry.handle.sourceId);
    if (!sameArray(ids,expectedSourceIds)) {
      throw new Error("task_source_workspace_invalid");
    }
    const workspaceDir=this.workspace(taskId);
    const sources=[];
    for (const entry of manifest.sources) {
      const handle=createSourceHandle(entry.handle);
      const absolutePath=join(workspaceDir,handle.relativePath);
      await verifySource(absolutePath,handle);
      sources.push(Object.freeze({
        handle,
        absolutePath,
        archiveExtension:entry.archiveExtension
      }));
    }
    return Object.freeze({
      workspaceDir,
      sources:Object.freeze(sources)
    });
  }

  async remove({taskId}) {
    if (!TASK_ID.test(taskId||"")) {
      throw new Error("task_source_workspace_invalid");
    }
    await rm(this.workspace(taskId),{recursive:true,force:true});
  }

  async cleanupExpired({activeTaskIds,now}) {
    if (!Array.isArray(activeTaskIds)||
        new Set(activeTaskIds).size!==activeTaskIds.length||
        activeTaskIds.some(taskId=>!TASK_ID.test(taskId))||
        !canonicalIso(now)) {
      throw new Error("task_source_workspace_invalid");
    }
    await this.ensureRoot();
    const active=new Set(activeTaskIds);
    const removed=[];
    const entries=await readdir(this.root,{withFileTypes:true});
    for (const entry of entries) {
      if (!entry.isDirectory()||entry.isSymbolicLink()||
          !TASK_ID.test(entry.name)||active.has(entry.name)) continue;
      const manifest=await this.readManifest(entry.name);
      if (Date.parse(now)-Date.parse(manifest.updatedAt)<24*60*60*1000) {
        continue;
      }
      await this.remove({taskId:entry.name});
      removed.push(entry.name);
    }
    return Object.freeze(removed.sort());
  }

  workspace(taskId) {
    if (!TASK_ID.test(taskId||"")) {
      throw new Error("task_source_workspace_invalid");
    }
    return join(this.root,taskId);
  }

  async readManifest(taskId) {
    const workspaceDir=this.workspace(taskId);
    const workspaceInfo=await lstat(workspaceDir);
    if (!workspaceInfo.isDirectory()||workspaceInfo.isSymbolicLink()||
        workspaceInfo.uid!==process.getuid()||
        (workspaceInfo.mode&0o077)!==0) {
      throw new Error("task_source_workspace_invalid");
    }
    const file=join(workspaceDir,MANIFEST);
    const info=await lstat(file);
    if (!info.isFile()||info.isSymbolicLink()||
        info.uid!==process.getuid()||(info.mode&0o077)!==0) {
      throw new Error("task_source_workspace_invalid");
    }
    const value=JSON.parse(await readFile(file,"utf8"));
    validateManifest(value,taskId);
    return value;
  }

  async writeManifest(value) {
    validateManifest(value,value.taskId);
    const directory=this.workspace(value.taskId);
    const temporary=join(directory,`.manifest-${randomUUID()}.tmp`);
    const handle=await open(temporary,"wx",0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`,"utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary,join(directory,MANIFEST));
    await chmod(join(directory,MANIFEST),0o600);
  }

  async ensureRoot() {
    await mkdir(this.root,{recursive:true,mode:0o700});
    const info=await lstat(this.root);
    if (!info.isDirectory()||info.isSymbolicLink()||
        info.uid!==process.getuid()||(info.mode&0o077)!==0) {
      throw new Error("task_source_workspace_invalid");
    }
    await chmod(this.root,0o700);
  }
}

function validateManifest(value,taskId) {
  const fields=new Set([
    "version","taskId","createdAt","updatedAt","sources"
  ]);
  if (!plainExact(value,fields)||value.version!==1||
      value.taskId!==taskId||!TASK_ID.test(value.taskId||"")||
      !canonicalIso(value.createdAt)||!canonicalIso(value.updatedAt)||
      Date.parse(value.updatedAt)<Date.parse(value.createdAt)||
      !Array.isArray(value.sources)||value.sources.length>8) {
    throw new Error("task_source_workspace_invalid");
  }
  const ids=new Set();
  for (let index=0;index<value.sources.length;index+=1) {
    const entry=value.sources[index];
    if (!plainExact(entry,new Set(["handle","archiveExtension"]))||
        !/^[a-z0-9]{1,16}$/u.test(entry.archiveExtension||"")) {
      throw new Error("task_source_workspace_invalid");
    }
    const handle=createSourceHandle(entry.handle);
    const expected=`source-${String(index+1).padStart(3,"0")}`;
    if (handle.sourceId!==expected||ids.has(handle.sourceId)||
        handle.relativePath!==`${handle.sourceId}.${entry.archiveExtension}`) {
      throw new Error("task_source_workspace_invalid");
    }
    ids.add(handle.sourceId);
  }
}

async function verifySource(file,handle) {
  const info=await lstat(file);
  if (!info.isFile()||info.isSymbolicLink()||
      info.uid!==process.getuid()||(info.mode&0o077)!==0||
      info.size!==handle.byteSize) {
    throw new Error("task_source_workspace_invalid");
  }
  const sha256=createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
  if (sha256!==handle.sha256) {
    throw new Error("task_source_workspace_invalid");
  }
}

function plainExact(value,fields) {
  return value&&typeof value==="object"&&!Array.isArray(value)&&
    Object.getPrototypeOf(value)===Object.prototype&&
    Object.keys(value).length===fields.size&&
    Object.keys(value).every(key=>fields.has(key));
}

function canonicalIso(value) {
  return typeof value==="string"&&Number.isFinite(Date.parse(value))&&
    new Date(value).toISOString()===value;
}

function sameArray(left,right) {
  return left.length===right.length&&
    left.every((value,index)=>value===right[index]);
}
