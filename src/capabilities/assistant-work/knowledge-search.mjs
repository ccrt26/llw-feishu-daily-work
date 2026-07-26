import {lstat,open,readdir,realpath} from "node:fs/promises";
import {basename,isAbsolute,relative,resolve,sep} from "node:path";

export async function searchKnowledge({
  vaultRoot,libraries,query,maxFiles,maxFileBytes,maxResults,maxTotalExcerptBytes
}) {
  try {
    validateLimits({maxFiles,maxFileBytes,maxResults,maxTotalExcerptBytes});
    const tokens=queryTokens(query);
    if (!tokens.length) return [];
    const vault=resolve(vaultRoot);
    await ownedDirectory(vault);
    const vaultReal=await realpath(vault);
    const roots=await validateLibraries(vault,vaultReal,libraries);
    const files=[],scan={directories:0};
    for (const root of roots) await collectMarkdown(root,files,maxFiles,scan);
    const matches=[];
    for (const file of files) {
      const content=await readVerified(file,maxFileBytes);
      if (content===null) continue;
      const portablePath=relative(vaultReal,file).split(sep).join("/");
      fail(!safeRelativePath(portablePath));
      const scored=score(content,basename(file),tokens);
      if (!scored) continue;
      matches.push({path:portablePath,content,score:scored});
    }
    matches.sort((left,right)=>right.score-left.score||
      left.path.localeCompare(right.path,"zh-Hans-CN"));
    let remaining=maxTotalExcerptBytes;
    const results=[];
    for (const match of matches.slice(0,maxResults)) {
      if (remaining<1) break;
      const excerpt=boundedExcerpt(match.content,tokens,remaining);
      if (!excerpt) break;
      remaining-=Buffer.byteLength(excerpt,"utf8");
      results.push({path:match.path,excerpt,score:match.score});
    }
    return results;
  } catch {
    throw new Error("knowledge_search_rejected");
  }
}

export async function loadKnowledgeSources({
  vaultRoot,libraries,sourcePaths,maxFileBytes,maxTotalExcerptBytes
}) {
  try {
    validateLimits({
      maxFiles:Math.max(1,sourcePaths?.length||0),maxFileBytes,
      maxResults:Math.max(1,sourcePaths?.length||0),maxTotalExcerptBytes
    });
    fail(!Array.isArray(sourcePaths)||sourcePaths.length>20||
      new Set(sourcePaths).size!==sourcePaths.length);
    if (!sourcePaths.length) return [];
    const vault=resolve(vaultRoot);
    await ownedDirectory(vault);
    const vaultReal=await realpath(vault);
    const roots=await validateLibraries(vault,vaultReal,libraries);
    let remaining=maxTotalExcerptBytes;
    const results=[];
    for (const relativePath of sourcePaths) {
      fail(!safeRelativePath(relativePath)||
        !relativePath.toLocaleLowerCase("en-US").endsWith(".md"));
      const file=resolve(vaultReal,...relativePath.split("/"));
      fail(!inside(vaultReal,file)||!roots.some(root=>inside(root,file)));
      const metadata=await lstat(file);
      fail(!metadata.isFile()||metadata.isSymbolicLink());
      fail(await realpath(file)!==file);
      const content=await readVerified(file,maxFileBytes);
      fail(content===null);
      const excerpt=boundedExcerpt(content,[],remaining);
      fail(!excerpt);
      remaining-=Buffer.byteLength(excerpt,"utf8");
      results.push({path:relativePath,excerpt,score:1});
    }
    return results;
  } catch {
    throw new Error("knowledge_search_rejected");
  }
}

async function validateLibraries(vault,vaultReal,libraries) {
  fail(!Array.isArray(libraries)||libraries.length<1||libraries.length>16);
  const keys=new Set(),roots=[];
  for (const library of libraries) {
    const fields=new Set(["libraryKey","root"]);
    fail(!library||typeof library!=="object"||Array.isArray(library)||
      Object.keys(library).length!==fields.size||
      Object.keys(library).some(field=>!fields.has(field))||
      !/^[a-z][a-z0-9_-]{0,63}$/u.test(library.libraryKey)||
      keys.has(library.libraryKey));
    keys.add(library.libraryKey);
    fail(typeof library.root!=="string"||!isAbsolute(library.root));
    const configured=resolve(library.root);
    fail(configured===vault||!inside(vault,configured));
    await ownedDirectory(configured);
    const actual=await realpath(configured);
    const expected=resolve(vaultReal,relative(vault,configured));
    fail(actual!==expected);
    for (const other of roots) {
      fail(actual===other||inside(other,actual)||inside(actual,other));
    }
    roots.push(actual);
  }
  return roots;
}

