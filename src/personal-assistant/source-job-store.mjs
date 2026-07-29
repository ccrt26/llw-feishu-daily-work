import {createHash,randomBytes,randomUUID} from "node:crypto";
import {
  chmod,lstat,mkdir,open,readFile,readdir,rename,rm
} from "node:fs/promises";
import {isAbsolute,join} from "node:path";

const DEFAULT_TTL_MS=86_400_000;
const ID=/^[A-Za-z0-9_-]{43}$/u;
const INTERRUPTED=new Set(["preparing","running_ai","writing"]);
const TERMINAL=new Set(["completed","cancelled","expired"]);
const TRANSITIONS=new Map([
  ["queued",new Set(["preparing","failed","cancelled","expired"])],
  ["preparing",new Set(["ready","failed","cancelled","expired"])],
  ["ready",new Set(["running_ai","failed","cancelled","expired"])],
  [
    "running_ai",
    new Set([
      "awaiting_clarification","writing","completed",
      "failed","cancelled","expired"
    ])
  ],
  ["awaiting_clarification",new Set(["ready","cancelled","expired"])],
  ["writing",new Set(["completed","failed","cancelled","expired"])],
  ["failed",new Set(["queued","cancelled","expired"])],
  ["completed",new Set()],
  ["cancelled",new Set()],
  ["expired",new Set()]
]);

export function isPreparedSourceSetId(value) {
  return typeof value==="string"&&ID.test(value);
}

export class SourceJobStore {
  constructor({
    root,ttlMs=DEFAULT_TTL_MS,now=Date.now
  }) {
    if (typeof root!=="string"||!isAbsolute(root)||
        !Number.isSafeInteger(ttlMs)||ttlMs<1||
        ttlMs>DEFAULT_TTL_MS||typeof now!=="function") {
      throw new Error("source_job_store_invalid");
    }
    this.root=root;
    this.ttlMs=ttlMs;
    this.now=now;
  }

  async create({
    source,userId,conversationId,messageKeys,createdAt
  }) {
    validateBinding({source,userId,conversationId});
    if (!Array.isArray(messageKeys)||messageKeys.length<1||
        messageKeys.length>16||
        messageKeys.some(value=>!bounded(value,1_024))||
        !canonicalIso(createdAt)) {
      throw new Error("source_job_invalid");
    }
    await ensurePrivateRoot(this.root);
    const preparedSourceSetId=randomBytes(32).toString("base64url");
    const workspaceDir=this.workspace(preparedSourceSetId);
    await mkdir(workspaceDir,{mode:0o700});
    await chmod(workspaceDir,0o700);
    const now=this.now();
    if (!Number.isSafeInteger(now)||now<0) {
      throw new Error("source_job_invalid");
    }
    const job={
      version:1,
      preparedSourceSetId,
      bindingDigest:bindingDigest({source,userId,conversationId}),
      messageKeyDigests:messageKeys.map(value=>digest(value)),
      state:"queued",
      createdAt,
      updatedAt:new Date(now).toISOString(),
      expiresAt:new Date(now+this.ttlMs).toISOString(),
      cancelRequested:false,
      checkpoints:{},
      failure:null
    };
    await this.write(job);
    return Object.freeze({preparedSourceSetId,workspaceDir});
  }

  async get(binding) {
    validateAccess(binding);
    const job=await this.read(binding.preparedSourceSetId);
    verifyBinding(job,binding);
    const now=this.now();
    if (now>Date.parse(job.expiresAt)) {
      await rm(this.workspace(binding.preparedSourceSetId),{
        recursive:true,force:true
      });
      throw new Error("source_job_expired");
    }
    return publicJob(job,this.workspace(binding.preparedSourceSetId));
  }

  async transition({
    preparedSourceSetId,source,userId,conversationId,
    from,to,patch={}
  }) {
    const binding={
      preparedSourceSetId,source,userId,conversationId
    };
    const job=await this.boundJob(binding);
    if (job.state!==from||!TRANSITIONS.get(from)?.has(to)||
        !plainPatch(patch)||
        (from==="failed"&&to==="queued"&&
          job.failure?.recoverable!==true)) {
      throw new Error("source_job_transition_invalid");
    }
    job.state=to;
    job.updatedAt=this.nowIso();
    if (Object.hasOwn(patch,"failure")) {
      job.failure=validateFailure(patch.failure);
    } else if (to!=="failed") {
      job.failure=null;
    }
    if (TERMINAL.has(to)) job.cancelRequested=to==="cancelled";
    await this.write(job);
    return publicJob(job,this.workspace(preparedSourceSetId));
  }

