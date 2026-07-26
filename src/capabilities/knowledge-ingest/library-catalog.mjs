import {lstat,readdir,realpath} from "node:fs/promises";
import {join} from "node:path";

export async function createKnowledgeLibraryCatalog(
  libraries,
  {maxFolders=256,maxDepth=5}={}
) {
  try {
    if (!Array.isArray(libraries)||libraries.length<1||
        !Number.isInteger(maxFolders)||maxFolders<1||maxFolders>256||
        !Number.isInteger(maxDepth)||maxDepth<1||maxDepth>5) {
      throw new Error("invalid");
    }
    const result=[];
    for (const library of libraries) {
      validateLibrary(library);
      const rootInfo=await lstat(library.root);
      if (!rootInfo.isDirectory()||rootInfo.isSymbolicLink()||
          rootInfo.uid!==process.getuid()) {
        throw new Error("invalid");
      }
      const rootReal=await realpath(library.root);
      const existingFolders=[];
      await enumerate(rootReal,[],existingFolders,{maxFolders,maxDepth});
      result.push({
        libraryKey:library.libraryKey,
        displayName:library.displayName,
        aliases:[...library.aliases],
        existingFolders
      });
    }
    return result;
  } catch {
    throw new Error("knowledge_library_catalog_invalid");
  }
}

async function enumerate(directory,segments,result,{maxFolders,maxDepth}) {
  const entries=(await readdir(directory,{withFileTypes:true}))
    .sort((left,right)=>left.name.localeCompare(right.name,"en"));
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isSymbolicLink()) throw new Error("invalid");
    if (!entry.isDirectory()) continue;
    validateSegment(entry.name);
    const nextSegments=[...segments,entry.name];
    const expected=join(directory,entry.name);
    const info=await lstat(expected);
    if (!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid()||
        await realpath(expected)!==expected) {
      throw new Error("invalid");
    }
    result.push(nextSegments);
    if (result.length>maxFolders) throw new Error("invalid");
    if (nextSegments.length<maxDepth) {
      await enumerate(expected,nextSegments,result,{maxFolders,maxDepth});
    }
  }
}

function validateLibrary(value) {
  const fields=new Set(["libraryKey","displayName","aliases","root"]);
  if (!value||typeof value!=="object"||Array.isArray(value)||
      Object.keys(value).length!==fields.size||
      Object.keys(value).some(field=>!fields.has(field))||
      typeof value.libraryKey!=="string"||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(value.libraryKey)||
      !validLabel(value.displayName)||
      !Array.isArray(value.aliases)||
      value.aliases.some(alias=>!validLabel(alias))||
      typeof value.root!=="string"||!value.root.startsWith("/")) {
    throw new Error("invalid");
  }
}

function validateSegment(value) {
  if (!validLabel(value)||value==="."||value==="..") throw new Error("invalid");
}

function validLabel(value) {
  return typeof value==="string"&&value===value.trim()&&value===value.normalize("NFC")&&
    [...value].length>=1&&[...value].length<=64&&!value.startsWith(".")&&
    !/[\\/\u0000-\u001f\u007f]/u.test(value);
}
