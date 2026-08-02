import {createHash} from "node:crypto";
import {spawn} from "node:child_process";
import {
  chmod,copyFile,lstat,mkdir,mkdtemp,readdir,readFile,rm,stat,writeFile
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import {performance} from "node:perf_hooks";
import {
  TaskDocxReader
} from "../src/personal-assistant/task-docx-reader.mjs";

const HELPER=fileURLToPath(new URL(
  "../src/personal-assistant/docx-evidence-helper.mjs",import.meta.url
));
const NOW="2026-08-02T03:00:00.000Z";
const MAX_EXPANDED_BYTES=64*1024*1024;
const MAX_ENTRIES=2048;
const TASK_BYTES=80*1024*1024;

const root=await mkdtemp(join(tmpdir(),"llw-v445-docx-measure-"));
await chmod(root,0o700);
try {
  const maxEntryOriginal=join(root,"max-entry-count.docx");
  await buildMaxEntryFixture(maxEntryOriginal);
  const maxEntryBytes=(await stat(maxEntryOriginal)).size;
  const maxEntryRuns=await measureFixture({
    root,name:"max-entry-count-64m-expanded",
    originals:[maxEntryOriginal]
  });

  const multiOriginals=[];
  const storedPayloadBytes=Math.floor(TASK_BYTES/8)-4096;
  for (let index=0;index<8;index+=1) {
    const file=join(root,`multi-${index+1}.docx`);
    await buildStoredFixture(file,storedPayloadBytes);
    multiOriginals.push(file);
  }
  const multiOriginalBytes=(await Promise.all(
    multiOriginals.map(file=>stat(file))
  )).reduce((sum,value)=>sum+value.size,0);
  if (multiOriginalBytes>TASK_BYTES) {
    throw new Error("measurement_fixture_exceeds_task_boundary");
  }
  const multiRuns=await measureFixture({
    root,name:"eight-docx-80m-task",
    originals:multiOriginals
  });

  process.stdout.write(`${JSON.stringify({
    version:1,
    limits:{
      maxEntries:MAX_ENTRIES,maxExpandedBytes:MAX_EXPANDED_BYTES,
      maxTaskOriginalBytes:TASK_BYTES,watchdogMs:60_000
    },
    fixtures:[
      {
        name:"max-entry-count-64m-expanded",sourceCount:1,
        archiveEntries:MAX_ENTRIES,expandedBytes:MAX_EXPANDED_BYTES,
        originalBytes:maxEntryBytes,runs:maxEntryRuns
      },
      {
        name:"eight-docx-80m-task",sourceCount:8,
        originalBytes:multiOriginalBytes,runs:multiRuns
      }
    ]
  },null,2)}\n`);
} finally {
  await rm(root,{recursive:true,force:true});
}

async function measureFixture({root,name,originals}) {
  const results=[];
  for (const temperature of ["cold","warm"]) {
    const workspaceDir=join(root,`${name}-${temperature}`);
    const tempRoot=join(root,`${name}-${temperature}-jobs`);
    await mkdir(workspaceDir,{mode:0o700});
    await mkdir(tempRoot,{mode:0o700});
    const sources=[];
    for (const [index,original] of originals.entries()) {
      const sourceId=`source-${String(index+1).padStart(3,"0")}`;
      const absolutePath=join(workspaceDir,`${sourceId}.docx`);
      await copyFile(original,absolutePath);
      await chmod(absolutePath,0o600);
      const bytes=await readFile(absolutePath);
      sources.push({
        handle:{
          sourceId,displayName:`synthetic-${index+1}.docx`,
          mediaClass:"document",format:"docx",
          relativePath:`${sourceId}.docx`,byteSize:bytes.length,
          sha256:createHash("sha256").update(bytes).digest("hex"),
          availability:"ready"
        },
        absolutePath,archiveExtension:"docx"
      });
    }
    const reader=new TaskDocxReader({
      helperPath:HELPER,tempRoot,timeoutMs:60_000
    });
    const started=performance.now();
    const result=await reader.prepare({workspaceDir,sources,now:NOW});
    const durationMs=Math.round((performance.now()-started)*100)/100;
    results.push({
      temperature,durationMs,
      publishedBytes:await evidenceBytes(workspaceDir),
      statuses:Object.values(result.coverageBySource).map(item=>item.status),
      resultCode:"ok"
    });
    if ((await readdir(tempRoot)).length!==0) {
      throw new Error("measurement_job_cleanup_failed");
    }
  }
  return results;
}

async function buildMaxEntryFixture(output) {
  const packageRoot=join(dirname(output),"max-entry-package");
  await mkdir(join(packageRoot,"word"),{recursive:true,mode:0o700});
  await mkdir(join(packageRoot,"custom"),{recursive:true,mode:0o700});
  const contentTypes=Buffer.from(
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "utf8"
  );
  const document=Buffer.from(
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>boundary</w:t></w:r></w:p><w:sectPr/></w:body></w:document>',
    "utf8"
  );
  await writePart(packageRoot,"[Content_Types].xml",contentTypes);
  await writePart(packageRoot,"word/document.xml",document);
  const fillerCount=MAX_ENTRIES-2;
  const fillerTotal=MAX_EXPANDED_BYTES-contentTypes.length-document.length;
  const base=Math.floor(fillerTotal/fillerCount);
  let remainder=fillerTotal%fillerCount;
  const names=["[Content_Types].xml","word/document.xml"];
  for (let index=0;index<fillerCount;index+=1) {
    const name=`word/theme/theme${String(index+1).padStart(4,"0")}.xml`;
    const size=base+(remainder>0?1:0);
    if (remainder>0) remainder-=1;
    await writePart(packageRoot,name,sizedTheme(size,index+1));
    names.push(name);
  }
  await zipFiles({packageRoot,output,names,store:false});
  await rm(packageRoot,{recursive:true,force:true});
}

async function buildStoredFixture(output,payloadBytes) {
  const packageRoot=`${output}-package`;
  const contentTypes=Buffer.from(
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "utf8"
  );
  const document=Buffer.from(
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>multi boundary</w:t></w:r></w:p><w:sectPr/></w:body></w:document>',
    "utf8"
  );
  const names=[
    "[Content_Types].xml","word/document.xml","word/theme/theme1.xml"
  ];
  await writePart(packageRoot,names[0],contentTypes);
  await writePart(packageRoot,names[1],document);
  await writePart(packageRoot,names[2],sizedTheme(payloadBytes,1));
  await zipFiles({packageRoot,output,names,store:true});
  await rm(packageRoot,{recursive:true,force:true});
}

async function writePart(root,name,bytes) {
  const file=join(root,name);
  await mkdir(dirname(file),{recursive:true,mode:0o700});
  await writeFile(file,bytes,{mode:0o600});
}

function sizedTheme(size,index) {
  const prefix=Buffer.from(
    `<?xml version="1.0"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Synthetic ${index}">`,
    "utf8"
  );
  const suffix=Buffer.from("</a:theme>","utf8");
  if (size<prefix.length+suffix.length) {
    throw new Error("measurement_theme_too_small");
  }
  return Buffer.concat([
    prefix,Buffer.alloc(size-prefix.length-suffix.length,0x20),suffix
  ]);
}

function zipFiles({packageRoot,output,names,store}) {
  return new Promise((resolvePromise,rejectPromise)=>{
    const child=spawn("/usr/bin/zip",[
      "-q",...(store?["-0"]:[]),output,"-@"
    ],{cwd:packageRoot,stdio:["pipe","ignore","pipe"]});
    const errors=[];
    child.stderr.on("data",chunk=>errors.push(chunk));
    child.once("error",rejectPromise);
    child.once("close",code=>{
      if (code===0) resolvePromise();
      else rejectPromise(new Error(
        `zip_failed:${Buffer.concat(errors).toString("utf8").slice(0,200)}`
      ));
    });
    child.stdin.end(`${names.join("\n")}\n`);
  });
}

async function evidenceBytes(workspaceDir) {
  let total=0;
  for (const name of await readdir(workspaceDir)) {
    if (name.endsWith(".docx")) continue;
    const info=await lstat(join(workspaceDir,name));
    if (info.isFile()) total+=info.size;
  }
  return total;
}
