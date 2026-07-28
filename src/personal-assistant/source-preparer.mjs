import {createHash} from "node:crypto";
import {
  chmod,copyFile,lstat,mkdir,mkdtemp,readFile,rm
} from "node:fs/promises";
import {join} from "node:path";
import {createSourceHandle} from "./source-handle.mjs";
import {inspectAssistantSource} from "./source-security-inspector.mjs";

const MAX_SOURCES=8;
const MAX_FILE_BYTES=20*1024*1024;
const MAX_TURN_BYTES=80*1024*1024;
const SUPPORTED_EXTENSIONS=new Set([
  "","txt","md","docx","pptx","xlsx","pdf",
  "png","jpg","jpeg","webp"
]);

export function createAssistantSourcePreparer({
  download,tempRoot,inspect=inspectAssistantSource,
  cleanup=directory=>rm(directory,{recursive:true,force:true}),
  maxSourcesPerTurn=MAX_SOURCES,
  maxFileBytes=MAX_FILE_BYTES,
  maxTurnSourceBytes=MAX_TURN_BYTES
}) {
  if (typeof download!=="function"||typeof inspect!=="function"||
      typeof cleanup!=="function"||typeof tempRoot!=="string"||!tempRoot||
      !Number.isSafeInteger(maxSourcesPerTurn)||
      maxSourcesPerTurn<1||maxSourcesPerTurn>MAX_SOURCES||
      !Number.isSafeInteger(maxFileBytes)||
      maxFileBytes<1||maxFileBytes>MAX_FILE_BYTES||
      !Number.isSafeInteger(maxTurnSourceBytes)||
      maxTurnSourceBytes<maxFileBytes||
      maxTurnSourceBytes>MAX_TURN_BYTES) {
    throw new Error("assistant_source_preparer_invalid");
  }
  return async function prepareTurnSources(message) {
    validateMessage(message,maxSourcesPerTurn);
    let workspaceDir=null;
    try {
      await mkdir(tempRoot,{recursive:true,mode:0o700});
      const rootInfo=await lstat(tempRoot);
      if (!rootInfo.isDirectory()||rootInfo.isSymbolicLink()||
          rootInfo.uid!==process.getuid()) {
        throw new Error("assistant_source_invalid");
      }
      await chmod(tempRoot,0o700);
      workspaceDir=await mkdtemp(join(tempRoot,"llw-turn-"));
      await chmod(workspaceDir,0o700);
      const sources=[];
      let totalBytes=0;
      for (let index=0;index<message.attachments.length;index+=1) {
        const attachment=message.attachments[index];
        if (!SUPPORTED_EXTENSIONS.has(attachment.extension.toLowerCase())) {
          throw new Error("assistant_model_unsupported");
        }
        let downloaded=null;
        try {
          try {
            downloaded=await download({message,attachment});
          } catch {
            throw new Error("source_receive_failed");
          }
          if (!downloaded||typeof downloaded.file!=="string"||
              typeof downloaded.tempDir!=="string") {
            throw new Error("source_receive_failed");
          }
          const downloadedInfo=await lstat(downloaded.file);
          if (downloadedInfo.size>maxFileBytes) {
            throw new Error("source_limit_exceeded");
          }
          let inspected;
          try {
            inspected=await inspect(downloaded.file,{
              claimedExtension:attachment.extension,
              maxFileBytes
            });
          } catch {
            throw new Error("source_security_rejected");
          }
          totalBytes+=inspected.byteSize;
          if (totalBytes>maxTurnSourceBytes) {
            throw new Error("source_limit_exceeded");
          }
          const sourceId=`source-${String(index+1).padStart(3,"0")}`;
          const relativePath=`${sourceId}.${inspected.archiveExtension}`;
          const absolutePath=join(workspaceDir,relativePath);
          await copyFile(downloaded.file,absolutePath);
          await chmod(absolutePath,0o600);
          await verifyPlacedSource(absolutePath,inspected);
          const handle=createSourceHandle({
            sourceId,
            displayName:attachment.displayName,
            mediaClass:inspected.mediaClass,
            format:inspected.format,
            relativePath,
            byteSize:inspected.byteSize,
            sha256:inspected.sha256,
            availability:"ready"
          });
          sources.push(Object.freeze({
            handle,absolutePath,
            archiveExtension:inspected.archiveExtension
          }));
        } finally {
          if (downloaded?.tempDir) {
            const directory=downloaded.tempDir;
            downloaded=null;
            await cleanup(directory).catch(()=>{});
          }
        }
      }
      const completedWorkspaceDir=workspaceDir;
      const result=Object.freeze({
        workspaceDir:completedWorkspaceDir,
        sources:Object.freeze(sources),
        cleanup:once(()=>cleanup(completedWorkspaceDir))
      });
      workspaceDir=null;
      return result;
    } catch (error) {
      if (workspaceDir) await cleanup(workspaceDir).catch(()=>{});
      if (new Set([
        "source_receive_failed","source_security_rejected",
        "source_limit_exceeded","assistant_model_unsupported"
      ]).has(error?.message)) throw error;
      throw new Error("assistant_source_invalid");
    }
  };
}

async function verifyPlacedSource(file,inspected) {
  const info=await lstat(file);
  if (!info.isFile()||info.isSymbolicLink()||
      info.size!==inspected.byteSize||(info.mode&0o077)!==0) {
    throw new Error("assistant_source_invalid");
  }
  const bytes=await readFile(file);
  const sha256=createHash("sha256").update(bytes).digest("hex");
  if (sha256!==inspected.sha256) throw new Error("assistant_source_invalid");
}

function validateMessage(message,maxSources) {
  if (!message||typeof message!=="object"||Array.isArray(message)||
      typeof message.instructionText!=="string"||
      !Array.isArray(message.attachments)||
      message.attachments.length>maxSources||
      (!message.instructionText.trim()&&!message.attachments.length)) {
    throw new Error("assistant_source_invalid");
  }
  for (const attachment of message.attachments) {
    if (!attachment||typeof attachment!=="object"||
        Array.isArray(attachment)||
        !new Set(["image","file"]).has(attachment.type)||
        typeof attachment.displayName!=="string"||
        !attachment.displayName||
        typeof attachment.extension!=="string") {
      throw new Error("assistant_source_invalid");
    }
  }
}

function once(operation) {
  let promise;
  return ()=>promise||=Promise.resolve().then(operation);
}
