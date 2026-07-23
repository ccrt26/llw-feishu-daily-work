import {spawn} from "node:child_process";
import {chmod, lstat, mkdir, mkdtemp, readdir, rm} from "node:fs/promises";
import {join} from "node:path";

export async function downloadLarkResource({cliPath,profile,messageId,fileKey,type,tempRoot,environment=process.env,timeoutMs=120_000,maxAttempts=3,retryDelayMs=500}) {
  await mkdir(tempRoot,{recursive:true,mode:0o700});
  await chmod(tempRoot,0o700);
  const tempDir = await mkdtemp(join(tempRoot,"job-"));
  await chmod(tempDir,0o700);
  try {
    const args = ["--profile",profile,"im","+messages-resources-download","--as","bot","--message-id",messageId,"--file-key",fileKey,"--type",type,"--output","attachment"];
    const pathParts = ["/usr/local/bin","/usr/bin","/bin","/usr/sbin","/sbin",...(environment.PATH || "").split(":")];
    const commandEnvironment = {
      ...environment,
      PATH:[...new Set(pathParts.filter(Boolean))].join(":"),
      LARK_CLI_NO_PROXY:"1",
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER:"1",
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER:"1"
    };
    const attempts = Math.max(1,Math.min(3,Number.isInteger(maxAttempts) ? maxAttempts : 3));
    const delayMs = Math.max(0,Math.min(5_000,Number.isFinite(retryDelayMs) ? retryDelayMs : 500));
    for (let attempt=1; attempt<=attempts; attempt += 1) {
      try {
        await run(cliPath,args,{cwd:tempDir,environment:commandEnvironment,timeoutMs});
        break;
      } catch (error) {
        if (error?.code !== "download_failed" || attempt === attempts) throw error;
        await clearDirectory(tempDir);
        if (delayMs > 0) await delay(delayMs * attempt);
      }
    }
    const entries = await readdir(tempDir,{withFileTypes:true});
    if (entries.length !== 1) throw coded("download_output_count");
    const file = join(tempDir,entries[0].name);
    const info = await lstat(file);
    if (!entries[0].isFile() || !info.isFile() || info.isSymbolicLink()) throw coded("download_output_unsafe");
    return {tempDir,file};
  } catch (error) {
    await rm(tempDir,{recursive:true,force:true});
    if (error?.code?.startsWith?.("download_")) throw error;
    throw coded("download_failed");
  }
}

async function clearDirectory(directory) {
  for (const entry of await readdir(directory)) await rm(join(directory,entry),{recursive:true,force:true});
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve,milliseconds));
}

export async function scavengeInvoiceTempRoot(tempRoot,{nowMs=Date.now(),maxAgeMs=24*60*60*1000}={}) {
  await mkdir(tempRoot,{recursive:true,mode:0o700});
  await chmod(tempRoot,0o700);
  const rootInfo=await lstat(tempRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw coded("unsafe_temp_root");
  for (const entry of await readdir(tempRoot,{withFileTypes:true})) {
    if (!/^job-[A-Za-z0-9_-]+$/.test(entry.name)) continue;
    const path=join(tempRoot,entry.name);
    const info=await lstat(path);
    if (!entry.isDirectory() || !info.isDirectory() || info.isSymbolicLink()) continue;
    if (nowMs-info.mtimeMs > maxAgeMs) await rm(path,{recursive:true,force:true});
  }
}

function run(command,args,{cwd,environment,timeoutMs}) {
  return new Promise((resolve,reject) => {
    const child = spawn(command,args,{cwd,env:environment,stdio:["ignore","ignore","ignore"]});
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    },timeoutMs);
    child.once("error",() => {
      clearTimeout(timer);
      reject(coded(timedOut ? "download_timeout" : "download_failed"));
    });
    child.once("close",code => {
      clearTimeout(timer);
      if (timedOut) reject(coded("download_timeout"));
      else if (code !== 0) reject(coded("download_failed"));
      else resolve();
    });
  });
}

function coded(code) {
  return Object.assign(new Error(code),{code});
}
