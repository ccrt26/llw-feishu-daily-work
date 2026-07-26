import {createHash} from "node:crypto";
import {lstat,open,realpath} from "node:fs/promises";
import {isAbsolute,join,resolve} from "node:path";

const TOP_FIELDS=new Set(["manifest_version","skills"]);
const SKILL_FIELDS=new Set([
  "name","version","enabled","capability","semantic_tasks","model_support",
  "skill_sha256","routing_contract_sha256","output_schema_sha256"
]);
const ALLOW_FIELDS=new Set([
  "name","capability","versions","semanticTasks","modelSupport","enabled"
]);
const MODELS=new Set(["codex","deepseek"]);
const NAME=/^[a-z][a-z0-9-]{0,63}$/;
const TASK=/^[a-z][a-z0-9.-]{0,127}$/;
const VERSION=/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA=/^[0-9a-f]{64}$/;
const MAX_MANIFEST_BYTES=256 * 1024;

export async function loadPrivateSkillManifest(options) {
  try { return await load(options); }
  catch { throw new Error("private_skill_manifest_invalid"); }
}

async function load(options) {
  exact(options,new Set(["root","manifestPath","expectedManifestSha256","allowlist"]));
  const {root,manifestPath,expectedManifestSha256,allowlist}=options;
  fail(!isAbsolute(root)||!isAbsolute(manifestPath)||!SHA.test(expectedManifestSha256));
  fail(resolve(manifestPath)!==resolve(join(root,"manifest.json")));
  const expectedUid=process.getuid();
  const rootReal=await validateDirectory(root,expectedUid);
  const expectedReal=systemCanonical(resolve(root));
  fail(rootReal!==expectedReal);

  const manifestBytes=await readPrivateFile(manifestPath,expectedUid,{maxBytes:MAX_MANIFEST_BYTES});
  const manifestSha256=sha256(manifestBytes);
  fail(manifestSha256!==expectedManifestSha256);
  const manifest=parseJson(manifestBytes);
  validateManifestShape(manifest);
  const allowed=validateAllowlist(allowlist);
  fail(manifest.skills.length!==allowed.size);

  const names=new Set();
  const skills=[];
  for (const entry of manifest.skills) {
    fail(names.has(entry.name));
    names.add(entry.name);
    const policy=allowed.get(entry.name);
    fail(!policy);
    fail(entry.capability!==policy.capability);
    fail(!policy.versions.includes(entry.version));
    fail(entry.enabled!==policy.enabled);
    fail(!same(entry.semantic_tasks,policy.semanticTasks));
    fail(!same(entry.model_support,policy.modelSupport));

    const skillRoot=join(rootReal,entry.name);
    fail(resolve(skillRoot)!==skillRoot||!inside(rootReal,skillRoot));
    await validateDirectory(skillRoot,expectedUid);
    await validateHashReference(join(skillRoot,"SKILL.md"),entry.skill_sha256,expectedUid);
    const references=join(skillRoot,"references");
    if (entry.routing_contract_sha256!==null||entry.output_schema_sha256!==null) {
      await validateDirectory(references,expectedUid);
    }
    await validateHashReference(
      join(references,"routing-contract.json"),
      entry.routing_contract_sha256,
      expectedUid
    );
    await validateHashReference(
      join(references,"output-schema.json"),
      entry.output_schema_sha256,
      expectedUid
    );
    skills.push({
      name:entry.name,
      version:entry.version,
      enabled:entry.enabled,
      capability:entry.capability,
      semanticTasks:[...entry.semantic_tasks],
      modelSupport:[...entry.model_support],
      root:skillRoot
    });
  }
  fail(names.size!==allowed.size);
  return {manifestVersion:1,manifestSha256,skills};
}

function validateManifestShape(value) {
  exact(value,TOP_FIELDS);
  fail(value.manifest_version!==1);
  fail(!Array.isArray(value.skills)||value.skills.length<1||value.skills.length>64);
  for (const entry of value.skills) {
    exact(entry,SKILL_FIELDS);
    fail(typeof entry.name!=="string"||!NAME.test(entry.name));
    fail(typeof entry.version!=="string"||!VERSION.test(entry.version));
    fail(typeof entry.enabled!=="boolean");
    fail(typeof entry.capability!=="string"||!NAME.test(entry.capability));
    validateStringArray(entry.semantic_tasks,TASK,1,32);
    validateStringArray(entry.model_support,MODELS,1,2);
    fail(typeof entry.skill_sha256!=="string"||!SHA.test(entry.skill_sha256));
    validateOptionalHash(entry.routing_contract_sha256);
    validateOptionalHash(entry.output_schema_sha256);
  }
}

