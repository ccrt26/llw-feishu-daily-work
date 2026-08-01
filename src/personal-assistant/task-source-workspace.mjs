import {createHash,randomUUID} from "node:crypto";
import {createReadStream} from "node:fs";
import {
  chmod,constants as fsConstants,copyFile,lstat,mkdir,open,readFile,
  readdir,rename,rm
} from "node:fs/promises";
import {isAbsolute,join} from "node:path";
import {
  extractFeishuDocumentRequests
} from "../core/feishu-document-link.mjs";
import {
  extractPublicVideoRequest
} from "./public-video-link.mjs";
import {createSourceHandle} from "./source-handle.mjs";
import {validateTaskSession} from "./task-session.mjs";

const TASK_ID=/^[A-Za-z0-9_-]{43}$/u;
const TASK_DIRECTORY=/^llw-task-([A-Za-z0-9_-]{43})$/u;
const MANIFEST="task-sources.json";
const SOURCE_INTAKE_FAILURES=new Set([
  "source_receive_failed","source_security_rejected",
  "source_limit_exceeded","assistant_model_unsupported"
]);
const PUBLIC_VIDEO_FAILURE_CODES=new Set([
  "bilibili_url_invalid","bilibili_access_denied",
  "bilibili_control_invalid","bilibili_media_unavailable",
  "bilibili_media_invalid","bilibili_limit_exceeded",
  "bilibili_source_workspace_mode_failed",
  "bilibili_result_metadata_invalid",
  "bilibili_audio_descriptor_invalid",
  "bilibili_video_descriptor_invalid",
  "bilibili_audio_workspace_realpath_failed",
  "bilibili_video_workspace_realpath_failed",
  "bilibili_audio_file_realpath_failed",
  "bilibili_video_file_realpath_failed",
  "bilibili_audio_file_stat_failed",
  "bilibili_video_file_stat_failed",
  "bilibili_audio_file_metadata_invalid",
  "bilibili_video_file_metadata_invalid",
  "bilibili_audio_read_failed","bilibili_video_read_failed",
  "bilibili_audio_hash_mismatch","bilibili_video_hash_mismatch",
  "bilibili_source_handle_invalid"
]);

export class TaskSourceWorkspace {
  constructor({root,prepareTurnSources,now=Date.now,operations={}}) {
    if (typeof root!=="string"||!isAbsolute(root)||
        typeof prepareTurnSources!=="function"||
        typeof now!=="function"||
        !operations||typeof operations!=="object"||
        Array.isArray(operations)||
        Object.keys(operations).some(key=>key!=="readFile")||
        (operations.readFile!==undefined&&
          typeof operations.readFile!=="function")) {
      throw new Error("task_source_workspace_invalid");
    }
    this.root=root;
    this.prepareTurnSources=prepareTurnSources;
    this.now=now;
    this.readFile=operations.readFile??readFile;
  }

  async ensure({session}) {
    const current=validateTaskSession(session);
    await this.ensureRoot();
    try {
      return await this.load({
        taskId:current.taskId,
        expectedSourceIds:current.sourceIds
      });
    } catch (error) {
      if (error?.code!=="ENOENT") throw error;
    }
    if (current.sourceIds.length) {
      throw new Error("task_source_workspace_invalid");
    }
    const workspaceDir=this.workspace(current.taskId);
    await mkdir(workspaceDir,{mode:0o700});
    await chmod(workspaceDir,0o700);
    await this.writeManifest({
      version:1,
      taskId:current.taskId,
      createdAt:current.startedAt,
      updatedAt:current.updatedAt,
      sources:[]
    });
    return this.load({
      taskId:current.taskId,
      expectedSourceIds:current.sourceIds
    });
  }

  async prepareAndMerge({session,message,signal}) {
    const current=validateTaskSession(session);
    if (!message||message.source!==current.source||
        !(signal===undefined||signal instanceof AbortSignal)) {
      throw new Error("task_source_workspace_invalid");
    }
    const recovered=await this.recoverPrepared({
      session:current,message
    });
    if (recovered) return recovered;
    let prepared;
    try {
      prepared=await this.prepareTurnSources(message,{signal});
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
          for (const auxiliary of source.auxiliaryFiles??[]) {
            validateAuxiliary(auxiliary);
            const auxiliaryPath=join(
              workspaceDir,
              `${sourceId}.${auxiliary.role}.${auxiliary.extension}`
            );
            await copyFile(
              auxiliary.absolutePath,
              auxiliaryPath,
              fsConstants.COPYFILE_EXCL
            );
            addedPaths.push(auxiliaryPath);
            await chmod(auxiliaryPath,0o600);
            await verifyAuxiliary(auxiliaryPath,auxiliary);
          }
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
      const failure=new Error("task_source_workspace_invalid");
      if (PUBLIC_VIDEO_FAILURE_CODES.has(
        error?.publicVideoFailureCode
      )) {
        failure.publicVideoFailureCode=error.publicVideoFailureCode;
      }
      throw failure;
    } finally {
      if (prepared?.cleanup) {
        await prepared.cleanup().catch(()=>{});
      }
    }
  }

