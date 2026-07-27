import {spawn} from "node:child_process";
import {
  chmod,copyFile,lstat,mkdir,mkdtemp,readFile,readdir,rm
} from "node:fs/promises";
import {basename,join} from "node:path";
import {normalizeKnowledgeCandidate} from "./candidate-normalizer.mjs";
import {validateKnowledgeDecision} from "./decision-validator.mjs";

const REQUIRED_SKILL_NAME="llw-knowledge-ingest";
const MAX_OUTPUT_BYTES=256 * 1024;
const DECISION_FAILURE_CODES=new Set([
  "knowledge_decision_copy_failed",
  "knowledge_decision_spawn_failed",
  "knowledge_decision_timeout",
  "knowledge_decision_process_failed",
  "knowledge_decision_output_failed",
  "knowledge_decision_validation_failed"
]);

export async function invokeKnowledgeDecision({
  codexPath,skillRoot,tempRoot,input,timeoutMs=120_000,environment=process.env,
  maxAttempts=2,retryDelayMs=1_000
}) {
  let jobRoot;
  try {
    validateCall(codexPath,skillRoot,tempRoot,input,timeoutMs);
    let copiedSkill;
    try {
      await ensurePrivateDirectory(tempRoot);
      jobRoot=await mkdtemp(join(tempRoot,"knowledge-"));
      await chmod(jobRoot,0o700);
      copiedSkill=join(jobRoot,".agents","skills",REQUIRED_SKILL_NAME);
      await copySelectedSkill(skillRoot,copiedSkill);
    } catch {
      throw decisionFailure("knowledge_decision_copy_failed");
    }
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
      } catch (error) {
        if (error?.code!=="knowledge_decision_process_failed"||
            attempt===attempts) {
          throw withRetryCount(error,attempt-1);
        }
        if (delayMs) await delay(delayMs);
        continue;
      }
      let parsed;
      try {
        const raw=await readLimited(output,MAX_OUTPUT_BYTES);
        parsed=JSON.parse(raw);
      } catch {
        throw decisionFailure("knowledge_decision_output_failed");
      }
      try {
        const normalized=normalizeKnowledgeCandidate(parsed,{
          libraries:input.allowedLibraries,
          source:input.source,
          confirmedTarget:input.confirmedTarget||null
        });
        return validateKnowledgeDecision(normalized,{
          libraries:input.allowedLibraries
        });
      } catch {
        throw decisionFailure("knowledge_decision_validation_failed");
      }
    }
  } catch (error) {
    if (DECISION_FAILURE_CODES.has(error?.code)) throw sanitizeFailure(error);
    throw decisionFailure("knowledge_decision_validation_failed");
  } finally {
    if (jobRoot) await rm(jobRoot,{recursive:true,force:true}).catch(()=>{});
  }
}

function delay(milliseconds) {
  return new Promise(resolve=>setTimeout(resolve,milliseconds));
}

function decisionFailure(code,{stderrBytes,retryCount}={}) {
  const error=new Error("knowledge_decision_failed");
  error.code=code;
  if (Number.isSafeInteger(stderrBytes)&&stderrBytes>=0) {
    error.stderrBytes=stderrBytes;
  }
  if (Number.isSafeInteger(retryCount)&&retryCount>=0&&retryCount<=1) {
    error.retryCount=retryCount;
  }
  return error;
}

function sanitizeFailure(error) {
  return decisionFailure(error.code,{
    stderrBytes:error.stderrBytes,
    retryCount:error.retryCount
  });
}

function withRetryCount(error,retryCount) {
  if (!DECISION_FAILURE_CODES.has(error?.code)) return error;
  return decisionFailure(error.code,{
    stderrBytes:error.stderrBytes,
    retryCount
  });
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
    const child=spawn(command,args,{cwd,env:environment,stdio:["pipe","ignore","pipe"]});
    let settled=false,timedOut=false,stderrBytes=0;
    child.stderr.on("data",chunk=>{stderrBytes+=chunk.length;});
    const finish=error=>{
      if (settled) return;
      settled=true;
      error?reject(error):resolve();
    };
    const timer=setTimeout(()=>{
      if (settled) return;
      timedOut=true;
      child.kill("SIGKILL");
    },timeoutMs);
    child.once("error",()=>{
      clearTimeout(timer);
      finish(decisionFailure("knowledge_decision_spawn_failed"));
    });
    child.once("close",code=>{
      clearTimeout(timer);
      if (timedOut) {
        finish(decisionFailure("knowledge_decision_timeout",{stderrBytes}));
      } else if (code===0) {
        finish();
      } else {
        finish(decisionFailure("knowledge_decision_process_failed",{stderrBytes}));
      }
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