function validateAllowlist(value) {
  fail(!Array.isArray(value)||value.length<1||value.length>64);
  const result=new Map();
  for (const policy of value) {
    exact(policy,ALLOW_FIELDS);
    fail(typeof policy.name!=="string"||!NAME.test(policy.name)||result.has(policy.name));
    fail(typeof policy.capability!=="string"||!NAME.test(policy.capability));
    validateStringArray(policy.versions,VERSION,1,16);
    validateStringArray(policy.semanticTasks,TASK,1,32);
    validateStringArray(policy.modelSupport,MODELS,1,2);
    fail(typeof policy.enabled!=="boolean");
    result.set(policy.name,structuredClone(policy));
  }
  return result;
}

async function validateDirectory(path,expectedUid) {
  const metadata=await lstat(path);
  fail(!metadata.isDirectory()||metadata.isSymbolicLink());
  fail(metadata.uid!==expectedUid||(metadata.mode&0o077)!==0);
  fail((metadata.mode&0o500)!==0o500);
  const canonical=await realpath(path);
  fail(canonical!==systemCanonical(resolve(path)));
  return canonical;
}

async function validateHashReference(path,expectedHash,expectedUid) {
  if (expectedHash===null) {
    try { await lstat(path); fail(true); }
    catch (error) { if (error?.code!=="ENOENT") throw error; }
    return;
  }
  fail(typeof expectedHash!=="string"||!SHA.test(expectedHash));
  const digest=await hashPrivateFile(path,expectedUid);
  fail(digest!==expectedHash);
}

async function readPrivateFile(path,expectedUid,{maxBytes=Number.MAX_SAFE_INTEGER}={}) {
  const {handle,metadata}=await openCheckedFile(path,expectedUid);
  try {
    fail(metadata.size>maxBytes);
    return await handle.readFile();
  } finally { await handle.close(); }
}

async function hashPrivateFile(path,expectedUid) {
  const {handle}=await openCheckedFile(path,expectedUid);
  const digest=createHash("sha256");
  const buffer=Buffer.allocUnsafe(64 * 1024);
  let position=0;
  try {
    while (true) {
      const {bytesRead}=await handle.read(buffer,0,buffer.length,position);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0,bytesRead));
      position+=bytesRead;
    }
    return digest.digest("hex");
  } finally { await handle.close(); }
}

async function openCheckedFile(path,expectedUid) {
  const before=await lstat(path);
  fail(!before.isFile()||before.isSymbolicLink());
  fail(before.uid!==expectedUid||(before.mode&0o077)!==0||(before.mode&0o400)===0);
  const handle=await open(path,"r");
  try {
    const after=await handle.stat();
    fail(!after.isFile()||after.uid!==expectedUid||(after.mode&0o077)!==0);
    fail(after.dev!==before.dev||after.ino!==before.ino);
    return {handle,metadata:after};
  } catch (error) {
    await handle.close().catch(()=>{});
    throw error;
  }
}

function validateStringArray(value,matcher,min,max) {
  fail(!Array.isArray(value)||value.length<min||value.length>max);
  fail(new Set(value).size!==value.length);
  for (const item of value) {
    fail(typeof item!=="string");
    fail(matcher instanceof Set?!matcher.has(item):!matcher.test(item));
  }
}

function validateOptionalHash(value) { fail(value!==null&&(typeof value!=="string"||!SHA.test(value))); }
function parseJson(bytes) { try { return JSON.parse(bytes.toString("utf8")); } catch { fail(true); } }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function same(left,right) { return left.length===right.length&&left.every((value,index)=>value===right[index]); }
function inside(root,path) { return path.startsWith(`${root}/`); }
function systemCanonical(path) {
  if (process.platform!=="darwin") return path;
  if (path==="/var"||path.startsWith("/var/")) return `/private${path}`;
  if (path==="/tmp"||path.startsWith("/tmp/")) return `/private${path}`;
  return path;
}
function exact(value,fields) {
  fail(!value||typeof value!=="object"||Array.isArray(value));
  const keys=Object.keys(value);
  fail(keys.length!==fields.size||keys.some(key=>!fields.has(key)));
}
function fail(condition) { if (condition) throw new Error("invalid"); }
