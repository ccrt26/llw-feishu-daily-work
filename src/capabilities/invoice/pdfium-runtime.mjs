import {execFile} from "node:child_process";
import {createHash,randomUUID} from "node:crypto";
import {copyFile,lstat,mkdir,readFile,readdir,rename,rm,writeFile} from "node:fs/promises";
import {basename,dirname,join,relative,resolve,sep} from "node:path";
import {promisify} from "node:util";

const run=promisify(execFile);

const SOURCE_DIRECTORIES=new Set(["pypdfium2","pypdfium2_raw","pypdfium2_cfg"]);
const MANIFEST_FIELDS=new Set(["version","pypdfium2Version","pdfiumVersion","files"]);
const FILE_FIELDS=new Set(["path","sha256"]);

export async function installPdfiumRuntime({sourceRoot,licenseRoot,processorSource,destinationRoot}) {
  const source=resolve(sourceRoot),licenses=resolve(licenseRoot),processor=resolve(processorSource),destination=resolve(destinationRoot);
  await requireDirectory(source,"unsafe_pdfium_source");
  await requireDirectory(licenses,"unsafe_pdfium_source");
  await requireFile(processor,"unsafe_pdfium_source");
  try { await lstat(destination); throw unsafe("unsafe_pdfium_destination"); }
  catch (error) { if (error?.code!=="ENOENT") throw error; }
  const versions=await readVersions(source,"unsafe_pdfium_source");
  const sourceFiles=await collectSourceFiles(source);
  const licenseFiles=[];
  await walk(licenses,licenseFiles,{source:true});
  if (licenseFiles.length<1) throw unsafe("unsafe_pdfium_source");
  const parent=dirname(destination);
  await mkdir(parent,{recursive:true,mode:0o700});
  const staging=join(parent,`.${basename(destination)}.staging-${randomUUID()}`);
  try {
    await mkdir(staging,{recursive:false,mode:0o700});
    const files=[];
    for (const sourceFile of sourceFiles) {
      const relativePath=relative(source,sourceFile),target=join(staging,relativePath);
      await mkdir(dirname(target),{recursive:true,mode:0o700});
      await copyFile(sourceFile,target);
      await setPrivateMode(target,0o600);
      files.push({path:relativePath,sha256:await sha256(target)});
    }
    for (const sourceFile of licenseFiles.sort()) {
      const relativePath=join("licenses",relative(licenses,sourceFile)),target=join(staging,relativePath);
      await mkdir(dirname(target),{recursive:true,mode:0o700});
      await copyFile(sourceFile,target);
      await setPrivateMode(target,0o600);
      files.push({path:relativePath,sha256:await sha256(target)});
    }
    const processorTarget=join(staging,"pdfium-processor.py");
    await copyFile(processor,processorTarget);
    await setPrivateMode(processorTarget,0o700);
    files.push({path:"pdfium-processor.py",sha256:await sha256(processorTarget)});
    files.sort((left,right)=>left.path.localeCompare(right.path,"en"));
    const manifest={
      version:1,
      pypdfium2Version:versions.pypdfium2Version,
      pdfiumVersion:versions.pdfiumVersion,
      files
    };
    const manifestFile=join(staging,"runtime-manifest.json");
    await writeFile(manifestFile,`${JSON.stringify(manifest,null,2)}\n`,{encoding:"utf8",mode:0o600,flag:"wx"});
    await setPrivateMode(manifestFile,0o600);
    await rename(staging,destination);
    const pdfProcessorPath=join(destination,"pdfium-processor.py");
    await validatePdfiumRuntime(pdfProcessorPath);
    return {pdfProcessorPath,manifest};
  } catch (error) {
    await rm(staging,{recursive:true,force:true}).catch(()=>{});
    throw error;
  }
}

export async function validatePdfiumRuntime(pdfProcessorPath) {
  try {
    const processor=resolve(pdfProcessorPath),root=dirname(processor);
    if (basename(processor)!=="pdfium-processor.py") throw unsafe("unsafe_pdfium_runtime");
    await requirePrivateDirectory(root,"unsafe_pdfium_runtime");
    await requirePrivateFile(processor,0o700,"unsafe_pdfium_runtime");
    const manifestFile=join(root,"runtime-manifest.json");
    await requirePrivateFile(manifestFile,0o600,"unsafe_pdfium_runtime");
    const manifest=JSON.parse(await readFile(manifestFile,"utf8"));
    validateManifest(manifest);
    const versions=await readVersions(root,"unsafe_pdfium_runtime");
    if (versions.pypdfium2Version!==manifest.pypdfium2Version||versions.pdfiumVersion!==manifest.pdfiumVersion) throw unsafe("unsafe_pdfium_runtime");
    const actual=await collectInstalledFiles(root);
    const expected=new Map(manifest.files.map(item=>[item.path,item.sha256]));
    if (actual.length!==expected.size) throw unsafe("unsafe_pdfium_runtime");
    for (const file of actual) {
      const relativePath=relative(root,file);
      if (!expected.has(relativePath)) throw unsafe("unsafe_pdfium_runtime");
      const mode=relativePath==="pdfium-processor.py"?0o700:0o600;
      await requirePrivateFile(file,mode,"unsafe_pdfium_runtime");
      if (await sha256(file)!==expected.get(relativePath)) throw unsafe("unsafe_pdfium_runtime");
    }
    const {stdout,stderr}=await run(processor,["--self-check"],{
      cwd:root,
      env:{...process.env,PYTHONDONTWRITEBYTECODE:"1"},
      encoding:"buffer",
      timeout:10_000,
      maxBuffer:1024
    });
    if (stdout.length!==0||stderr.length!==0) throw unsafe("unsafe_pdfium_runtime");
    return structuredClone(manifest);
  } catch (error) {
    if (error?.message==="unsafe_pdfium_runtime") throw error;
    throw unsafe("unsafe_pdfium_runtime");
  }
}