  async requestCancel(binding) {
    const job=await this.boundJob(binding);
    if (TERMINAL.has(job.state)) {
      return publicJob(job,this.workspace(job.preparedSourceSetId));
    }
    job.cancelRequested=true;
    job.updatedAt=this.nowIso();
    await this.write(job);
    return publicJob(job,this.workspace(job.preparedSourceSetId));
  }

  async checkpoint({
    preparedSourceSetId,source,userId,conversationId,name,value
  }) {
    const binding={
      preparedSourceSetId,source,userId,conversationId
    };
    const job=await this.boundJob(binding);
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(name||"")||
        !safeCheckpoint(value)) {
      throw new Error("source_job_checkpoint_invalid");
    }
    job.checkpoints[name]=structuredClone(value);
    job.updatedAt=this.nowIso();
    await this.write(job);
    return publicJob(job,this.workspace(preparedSourceSetId));
  }

  async complete(binding) {
    const job=await this.boundJob(binding);
    if (!new Set(["running_ai","writing","completed"]).has(job.state)) {
      throw new Error("source_job_transition_invalid");
    }
    if (job.state!=="completed") {
      job.state="completed";
      job.updatedAt=this.nowIso();
      await this.write(job);
    }
    await rm(this.workspace(job.preparedSourceSetId),{
      recursive:true,force:true
    });
  }

  async recoverInterrupted() {
    await ensurePrivateRoot(this.root);
    const names=await readdir(this.root);
    let recovered=0;
    for (const name of names) {
      if (!isPreparedSourceSetId(name)) continue;
      let job;
      try {
        job=await this.read(name);
      } catch {
        continue;
      }
      if (this.now()>Date.parse(job.expiresAt)) {
        await rm(this.workspace(name),{recursive:true,force:true});
        continue;
      }
      if (!INTERRUPTED.has(job.state)) continue;
      job.state="failed";
      job.failure={code:"source_job_interrupted",recoverable:true};
      job.updatedAt=this.nowIso();
      await this.write(job);
      recovered+=1;
    }
    return recovered;
  }

  async cleanupExpired() {
    await ensurePrivateRoot(this.root);
    const names=await readdir(this.root);
    let removed=0;
    for (const name of names) {
      if (!isPreparedSourceSetId(name)) continue;
      let job;
      try {
        job=await this.read(name);
      } catch {
        continue;
      }
      if (this.now()<=Date.parse(job.expiresAt)) continue;
      await rm(this.workspace(name),{recursive:true,force:true});
      removed+=1;
    }
    return removed;
  }

  async boundJob(binding) {
    validateAccess(binding);
    const job=await this.read(binding.preparedSourceSetId);
    verifyBinding(job,binding);
    if (this.now()>Date.parse(job.expiresAt)) {
      await rm(this.workspace(job.preparedSourceSetId),{
        recursive:true,force:true
      });
      throw new Error("source_job_expired");
    }
    return job;
  }

  workspace(id) {
    if (!isPreparedSourceSetId(id)) throw new Error("source_job_invalid");
    return join(this.root,id);
  }

  async read(id) {
    const file=join(this.workspace(id),"job.json");
    const info=await lstat(file);
    if (!info.isFile()||info.isSymbolicLink()||
        info.uid!==process.getuid()||(info.mode&0o077)!==0) {
      throw new Error("source_job_invalid");
    }
    const job=JSON.parse(await readFile(file,"utf8"));
    validateStoredJob(job);
    if (job.preparedSourceSetId!==id) throw new Error("source_job_invalid");
    return job;
  }

  async write(job) {
    validateStoredJob(job);
    const directory=this.workspace(job.preparedSourceSetId);
    const file=join(directory,"job.json");
    const temporary=join(directory,`.job-${randomUUID()}.tmp`);
    const handle=await open(temporary,"wx",0o600);
    try {
      await handle.writeFile(`${JSON.stringify(job)}\n`,"utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary,file);
    await chmod(file,0o600);
  }

  nowIso() {
    const now=this.now();
    if (!Number.isSafeInteger(now)||now<0) {
      throw new Error("source_job_invalid");
    }
    return new Date(now).toISOString();
  }
}

function validateStoredJob(job) {
  const fields=new Set([
    "version","preparedSourceSetId","bindingDigest",
    "messageKeyDigests","state","createdAt","updatedAt","expiresAt",
    "cancelRequested","checkpoints","failure"
  ]);
  if (!job||typeof job!=="object"||Array.isArray(job)||
      Object.keys(job).length!==fields.size||
      Object.keys(job).some(key=>!fields.has(key))||
      job.version!==1||!isPreparedSourceSetId(job.preparedSourceSetId)||
      !/^[a-f0-9]{64}$/u.test(job.bindingDigest||"")||
      !Array.isArray(job.messageKeyDigests)||
      job.messageKeyDigests.length<1||job.messageKeyDigests.length>16||
      job.messageKeyDigests.some(value=>!/^[a-f0-9]{64}$/u.test(value))||
      !TRANSITIONS.has(job.state)||!canonicalIso(job.createdAt)||
      !canonicalIso(job.updatedAt)||!canonicalIso(job.expiresAt)||
      Date.parse(job.updatedAt)>Date.parse(job.expiresAt)||
      typeof job.cancelRequested!=="boolean"||
      !job.checkpoints||typeof job.checkpoints!=="object"||
      Array.isArray(job.checkpoints)||Object.keys(job.checkpoints).length>32||
      Object.entries(job.checkpoints).some(([name,value])=>
        !/^[a-z][a-z0-9_]{0,63}$/u.test(name)||!safeCheckpoint(value)
      )||
      !(job.failure===null||validFailure(job.failure))) {
    throw new Error("source_job_invalid");
  }
}

function validateAccess(binding) {
  validateBinding(binding);
  if (!isPreparedSourceSetId(binding.preparedSourceSetId)) {
    throw new Error("source_job_invalid");
  }
}

function validateBinding({source,userId,conversationId}) {
  if (!new Set(["feishu","wechat"]).has(source)||
      !bounded(userId,512)||!bounded(conversationId,512)) {
    throw new Error("source_job_invalid");
  }
}

function verifyBinding(job,binding) {
  if (job.bindingDigest!==bindingDigest(binding)) {
    throw new Error("source_job_binding_mismatch");
  }
}

function bindingDigest({source,userId,conversationId}) {
  return digest(`${source}\0${userId}\0${conversationId}`);
}

function digest(value) {
  return createHash("sha256").update(value,"utf8").digest("hex");
}

function publicJob(job,workspaceDir) {
  return Object.freeze({
    ...structuredClone(job),workspaceDir
  });
}

function plainPatch(value) {
  return value&&typeof value==="object"&&!Array.isArray(value)&&
    Object.keys(value).every(key=>key==="failure");
}

function validateFailure(value) {
  if (!validFailure(value)) throw new Error("source_job_transition_invalid");
  return structuredClone(value);
}

function validFailure(value) {
  return value&&typeof value==="object"&&!Array.isArray(value)&&
    Object.keys(value).length===2&&
    typeof value.code==="string"&&
    /^[a-z][a-z0-9_]{0,63}$/u.test(value.code)&&
    typeof value.recoverable==="boolean";
}

function safeCheckpoint(value) {
  try {
    const text=JSON.stringify(value);
    return text!==undefined&&Buffer.byteLength(text,"utf8")<=4_096&&
      !containsAbsolutePath(value);
  } catch {
    return false;
  }
}

function containsAbsolutePath(value) {
  if (typeof value==="string") return isAbsolute(value);
  if (Array.isArray(value)) return value.some(containsAbsolutePath);
  if (value&&typeof value==="object") {
    return Object.values(value).some(containsAbsolutePath);
  }
  return false;
}

function canonicalIso(value) {
  return typeof value==="string"&&Number.isFinite(Date.parse(value))&&
    new Date(value).toISOString()===value;
}

function bounded(value,max) {
  return typeof value==="string"&&value.length>0&&
    Buffer.byteLength(value,"utf8")<=max;
}

async function ensurePrivateRoot(root) {
  await mkdir(root,{recursive:true,mode:0o700});
  const info=await lstat(root);
  if (!info.isDirectory()||info.isSymbolicLink()||
      info.uid!==process.getuid()) {
    throw new Error("source_job_store_invalid");
  }
  await chmod(root,0o700);
}
