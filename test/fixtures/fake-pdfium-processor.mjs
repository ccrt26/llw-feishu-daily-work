#!/usr/bin/env node
import {mkdir,symlink,writeFile} from "node:fs/promises";
import {join} from "node:path";

const values=new Map();
for (let index=2;index<process.argv.length;index+=2) values.set(process.argv[index],process.argv[index+1]);
const output=values.get("--output");
const mode=process.env.FAKE_PDFIUM_MODE||"ok";
const pages=Number(process.env.FAKE_PDFIUM_PAGES||"2");
const text=process.env.FAKE_PDFIUM_TEXT??"invoice text";
const png=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.alloc(24,1)]);

if (process.env.FAKE_PDFIUM_ARGS) await writeFile(process.env.FAKE_PDFIUM_ARGS,JSON.stringify(process.argv.slice(2)));
if (process.env.FAKE_PDFIUM_COUNT) {
  const {readFile}=await import("node:fs/promises");
  let count=0;
  try { count=Number(await readFile(process.env.FAKE_PDFIUM_COUNT,"utf8")); } catch {}
  await writeFile(process.env.FAKE_PDFIUM_COUNT,String(count+1));
}

if (mode==="sleep") await new Promise(resolve=>setTimeout(resolve,10_000));
const exits={encrypted:20,structure:21,page_limit:22,text_error:23,render_error:24,unknown_exit:99};
if (Object.hasOwn(exits,mode)) process.exit(exits[mode]);
if (!output) process.exit(21);

await mkdir(output,{recursive:true,mode:0o700});
const textFile=join(output,"extracted.txt");
if (mode==="text_directory") await mkdir(textFile);
else if (mode==="text_link") await symlink("/etc/hosts",textFile);
else if (mode==="text_nonutf8") await writeFile(textFile,Buffer.from([0xc3,0x28]));
else if (mode==="text_oversize") await writeFile(textFile,"x".repeat(2048));
else await writeFile(textFile,text);

const pageFiles=Array.from({length:pages},(_,index)=>`page-${index+1}.png`);
for (const [index,name] of pageFiles.entries()) {
  const file=join(output,name);
  if (mode==="page_directory"&&index===0) await mkdir(file);
  else if (mode==="page_link"&&index===0) await symlink("/etc/hosts",file);
  else if (mode==="empty_png"&&index===0) await writeFile(file,Buffer.alloc(0));
  else if (mode==="bad_png"&&index===0) await writeFile(file,Buffer.alloc(32,1));
  else if (mode==="render_oversize") await writeFile(file,Buffer.concat([png,Buffer.alloc(1024,1)]));
  else await writeFile(file,png);
}

let manifest={version:1,pageCount:pages,textFile:"extracted.txt",pageFiles};
if (mode==="manifest_unknown") manifest={...manifest,unknown:true};
if (mode==="manifest_version") manifest={...manifest,version:2};
if (mode==="manifest_missing") delete manifest.textFile;
if (mode==="manifest_duplicate") manifest={...manifest,pageFiles:[pageFiles[0],pageFiles[0]]};
if (mode==="manifest_wrong_count") manifest={...manifest,pageCount:pages+1};
if (mode==="manifest_bad_name") manifest={...manifest,pageFiles:["../escape.png"]};
if (mode==="manifest_invalid_json") await writeFile(join(output,"manifest.json"),"{");
else await writeFile(join(output,"manifest.json"),JSON.stringify(manifest));
if (mode==="extra_file") await writeFile(join(output,"extra.bin"),"x");
