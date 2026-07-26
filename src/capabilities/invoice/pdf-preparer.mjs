import {spawn} from "node:child_process";
import {open} from "node:fs/promises";
import {lstat,mkdir,readFile,readdir,realpath} from "node:fs/promises";
import {dirname,join,resolve,sep} from "node:path";

const PNG_SIGNATURE=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
const MANIFEST_FIELDS=new Set(["version","pageCount","textFile","pageFiles"]);
const EXIT_CODES=new Map([
  [20,"pdf_encrypted"],
  [21,"pdf_structure_invalid"],
  [22,"pdf_page_limit"],
  [23,"pdf_text_invalid"],
  [24,"pdf_render_invalid"]
]);

export async function prepareInvoicePdf({
  file,pdfProcessorPath,
  maxPages=10,maxTextBytes=262_144,maxRenderBytes=100*1024*1024,
  maxDimension=3508,timeoutMs=60_000,environment=process.env
}) {
  const job=dirname(file);
  await requireRegularWithin(file,job,"pdf_structure_invalid");
  const analysis=join(job,"analysis");
  try { await mkdir(analysis,{recursive:false,mode:0o700}); }
  catch { throw pdfError("pdf_structure_invalid"); }
  await requireDirectoryWithin(analysis,job,"pdf_structure_invalid");

  const args=[
    "--input",file,
    "--output",analysis,
    "--max-pages",String(maxPages),
    "--max-text-bytes",String(maxTextBytes),
    "--max-render-bytes",String(maxRenderBytes),
    "--max-dimension",String(maxDimension)
  ];
  const result=await runProcessor(pdfProcessorPath,args,{cwd:job,environment,timeoutMs});
  if (result.timedOut) throw pdfError("pdf_prepare_timeout");
  if (result.code!==0) throw pdfError(EXIT_CODES.get(result.code)||"pdf_structure_invalid");
  if (result.stdoutBytes!==0||result.stderrBytes!==0) throw pdfError("pdf_structure_invalid");

  let manifest;
  try {
    const manifestFile=join(analysis,"manifest.json");
    const info=await requireRegularWithin(manifestFile,analysis,"pdf_render_invalid");
    if (info.size<2||info.size>64*1024) throw pdfError("pdf_render_invalid");
    manifest=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await readFile(manifestFile)));
    validateManifest(manifest,maxPages);
  } catch (error) {
    if (error?.code==="pdf_render_invalid") throw error;
    throw pdfError("pdf_render_invalid");
  }

  let extractedText;
  try {
    const textFile=join(analysis,manifest.textFile);
    const info=await requireRegularWithin(textFile,analysis,"pdf_text_invalid");
    if (info.size>maxTextBytes) throw pdfError("pdf_text_invalid");
    extractedText=new TextDecoder("utf-8",{fatal:true}).decode(await readFile(textFile));
  } catch (error) {
    if (error?.code==="pdf_text_invalid") throw error;
    throw pdfError("pdf_text_invalid");
  }

  const pageImages=[];
  try {
    const expected=new Set(["manifest.json",manifest.textFile,...manifest.pageFiles]);
    const entries=await readdir(analysis,{withFileTypes:true});
    if (entries.length!==expected.size||entries.some(entry=>!expected.has(entry.name))) throw pdfError("pdf_render_invalid");
    let totalBytes=0;
    for (const name of manifest.pageFiles) {
      const image=join(analysis,name);
      const info=await requireRegularWithin(image,analysis,"pdf_render_invalid");
      if (info.size<PNG_SIGNATURE.length) throw pdfError("pdf_render_invalid");
      totalBytes+=info.size;
      if (!Number.isSafeInteger(totalBytes)||totalBytes>maxRenderBytes) throw pdfError("pdf_render_invalid");
      const handle=await open(image,"r");
      const header=Buffer.alloc(PNG_SIGNATURE.length);
      try { await handle.read(header,0,header.length,0); }
      finally { await handle.close(); }
      if (!header.equals(PNG_SIGNATURE)) throw pdfError("pdf_render_invalid");
      pageImages.push(image);
    }
  } catch (error) {
    if (error?.code==="pdf_render_invalid") throw error;
    throw pdfError("pdf_render_invalid");
  }

  return {
    originalFile:file,
    detectedFormat:"pdf",
    archiveExtension:"pdf",
    pageImages,
    extractedText,
    documentFacts:{
      pageCount:manifest.pageCount,
      textAvailable:Buffer.byteLength(extractedText.trim(),"utf8")>0
    }
  };
}

function validateManifest(value,maxPages) {
  if (!value||typeof value!=="object"||Array.isArray(value)||
      Object.keys(value).length!==MANIFEST_FIELDS.size||
      Object.keys(value).some(field=>!MANIFEST_FIELDS.has(field))||
      value.version!==1||
      !Number.isSafeInteger(value.pageCount)||value.pageCount<1||value.pageCount>maxPages||
      value.textFile!=="extracted.txt"||
      !Array.isArray(value.pageFiles)||value.pageFiles.length!==value.pageCount) {
    throw pdfError("pdf_render_invalid");
  }
  const expected=value.pageFiles.map((_,index)=>`page-${index+1}.png`);
  if (value.pageFiles.some((name,index)=>name!==expected[index])) throw pdfError("pdf_render_invalid");
}

async function requireRegularWithin(file,parent,code) {
  try {
    const info=await lstat(file);
    if (!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid()) throw new Error("unsafe");
    const actualParent=await realpath(parent),actual=await realpath(file);
    if (!actual.startsWith(`${actualParent}${sep}`)||actual!==resolve(actualParent,actual.slice(actualParent.length+1))) throw new Error("unsafe");
    return info;
  } catch (error) {
    if (error?.code===code) throw error;
    throw pdfError(code);
  }
}

async function requireDirectoryWithin(directory,parent,code) {
  try {
    const info=await lstat(directory);
    const actualParent=await realpath(parent),actual=await realpath(directory);
    if (!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid()||!actual.startsWith(`${actualParent}${sep}`)) throw new Error("unsafe");
  } catch { throw pdfError(code); }
}

function runProcessor(command,args,{cwd,environment,timeoutMs}) {
  return new Promise(resolveResult=>{
    let stdoutBytes=0,stderrBytes=0,timedOut=false,settled=false;
    const child=spawn(command,args,{cwd,env:environment,shell:false,stdio:["ignore","pipe","pipe"]});
    const finish=value=>{ if (!settled) { settled=true; resolveResult(value); } };
    child.stdout.on("data",chunk=>{ stdoutBytes+=chunk.length; if (stdoutBytes>64*1024) child.kill("SIGTERM"); });
    child.stderr.on("data",chunk=>{ stderrBytes+=chunk.length; if (stderrBytes>64*1024) child.kill("SIGTERM"); });
    const timer=setTimeout(()=>{ timedOut=true; child.kill("SIGTERM"); },timeoutMs);
    child.once("error",()=>{ clearTimeout(timer); finish({code:null,timedOut:false,stdoutBytes,stderrBytes}); });
    child.once("close",code=>{ clearTimeout(timer); finish({code,timedOut,stdoutBytes,stderrBytes}); });
  });
}

function pdfError(code) { return Object.assign(new Error(code),{code}); }
