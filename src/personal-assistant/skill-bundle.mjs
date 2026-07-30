import {createHash} from "node:crypto";
import {lstat,open,realpath} from "node:fs/promises";
import {isAbsolute,join,relative,resolve} from "node:path";

const SHA=/^[a-f0-9]{64}$/u;
const RUNTIME_PATH=
  /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/u;
const DEFAULT_MAX_FILE_BYTES=256*1024;
const DEFAULT_MAX_BUNDLE_BYTES=512*1024;
const UTF8=new TextDecoder("utf-8",{fatal:true});

export async function loadPersonalAssistantSkillBundle(options) {
  try {
    return await load(options);
  } catch (error) {
    if (error?.message==="assistant_skill_invalid") throw error;
    throw invalid();
  }
}

async function load(options) {
  if (!plainObject(options)||
      Object.keys(options).some(key=>!new Set([
        "skillRoot","runtimeFiles","maxFileBytes","maxBundleBytes"
      ]).has(key))) {
    throw invalid();
  }
  const {
    skillRoot,runtimeFiles,
    maxFileBytes=DEFAULT_MAX_FILE_BYTES,
    maxBundleBytes=DEFAULT_MAX_BUNDLE_BYTES
  }=options;
  if (!isAbsolute(skillRoot)||
      !Number.isSafeInteger(maxFileBytes)||maxFileBytes<1||
      maxFileBytes>DEFAULT_MAX_FILE_BYTES||
      !Number.isSafeInteger(maxBundleBytes)||
      maxBundleBytes<maxFileBytes||
      maxBundleBytes>DEFAULT_MAX_BUNDLE_BYTES||
      !Array.isArray(runtimeFiles)||runtimeFiles.length<1||
      runtimeFiles.length>256) {
    throw invalid();
  }
  const rootInfo=await lstat(skillRoot);
  if (!rootInfo.isDirectory()||rootInfo.isSymbolicLink()||
      rootInfo.uid!==process.getuid()||(rootInfo.mode&0o077)!==0||
      (rootInfo.mode&0o500)!==0o500) {
    throw invalid();
  }
  const actualRoot=await realpath(skillRoot);
  if (actualRoot!==systemCanonical(resolve(skillRoot))) throw invalid();

  const seen=new Set();
  let previous="",totalBytes=0;
  const contents=[];
  for (const [index,item] of runtimeFiles.entries()) {
    if (!plainObject(item)||Object.keys(item).length!==2||
        typeof item.path!=="string"||!RUNTIME_PATH.test(item.path)||
        typeof item.sha256!=="string"||!SHA.test(item.sha256)||
        seen.has(item.path)||item.path<=previous||
        (index===0&&item.path!=="SKILL.md")) {
      throw invalid();
    }
    seen.add(item.path);
    previous=item.path;
    const file=join(actualRoot,...item.path.split("/"));
    const fromRoot=relative(actualRoot,file);
    if (fromRoot.startsWith("..")||isAbsolute(fromRoot)||
        resolve(actualRoot,fromRoot)!==file) {
      throw invalid();
    }
    const bytes=await readCheckedFile(file,maxFileBytes);
    if (sha256(bytes)!==item.sha256) throw invalid();
    totalBytes+=bytes.length;
    if (!Number.isSafeInteger(totalBytes)||
        totalBytes>maxBundleBytes) {
      throw invalid();
    }
    let content;
    try {
      content=UTF8.decode(bytes);
    } catch {
      throw invalid();
    }
    if (!content.trim()) throw invalid();
    contents.push(content);
  }
  const content=contents.join("\n\n");
  return Object.freeze({
    content,
    fileCount:runtimeFiles.length,
    totalBytes,
    sha256:sha256(Buffer.from(content,"utf8"))
  });
}

async function readCheckedFile(file,maxBytes) {
  const before=await lstat(file);
  if (!before.isFile()||before.isSymbolicLink()||
      before.uid!==process.getuid()||(before.mode&0o077)!==0||
      (before.mode&0o400)===0||before.size<1||
      before.size>maxBytes) {
    throw invalid();
  }
  const handle=await open(file,"r");
  try {
    const after=await handle.stat();
    if (!after.isFile()||after.uid!==process.getuid()||
        (after.mode&0o077)!==0||
        after.dev!==before.dev||after.ino!==before.ino||
        after.size!==before.size) {
      throw invalid();
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function plainObject(value) {
  return value&&typeof value==="object"&&!Array.isArray(value)&&
    Object.getPrototypeOf(value)===Object.prototype;
}

function systemCanonical(path) {
  if (process.platform!=="darwin") return path;
  if (path==="/var"||path.startsWith("/var/")) return `/private${path}`;
  if (path==="/tmp"||path.startsWith("/tmp/")) return `/private${path}`;
  return path;
}

function invalid() {
  return new Error("assistant_skill_invalid");
}