async function collectMarkdown(directory,files,maxFiles,scan) {
  scan.directories+=1;
  fail(scan.directories>4096);
  const entries=await readdir(directory,{withFileTypes:true});
  entries.sort((left,right)=>left.name.localeCompare(right.name,"zh-Hans-CN"));
  for (const entry of entries) {
    fail(entry.name==="."||entry.name===".."||entry.name.includes("/")||
      entry.isSymbolicLink());
    const path=resolve(directory,entry.name);
    if (entry.isDirectory()) await collectMarkdown(path,files,maxFiles,scan);
    else if (entry.isFile()&&entry.name.toLocaleLowerCase("en-US").endsWith(".md")) {
      fail(files.length>=maxFiles);
      files.push(path);
    }
  }
}

async function readVerified(file,maxBytes) {
  const before=await lstat(file);
  fail(!before.isFile()||before.isSymbolicLink()||before.uid!==process.getuid());
  if (before.size<1||before.size>maxBytes) return null;
  const handle=await open(file,"r");
  try {
    const after=await handle.stat();
    fail(!after.isFile()||after.uid!==process.getuid()||
      after.dev!==before.dev||after.ino!==before.ino||after.size!==before.size);
    const content=await handle.readFile("utf8");
    fail(content.includes("\0")||Buffer.byteLength(content,"utf8")!==before.size);
    return content;
  } finally {
    await handle.close();
  }
}

function queryTokens(value) {
  fail(typeof value!=="string"||!value.trim()||[...value].length>12_000);
  return [...new Set(value.normalize("NFC").toLocaleLowerCase("zh-Hans-CN")
    .split(/[\s,，。；;：:、！？!?（）()[\]{}"'“”‘’<>《》/]+/u)
    .map(token=>token.trim()).filter(token=>[...token].length>=2).slice(0,32))];
}

function safeRelativePath(value) {
  return typeof value==="string"&&value.length>0&&[...value].length<=240&&
    Buffer.byteLength(value,"utf8")<=240&&
    !value.startsWith("/")&&!value.startsWith("~")&&!value.includes("\\")&&
    !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)&&
    value.split("/").every(segment=>segment&&segment!=="."&&segment!=="..");
}

function score(content,name,tokens) {
  const body=content.toLocaleLowerCase("zh-Hans-CN");
  const title=name.toLocaleLowerCase("zh-Hans-CN");
  let result=0;
  for (const token of tokens) {
    if (title.includes(token)) result+=8;
    let offset=0,count=0;
    while ((offset=body.indexOf(token,offset))>=0&&count<20) {
      result+=1; count+=1; offset+=token.length;
    }
  }
  return result;
}

function boundedExcerpt(content,tokens,maxBytes) {
  const lower=content.toLocaleLowerCase("zh-Hans-CN");
  const indices=tokens.map(token=>lower.indexOf(token)).filter(index=>index>=0);
  const start=Math.max(0,(indices.length?Math.min(...indices):0)-200);
  const candidate=[...content.slice(start,start+4000)];
  while (candidate.length&&Buffer.byteLength(candidate.join(""),"utf8")>maxBytes) {
    candidate.pop();
  }
  return candidate.join("").trim();
}

function validateLimits(value) {
  for (const [field,min,max] of [
    ["maxFiles",1,4096],["maxFileBytes",1,1024*1024],
    ["maxResults",1,20],["maxTotalExcerptBytes",1,512*1024]
  ]) fail(!Number.isInteger(value[field])||value[field]<min||value[field]>max);
}

async function ownedDirectory(path) {
  const metadata=await lstat(path);
  fail(!metadata.isDirectory()||metadata.isSymbolicLink()||
    metadata.uid!==process.getuid());
}

function inside(root,value) {
  return value.startsWith(`${root}${sep}`);
}

function fail(condition) {
  if (condition) throw new Error("invalid");
}