async function collectSourceFiles(root) {
  const entries=await readdir(root,{withFileTypes:true});
  if (entries.some(entry=>!entry.isDirectory()||entry.isSymbolicLink()||!SOURCE_DIRECTORIES.has(entry.name))) throw unsafe("unsafe_pdfium_source");
  const files=[];
  for (const directory of [...SOURCE_DIRECTORIES].sort()) await walk(join(root,directory),files,{source:true});
  if (!files.some(file=>relative(root,file)==="pypdfium2_raw/libpdfium.dylib")) throw unsafe("unsafe_pdfium_source");
  return files.sort();
}

async function collectInstalledFiles(root) {
  const files=[];
  for (const entry of await readdir(root,{withFileTypes:true})) {
    if (entry.name==="runtime-manifest.json") continue;
    if (entry.isSymbolicLink()) throw unsafe("unsafe_pdfium_runtime");
    const path=join(root,entry.name);
    if (entry.isDirectory()) await walk(path,files,{source:false});
    else if (entry.isFile()) files.push(path);
    else throw unsafe("unsafe_pdfium_runtime");
  }
  return files.sort();
}

async function walk(directory,files,{source}) {
  const info=await lstat(directory);
  if (!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid()) throw unsafe(source?"unsafe_pdfium_source":"unsafe_pdfium_runtime");
  if (!source&&(info.mode&0o777)!==0o700) throw unsafe("unsafe_pdfium_runtime");
  for (const entry of await readdir(directory,{withFileTypes:true})) {
    if (entry.name==="__pycache__"||entry.name.endsWith(".pyc")) continue;
    if (entry.isSymbolicLink()) throw unsafe(source?"unsafe_pdfium_source":"unsafe_pdfium_runtime");
    const path=join(directory,entry.name);
    if (entry.isDirectory()) await walk(path,files,{source});
    else if (entry.isFile()) files.push(path);
    else throw unsafe(source?"unsafe_pdfium_source":"unsafe_pdfium_runtime");
  }
}

async function readVersions(root,code) {
  try {
    const helper=JSON.parse(await readFile(join(root,"pypdfium2","version.json"),"utf8"));
    const native=JSON.parse(await readFile(join(root,"pypdfium2_raw","version.json"),"utf8"));
    const pypdfium2Version=`${helper.major}.${helper.minor}.${helper.patch}`;
    const pdfiumVersion=`${native.major}.${native.minor}.${native.build}.${native.patch}`;
    if (pypdfium2Version!=="5.11.0"||native.origin!=="pdfium-binaries"||!Array.isArray(native.flags)||native.flags.length!==0) throw unsafe(code);
    return {pypdfium2Version,pdfiumVersion};
  } catch (error) {
    if (error?.message===code) throw error;
    throw unsafe(code);
  }
}

function validateManifest(value) {
  if (!value||typeof value!=="object"||Array.isArray(value)||
      Object.keys(value).length!==MANIFEST_FIELDS.size||Object.keys(value).some(key=>!MANIFEST_FIELDS.has(key))||
      value.version!==1||value.pypdfium2Version!=="5.11.0"||
      !/^\d+\.\d+\.\d+\.\d+$/.test(value.pdfiumVersion)||
      !Array.isArray(value.files)||value.files.length<7) throw unsafe("unsafe_pdfium_runtime");
  const seen=new Set();
  for (const item of value.files) {
    if (!item||typeof item!=="object"||Array.isArray(item)||
        Object.keys(item).length!==FILE_FIELDS.size||Object.keys(item).some(key=>!FILE_FIELDS.has(key))||
        typeof item.path!=="string"||!safeRelative(item.path)||seen.has(item.path)||
        typeof item.sha256!=="string"||!/^[a-f0-9]{64}$/.test(item.sha256)) throw unsafe("unsafe_pdfium_runtime");
    seen.add(item.path);
  }
}

function safeRelative(value) {
  return value.length>0&&!value.startsWith("/")&&!value.includes("\\")&&!value.split("/").some(part=>part===""||part==="."||part==="..");
}

async function requireDirectory(path,code) {
  const info=await lstat(path);
  if (!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid()) throw unsafe(code);
}
async function requireFile(path,code) {
  const info=await lstat(path);
  if (!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid()) throw unsafe(code);
}
async function requirePrivateDirectory(path,code) {
  await requireDirectory(path,code);
  if (((await lstat(path)).mode&0o777)!==0o700) throw unsafe(code);
}
async function requirePrivateFile(path,mode,code) {
  await requireFile(path,code);
  if (((await lstat(path)).mode&0o777)!==mode) throw unsafe(code);
}
async function setPrivateMode(path,mode) {
  const {chmod}=await import("node:fs/promises");
  await chmod(path,mode);
}
async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
function unsafe(code) { return new Error(code); }
