import {spawn} from "node:child_process";
import {
  chmod,copyFile,lstat,mkdir,mkdtemp,readFile,readdir,rm
} from "node:fs/promises";
import {basename,join} from "node:path";
import {validateKnowledgeDecision} from "./decision-validator.mjs";

const REQUIRED_SKILL_NAME="llw-knowledge-ingest";
const MAX_OUTPUT_BYTES=256 * 1024;

export async function invokeKnowledgeDecision({
  codexPath,skillRoot,tempRoot,input,timeoutMs=120_000,environment=process.env,
  maxAttempts=2,retryDelayMs=1_000
}) {
  let jobRoot;
  try {
    validateCall(codexPath,skillRoot,tempRoot,input,timeoutMs);
    await ensurePrivateDirectory(tempRoot);
    jobRoot=await mkdtemp(join(tempRoot,"knowledge-"));
    await chmod(jobRoot,0o700);
    const copiedSkill=join(jobRoot,".agents","skills",REQUIRED_SKILL_NAME);
    await copySelectedSkill(skillRoot,copiedSkill);
    const output=join(jobRoot,"decision.json");
    const schema=join(copiedSkill,"references","output-schema.json");
    const args=[
      "exec","--ephemeral","--sandbox","read-only","--skip-git-repo-check",
      "--color","never","-c",'model_reasoning_effort="low"',
      "--output-schema",schema,"--output-last-message",output,"-"
    ];
    const prompt=[
      `使用 $${REQUIRED_SKILL_NAME}。`,
      "根据以下 JSON 判断是否入库以及安全的目录计划。",
      "只输出符合该 Skill output schema 的 JSON，不要输出解释。",
      `CONTEXT_JSON:${JSON.stringify(input)}`
    ].join("\n");
    const attempts=Math.max(1,Math.min(2,Number.isInteger(maxAttempts)?maxAttempts:2));
    const delayMs=Math.max(0,Math.min(5_000,Number.isFinite(retryDelayMs)?retryDelayMs:1_000));
    for (let attempt=1;attempt<=attempts;attempt+=1) {
      try {
        await rm(output,{force:true});
        await runCodex(codexPath,args,prompt,{cwd:jobRoot,timeoutMs,environment});
        const raw=await readLimited(output,MAX_OUTPUT_BYTES);
        const parsed=JSON.parse(raw);
        return validateKnowledgeDecision(parsed,{libraries:input.allowedLibraries});
      } catch (error) {
        if (error?.message!=="codex_failed"||attempt===attempts) throw error;
        if (delayMs) await delay(delayMs);
      }
    }
  } catch {
    throw new Error("knowledge_decision_failed");
  } finally {
    if (jobRoot) await rm(jobRoot,{recursive:true,force:true}).catch(()=>{});
  }
}

function delay(milliseconds) {
  return new Promise(resolve=>setTimeout(resolve,milliseconds));
}

async function copySelectedSkill(sourceRoot,destinationRoot) {
  await assertPrivateDirectory(sourceRoot);
  await mkdir(join(destinationRoot,"references"),{recursive:true,mode:0o700});
  await copyPrivateRegularFile(join(sourceRoot,"SKILL.md"),join(destinationRoot,"SKILL.md"));
  const sourceReferences=join(sourceRoot,"references");
  await assertPrivateDirectory(sourceReferences);
  const entries=await readdir(sourceReferences,{withFileTypes:true});
  for (const entry of entries) {
    if (entry.name.startsWith("._")) continue;
    if (entry.name.startsWith(".")||entry.name!==basename(entry.name)||
        !entry.isFile()||entry.isSymbolicLink()) {
      throw new Error("unsafe_skill");
    }
    await copyPrivateRegularFile(
      join(sourceReferences,entry.name),
      join(destinationRoot,"references",entry.name)
    );
  }
  await copyPrivateRegularFile(
    join(sourceReferences,"output-schema.json"),
    join(destinationRoot,"references","output-schema.json"),
    {allowExisting:true}
  );
}

async function copyPrivateRegularFile(source,destination,{allowExisting=false}={}) {
  const metadata=await lstat(source);
  if (!metadata.isFile()||metadata.isSymbolicLink()||
      metadata.uid!==process.getuid()||(metadata.mode&0o077)!==0) {
    throw new Error("unsafe_skill");
  }
  if (!allowExisting) await copyFile(source,destination);
  await chmod(destination,0o600);
}

async function ensurePrivateDirectory(path) {
  await mkdir(path,{recursive:true,mode:0o700});
  await chmod(path,0o700);
  await assertPrivateDirectory(path);
}

async function assertPrivateDirectory(path) {
  const metadata=await lstat(path);
  if (!metadata.isDirectory()||metadata.isSymbolicLink()||
      metadata.uid!==process.getuid()||(metadata.mode&0o077)!==0) {
    throw new Error("unsafe_directory");
  }
}

function validateCall(codexPath,skillRoot,tempRoot,input,timeoutMs) {
  if (![codexPath,skillRoot,tempRoot].every(value=>typeof value==="string"&&value)||
      !Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>300_000||
      !input||typeof input!=="object"||Array.isArray(input)||
      typeof input.request!=="string"||typeof input.sourceContent!=="string"||
      !Array.isArray(input.allowedLibraries)) {
    throw new Error("invalid_call");
  }
}

function runCodex(command,args,input,{cwd,timeoutMs,environment}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd,env:environment,stdio:["pipe","ignore","ignore"]});
    let settled=false;
    const timer=setTimeout(()=>{
      if (settled) return;
      settled=true;
      child.kill("SIGKILL");
      reject(new Error("timeout"));
    },timeoutMs);
    child.once("error",error=>{
      if (settled) return;
      settled=true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit",code=>{
      if (settled) return;
      settled=true;
      clearTimeout(timer);
      code===0?resolve():reject(new Error("codex_failed"));
    });
    child.stdin.on("error",()=>{});
    child.stdin.end(input);
  });
}

async function readLimited(path,maxBytes) {
  const metadata=await lstat(path);
  if (!metadata.isFile()||metadata.isSymbolicLink()||
      metadata.uid!==process.getuid()||metadata.size<1||metadata.size>maxBytes) {
    throw new Error("invalid_output");
  }
  return readFile(path,"utf8");
}