  async recoverPrepared({session,message}) {
    await this.ensureRoot();
    let manifest;
    try {
      manifest=await this.readManifest(session.taskId);
    } catch (error) {
      if (error?.code==="ENOENT") return null;
      throw error;
    }
    const manifestIds=manifest.sources.map(
      entry=>entry.handle.sourceId
    );
    if (sameArray(manifestIds,session.sourceIds)) return null;
    if (manifestIds.length<=session.sourceIds.length||
        !sameArray(
          manifestIds.slice(0,session.sourceIds.length),
          session.sourceIds
        )) {
      throw new Error("task_source_workspace_invalid");
    }
    const documentBundle=extractFeishuDocumentRequests(message);
    const documentCount=documentBundle?.requests.length??0;
    const publicVideoRequest=extractPublicVideoRequest(
      message.instructionText
    );
    const publicVideoCount=publicVideoRequest?1:0;
    const missing=manifest.sources.slice(session.sourceIds.length);
    if (missing.length!==
        documentCount+message.attachments.length+publicVideoCount) {
      throw new Error("task_source_workspace_invalid");
    }
    for (let index=0;index<message.attachments.length;index+=1) {
      const attachment=message.attachments[index];
      const entry=missing[documentCount+index];
      if (entry.handle.displayName!==attachment.displayName||
          (attachment.extension&&
            entry.archiveExtension!==attachment.extension.toLowerCase())) {
        throw new Error("task_source_workspace_invalid");
      }
    }
    if (publicVideoRequest) {
      const entry=missing[
        documentCount+message.attachments.length
      ];
      if (entry.handle.mediaClass!=="video"||
          entry.archiveExtension!=="mp4"||
          !entry.handle.displayName.startsWith(
            `${publicVideoRequest.platform}-`
          )) {
        throw new Error("task_source_workspace_invalid");
      }
    }
    const loaded=await this.load({
      taskId:session.taskId,expectedSourceIds:manifestIds
    });
    return Object.freeze({
      ...loaded,
      instructionText:documentBundle?.safeInstructionText??
        message.instructionText,
      addedSourceIds:Object.freeze(
        manifestIds.slice(session.sourceIds.length)
      )
    });
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
      const match=TASK_DIRECTORY.exec(entry.name);
      if (!entry.isDirectory()||entry.isSymbolicLink()||
          !match||active.has(match[1])) continue;
      const taskId=match[1];
      const manifest=await this.readManifest(taskId);
      if (Date.parse(now)-Date.parse(manifest.updatedAt)<24*60*60*1000) {
        continue;
      }
      await this.remove({taskId});
      removed.push(taskId);
    }
    return Object.freeze(removed.sort());
  }

  workspace(taskId) {
    if (!TASK_ID.test(taskId||"")) {
      throw new Error("task_source_workspace_invalid");
    }
    return join(this.root,`llw-task-${taskId}`);
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
    const value=JSON.parse(await this.readFile(file,"utf8"));
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
  const hash=createHash("sha256");
  try {
    for await (const chunk of createReadStream(file)) hash.update(chunk);
  } catch {
    throw new Error("task_source_workspace_invalid");
  }
  const sha256=hash.digest("hex");
  if (sha256!==handle.sha256) {
    throw new Error("task_source_workspace_invalid");
  }
}

function validateAuxiliary(value) {
  const fields=new Set([
    "role","extension","absolutePath","byteSize","sha256","durationMs"
  ]);
  if (!value||typeof value!=="object"||Array.isArray(value)||
      Object.keys(value).length!==fields.size||
      Object.keys(value).some(key=>!fields.has(key))||
      value.role!=="audio"||value.extension!=="m4a"||
      typeof value.absolutePath!=="string"||
      !isAbsolute(value.absolutePath)||
      !Number.isSafeInteger(value.byteSize)||value.byteSize<12||
      !/^[a-f0-9]{64}$/u.test(value.sha256||"")||
      !Number.isSafeInteger(value.durationMs)||
      value.durationMs<1||value.durationMs>7*24*60*60*1_000) {
    throw new Error("task_source_workspace_invalid");
  }
}

async function verifyAuxiliary(file,value) {
  const info=await lstat(file);
  if (!info.isFile()||info.isSymbolicLink()||
      info.uid!==process.getuid()||(info.mode&0o077)!==0||
      info.size!==value.byteSize||
      await sha256File(file)!==value.sha256) {
    throw new Error("task_source_workspace_invalid");
  }
}

async function sha256File(file) {
  const hash=createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
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
