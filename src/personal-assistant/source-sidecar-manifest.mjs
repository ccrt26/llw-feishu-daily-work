import {createHash,randomUUID} from "node:crypto";
import {createReadStream} from "node:fs";
import {
  chmod,lstat,open,readFile,rename,realpath
} from "node:fs/promises";
import {isAbsolute,join,relative,resolve} from "node:path";

const SOURCE_ID=/^source-00[1-8]$/u;
const DERIVED_KINDS=new Set([
  "probe","subtitle","transcript","timeline","navigation","inspection"
]);

export async function createSourceSidecarManifest({
  workspaceDir,original,now
}) {
  validateWorkspaceArgument(workspaceDir);
  validateOriginal(original);
  if (!canonicalIso(now)) throw new Error("source_sidecar_invalid");
  await validatePrivateWorkspace(workspaceDir);
  const manifestPath=join(
    workspaceDir,`${original.sourceId}.manifest.json`
  );
  const manifest={
    version:1,
    original:structuredClone(original),
    derived:[],
    createdAt:now,
    updatedAt:now
  };
  await atomicWrite(manifestPath,manifest);
  return manifestPath;
}

export async function appendDerivedRepresentation({
  workspaceDir,manifestPath,entry,now
}) {
  validateWorkspaceArgument(workspaceDir);
  if (!canonicalIso(now)||!isAbsolute(manifestPath)) {
    throw new Error("source_sidecar_invalid");
  }
  const actualWorkspace=await validatePrivateWorkspace(workspaceDir);
  const manifest=JSON.parse(await readFile(manifestPath,"utf8"));
  validateManifest(manifest);
  const actualManifest=await realpath(manifestPath);
  if (resolve(
    actualWorkspace,`${manifest.original.sourceId}.manifest.json`
  )!==actualManifest) {
    throw new Error("source_sidecar_invalid");
  }
  validateDerivedInput(entry,manifest.original.sourceId);
  const derivedFile=join(actualWorkspace,entry.relativePath);
  await validatePrivateFile(actualWorkspace,derivedFile);
  const next={
    kind:entry.kind,
    relativePath:entry.relativePath,
    sha256:await sha256(derivedFile),
    producedBy:entry.producedBy,
    createdAt:now,
    limitations:[...entry.limitations]
  };
  if (manifest.derived.some(item=>
    item.relativePath===next.relativePath
  )) {
    throw new Error("source_sidecar_invalid");
  }
  manifest.derived.push(next);
  manifest.updatedAt=now;
  validateManifest(manifest);
  await atomicWrite(manifestPath,manifest);
  return structuredClone(next);
}

function validateOriginal(value) {
  if (!value||typeof value!=="object"||Array.isArray(value)||
      Object.keys(value).length!==6||
      !SOURCE_ID.test(value.sourceId||"")||
      !safeRelative(value.relativePath)||
      !value.relativePath.startsWith(`${value.sourceId}.`)||
      !Number.isSafeInteger(value.byteSize)||value.byteSize<1||
      !/^[a-f0-9]{64}$/u.test(value.sha256||"")||
      typeof value.mime!=="string"||
      !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u.test(value.mime)||
      !Number.isSafeInteger(value.durationMs)||value.durationMs<1) {
    throw new Error("source_sidecar_invalid");
  }
}

function validateDerivedInput(value,sourceId) {
  if (!value||typeof value!=="object"||Array.isArray(value)||
      Object.keys(value).length!==4||
      !DERIVED_KINDS.has(value.kind)||
      !safeRelative(value.relativePath)||
      !value.relativePath.startsWith(`${sourceId}.`)||
      typeof value.producedBy!=="string"||
      !/^[A-Za-z0-9._-]{1,128}$/u.test(value.producedBy)||
      !safeLimitations(value.limitations)) {
    throw new Error("source_sidecar_invalid");
  }
}

function validateManifest(value) {
  if (!value||typeof value!=="object"||Array.isArray(value)||
      value.version!==1||!Array.isArray(value.derived)||
      value.derived.length>32||!canonicalIso(value.createdAt)||
      !canonicalIso(value.updatedAt)||
      Date.parse(value.updatedAt)<Date.parse(value.createdAt)) {
    throw new Error("source_sidecar_invalid");
  }
  validateOriginal(value.original);
  for (const item of value.derived) {
    if (!item||typeof item!=="object"||Array.isArray(item)||
        Object.keys(item).length!==6||
        !DERIVED_KINDS.has(item.kind)||
        !safeRelative(item.relativePath)||
        !item.relativePath.startsWith(`${value.original.sourceId}.`)||
        !/^[a-f0-9]{64}$/u.test(item.sha256||"")||
        typeof item.producedBy!=="string"||
        !/^[A-Za-z0-9._-]{1,128}$/u.test(item.producedBy)||
        !canonicalIso(item.createdAt)||
        !safeLimitations(item.limitations)) {
      throw new Error("source_sidecar_invalid");
    }
  }
}

function safeLimitations(value) {
  return Array.isArray(value)&&value.length<=8&&
    value.every(item=>
      typeof item==="string"&&item.length>0&&
      Buffer.byteLength(item,"utf8")<=1_000
    );
}

function safeRelative(value) {
  return typeof value==="string"&&value.length>0&&!isAbsolute(value)&&
    !value.split("/").includes("..")&&
    !value.includes("\\")&&!value.includes("\0")&&
    /^[A-Za-z0-9._-]+$/u.test(value);
}

async function validatePrivateWorkspace(workspaceDir) {
  const info=await lstat(workspaceDir);
  if (!info.isDirectory()||info.isSymbolicLink()||
      info.uid!==process.getuid()||(info.mode&0o077)!==0) {
    throw new Error("source_sidecar_invalid");
  }
  return realpath(workspaceDir);
}

async function validatePrivateFile(workspaceDir,file) {
  const info=await lstat(file);
  const actual=await realpath(file);
  const inside=relative(workspaceDir,actual);
  if (!info.isFile()||info.isSymbolicLink()||
      info.uid!==process.getuid()||(info.mode&0o077)!==0||
      inside.startsWith("..")||isAbsolute(inside)) {
    throw new Error("source_sidecar_invalid");
  }
}

async function atomicWrite(file,value) {
  const temporary=`${file}.${randomUUID()}.tmp`;
  const handle=await open(temporary,"wx",0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value,null,2)}\n`,"utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary,file);
  await chmod(file,0o600);
}

async function sha256(file) {
  const hash=createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function validateWorkspaceArgument(value) {
  if (typeof value!=="string"||!isAbsolute(value)) {
    throw new Error("source_sidecar_invalid");
  }
}

function canonicalIso(value) {
  return typeof value==="string"&&Number.isFinite(Date.parse(value))&&
    new Date(value).toISOString()===value;
}
