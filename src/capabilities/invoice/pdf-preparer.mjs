import {spawn} from "node:child_process";
import {open} from "node:fs/promises";
import {lstat,mkdir,readFile,readdir,realpath} from "node:fs/promises";
import {dirname,join,resolve,sep} from "node:path";

const PNG_SIGNATURE=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
const PDFINFO_STDOUT_LIMIT=64 * 1024;

export async function prepareInvoicePdf({
  file,pdfInfoPath,pdfToTextPath,pdfToPpmPath,
  maxPages=10,maxTextBytes=262_144,maxRenderBytes=100 * 1024 * 1024,
  timeoutMs=60_000,environment=process.env
}) {
  const job=dirname(file);
  await requireRegularWithin(file,job,"pdf_structure_invalid");

  let infoOutput;
  try {
    infoOutput=await runTool(pdfInfoPath,[file],{cwd:job,environment,timeoutMs,maxStdoutBytes:PDFINFO_STDOUT_LIMIT});
  } catch (error) {
    throw pdfError(error.code === "tool_timeout" ? "pdf_prepare_timeout" : "pdf_structure_invalid");
  }
  const {pageCount,encrypted}=parsePdfInfo(infoOutput);
  if (encrypted) throw pdfError("pdf_encrypted");
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > maxPages) throw pdfError("pdf_page_limit");

  const analysis=join(job,"analysis");
  try { await mkdir(analysis,{recursive:false,mode:0o700}); }
  catch { throw pdfError("pdf_structure_invalid"); }
  await requireDirectoryWithin(analysis,job,"pdf_structure_invalid");

  const textFile=join(analysis,"extracted.txt");
  try {
    await runTool(pdfToTextPath,["-layout","-enc","UTF-8",file,textFile],{cwd:job,environment,timeoutMs,maxStdoutBytes:0});
  } catch (error) {
    throw pdfError(error.code === "tool_timeout" ? "pdf_prepare_timeout" : "pdf_text_invalid");
  }

  let extractedText;
  try {
    const info=await requireRegularWithin(textFile,analysis,"pdf_text_invalid");
    if (info.size > maxTextBytes) throw pdfError("pdf_text_invalid");
    const bytes=await readFile(textFile);
    extractedText=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
  } catch (error) {
    if (error?.code === "pdf_text_invalid") throw error;
    throw pdfError("pdf_text_invalid");
  }

  const prefix=join(analysis,"page");
  try {
    await runTool(pdfToPpmPath,["-f","1","-l",String(pageCount),"-png","-scale-to","3508",file,prefix],{cwd:job,environment,timeoutMs,maxStdoutBytes:0});
  } catch (error) {
    throw pdfError(error.code === "tool_timeout" ? "pdf_prepare_timeout" : "pdf_render_invalid");
  }

  const pageImages=[];
  try {
    const expected=new Set(["extracted.txt",...Array.from({length:pageCount},(_,index) => `page-${index+1}.png`)]);
    const entries=await readdir(analysis,{withFileTypes:true});
    if (entries.length !== expected.size || entries.some(entry => !expected.has(entry.name) || (!entry.isFile() && !entry.isSymbolicLink()))) {
      throw pdfError("pdf_render_invalid");
    }
    let totalBytes=0;
    for (let page=1;page<=pageCount;page++) {
      const image=join(analysis,`page-${page}.png`);
      const info=await requireRegularWithin(image,analysis,"pdf_render_invalid");
      if (info.size < PNG_SIGNATURE.length) throw pdfError("pdf_render_invalid");
      totalBytes += info.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > maxRenderBytes) throw pdfError("pdf_render_invalid");
      const handle=await open(image,"r");
      const header=Buffer.alloc(PNG_SIGNATURE.length);
      try { await handle.read(header,0,header.length,0); }
      finally { await handle.close(); }
      if (!header.equals(PNG_SIGNATURE)) throw pdfError("pdf_render_invalid");
      pageImages.push(image);
    }
  } catch (error) {
    if (error?.code === "pdf_render_invalid") throw error;
    throw pdfError("pdf_render_invalid");
  }

  return {
    originalFile:file,
    detectedFormat:"pdf",
    archiveExtension:"pdf",
    pageImages,
    extractedText,
    documentFacts:{pageCount,textAvailable:Buffer.byteLength(extractedText.trim(),"utf8") > 0}
  };
}

function parsePdfInfo(output) {
  const pageMatches=[...output.matchAll(/^Pages:\s*(\d+)\s*$/gm)];
  const encryptedMatches=[...output.matchAll(/^Encrypted:\s*(.+?)\s*$/gm)];
  if (pageMatches.length !== 1 || encryptedMatches.length > 1) throw pdfError("pdf_structure_invalid");
  const pageCount=Number(pageMatches[0][1]);
  const encrypted=encryptedMatches.length === 1 && !/^no(?:\s|$)/i.test(encryptedMatches[0][1]);
  return {pageCount,encrypted};
}

async function requireRegularWithin(file,parent,code) {
  try {
    const info=await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("unsafe");
    const actualParent=await realpath(parent);
    const actual=await realpath(file);
    if (actual !== resolve(actualParent,actual.slice(actualParent.length+1)) || !actual.startsWith(`${actualParent}${sep}`)) throw new Error("unsafe");
    return info;
  } catch (error) {
    if (error?.code === code) throw error;
    throw pdfError(code);
  }
}

async function requireDirectoryWithin(directory,parent,code) {
  try {
    const info=await lstat(directory);
    const actualParent=await realpath(parent);
    const actual=await realpath(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || !actual.startsWith(`${actualParent}${sep}`)) throw new Error("unsafe");
  } catch { throw pdfError(code); }
}

function runTool(command,args,{cwd,environment,timeoutMs,maxStdoutBytes}) {
  return new Promise((resolveOutput,reject) => {
    const child=spawn(command,args,{cwd,env:{...environment,LC_ALL:"C",LANG:"C"},shell:false,stdio:["ignore","pipe","pipe"]});
    const stdout=[];
    let stdoutBytes=0,stderrBytes=0,timedOut=false,settled=false;
    const finish=(error,value) => {
      if (settled) return;
      settled=true;
      error ? reject(error) : resolveOutput(value);
    };
    child.stdout.on("data",chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        child.kill("SIGTERM");
        finish(toolError("tool_output_limit"));
      } else stdout.push(chunk);
    });
    child.stderr.on("data",chunk => { stderrBytes += chunk.length; });
    const timer=setTimeout(() => { timedOut=true; child.kill("SIGTERM"); },timeoutMs);
    child.once("error",() => { clearTimeout(timer); finish(toolError("tool_failed")); });
    child.once("close",code => {
      clearTimeout(timer);
      if (timedOut) finish(toolError("tool_timeout"));
      else if (code !== 0) finish(toolError("tool_failed"));
      else finish(null,Buffer.concat(stdout).toString("utf8"));
      void stderrBytes;
    });
  });
}

function toolError(code) { return Object.assign(new Error(code),{code}); }
function pdfError(code) { return Object.assign(new Error(code),{code}); }
