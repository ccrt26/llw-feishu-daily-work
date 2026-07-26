import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {chmod,mkdtemp,mkdir,readFile,rm,stat,symlink,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {installPdfiumRuntime,validatePdfiumRuntime} from "../src/capabilities/invoice/pdfium-runtime.mjs";

async function fixture() {
  const root=await mkdtemp(join(tmpdir(),"llw-pdfium-runtime-"));
  const source=join(root,"vendor"),licenses=join(root,"licenses"),processor=join(root,"processor.py"),destination=join(root,"installed");
  for (const directory of ["pypdfium2","pypdfium2_raw","pypdfium2_cfg"]) await mkdir(join(source,directory),{recursive:true});
  await writeFile(join(source,"pypdfium2","version.json"),JSON.stringify({
    major:5,minor:11,patch:0,beta:null,n_commits:0,hash:null,dirty:false,data_source:"git",is_editable:false
  }));
  await writeFile(join(source,"pypdfium2_raw","version.json"),JSON.stringify({
    major:151,minor:0,build:7920,patch:0,n_commits:0,hash:null,origin:"pdfium-binaries",flags:[]
  }));
  await writeFile(join(source,"pypdfium2_raw","libpdfium.dylib"),"safe-native");
  await writeFile(join(source,"pypdfium2","__init__.py"),"safe");
  await writeFile(join(source,"pypdfium2_raw","__init__.py"),"safe");
  await writeFile(join(source,"pypdfium2_cfg","__init__.py"),"safe");
  await mkdir(licenses);
  await writeFile(join(licenses,"LICENSE.txt"),"test-only license fixture");
  await writeFile(processor,"#!/usr/bin/python3\n");
  await chmod(processor,0o700);
  return {root,source,licenses,processor,destination};
}

test("installs an exact private PDFium 5.11.0 tree and validates every hash",async()=>{
  const f=await fixture();
  try {
    const result=await installPdfiumRuntime({sourceRoot:f.source,licenseRoot:f.licenses,processorSource:f.processor,destinationRoot:f.destination});
    assert.equal(result.pdfProcessorPath,join(f.destination,"pdfium-processor.py"));
    const manifest=await validatePdfiumRuntime(result.pdfProcessorPath);
    assert.equal(manifest.pypdfium2Version,"5.11.0");
    assert.equal(manifest.pdfiumVersion,"151.0.7920.0");
    assert.equal((await stat(f.destination)).mode&0o077,0);
    assert.equal((await stat(result.pdfProcessorPath)).mode&0o077,0);
    assert.equal(JSON.parse(await readFile(join(f.destination,"runtime-manifest.json"),"utf8")).files.length,8);
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

for (const mutation of ["changed","extra","missing","symlink","broad_mode","manifest"]) test(`rejects unsafe runtime mutation ${mutation}`,async()=>{
  const f=await fixture();
  try {
    const {pdfProcessorPath}=await installPdfiumRuntime({sourceRoot:f.source,licenseRoot:f.licenses,processorSource:f.processor,destinationRoot:f.destination});
    const library=join(f.destination,"pypdfium2_raw","libpdfium.dylib");
    if (mutation==="changed") await writeFile(library,"changed");
    if (mutation==="extra") await writeFile(join(f.destination,"extra"),"x");
    if (mutation==="missing") await rm(library);
    if (mutation==="symlink") { await rm(library); await symlink("/etc/hosts",library); }
    if (mutation==="broad_mode") await chmod(library,0o644);
    if (mutation==="manifest") await writeFile(join(f.destination,"runtime-manifest.json"),"{}");
    await assert.rejects(()=>validatePdfiumRuntime(pdfProcessorPath),/unsafe_pdfium_runtime/);
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

test("rejects source symlinks and wrong pypdfium2 version without creating the destination",async()=>{
  const first=await fixture();
  try {
    const target=join(first.source,"pypdfium2","__init__.py");
    await rm(target); await symlink("/etc/hosts",target);
    await assert.rejects(
      ()=>installPdfiumRuntime({sourceRoot:first.source,licenseRoot:first.licenses,processorSource:first.processor,destinationRoot:first.destination}),
      /unsafe_pdfium_source/
    );
    await assert.rejects(()=>stat(first.destination));
  } finally { await rm(first.root,{recursive:true,force:true}); }
  const second=await fixture();
  try {
    await writeFile(join(second.source,"pypdfium2","version.json"),JSON.stringify({major:5,minor:12,patch:0}));
    await assert.rejects(
      ()=>installPdfiumRuntime({sourceRoot:second.source,licenseRoot:second.licenses,processorSource:second.processor,destinationRoot:second.destination}),
      /unsafe_pdfium_source/
    );
  } finally { await rm(second.root,{recursive:true,force:true}); }
});

test("rejects a hash-consistent runtime whose processor self-check cannot import the pinned engine",async()=>{
  const f=await fixture();
  try {
    const {pdfProcessorPath}=await installPdfiumRuntime({
      sourceRoot:f.source,licenseRoot:f.licenses,processorSource:f.processor,destinationRoot:f.destination
    });
    await writeFile(pdfProcessorPath,"#!/usr/bin/python3\nraise SystemExit(1)\n");
    await chmod(pdfProcessorPath,0o700);
    const manifestFile=join(f.destination,"runtime-manifest.json");
    const manifest=JSON.parse(await readFile(manifestFile,"utf8"));
    const entry=manifest.files.find(item=>item.path==="pdfium-processor.py");
    entry.sha256=createHash("sha256").update(await readFile(pdfProcessorPath)).digest("hex");
    await writeFile(manifestFile,`${JSON.stringify(manifest,null,2)}\n`,{mode:0o600});
    await assert.rejects(()=>validatePdfiumRuntime(pdfProcessorPath),/unsafe_pdfium_runtime/);
  } finally { await rm(f.root,{recursive:true,force:true}); }
});
