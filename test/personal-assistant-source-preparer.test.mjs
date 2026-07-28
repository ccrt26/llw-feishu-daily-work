import test from "node:test";
import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {
  chmod,lstat,mkdir,mkdtemp,rm,writeFile
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname,join} from "node:path";
import {promisify} from "node:util";
import {
  createAssistantSourcePreparer
} from "../src/personal-assistant/source-preparer.mjs";

const run=promisify(execFile);

function attachment(index,extension="txt") {
  return {
    type:"file",
    sourceAttachmentId:`file-${index}`,
    displayName:`材料-${index}.${extension}`,
    extension
  };
}

test("isolates up to eight originals without running semantic extraction",async()=>{
  const tempRoot=await mkdtemp(join(tmpdir(),"llw-v401-intake-"));
  const downloadRoot=await mkdtemp(join(tmpdir(),"llw-v401-download-"));
  let downloads=0,officeSemanticPrepareCalls=0;
  const prepare=createAssistantSourcePreparer({
    tempRoot,
    download:async({attachment:value})=>{
      downloads+=1;
      const tempDir=join(downloadRoot,`job-${downloads}`);
      await mkdir(tempDir,{mode:0o700});
      const file=join(tempDir,`attachment.${value.extension}`);
      await writeFile(file,`原始文件 ${downloads} UNIQUE-BODY-MARKER`,{mode:0o600});
      return {file,tempDir};
    },
    prepareOffice:async()=>{
      officeSemanticPrepareCalls+=1;
      throw new Error("semantic_extraction_must_not_run");
    }
  });
  let prepared;
  try {
    prepared=await prepare({
      source:"wechat",sourceMessageId:"m1",
      instructionText:"比较后总结",
      attachments:Array.from({length:8},(_,index)=>attachment(index+1))
    });
    assert.equal(downloads,8);
    assert.equal(prepared.sources.length,8);
    assert.equal(prepared.sources[0].handle.relativePath,"source-001.txt");
    assert.equal(prepared.sources[7].handle.relativePath,"source-008.txt");
    assert.equal(Object.hasOwn(prepared.sources[0].handle,"content"),false);
    assert.equal(
      Object.hasOwn(prepared.sources[0].handle,"extractionIntegrity"),false
    );
    assert.equal(officeSemanticPrepareCalls,0);
  } finally {
    await prepared?.cleanup();
    await rm(tempRoot,{recursive:true,force:true});
    await rm(downloadRoot,{recursive:true,force:true});
  }
});

test("rejects a ninth source before any download",async()=>{
  const tempRoot=await mkdtemp(join(tmpdir(),"llw-v401-intake-limit-"));
  let downloads=0;
  const prepare=createAssistantSourcePreparer({
    tempRoot,
    download:async()=>{downloads+=1;}
  });
  try {
    await assert.rejects(()=>prepare({
      source:"feishu",sourceMessageId:"m2",instructionText:"",
      attachments:Array.from({length:9},(_,index)=>attachment(index+1))
    }),/assistant_source_invalid/);
    assert.equal(downloads,0);
  } finally { await rm(tempRoot,{recursive:true,force:true}); }
});

test("enforces per-file and whole-turn byte limits",async()=>{
  const tempRoot=await mkdtemp(join(tmpdir(),"llw-v401-intake-bytes-"));
  const downloadRoot=await mkdtemp(join(tmpdir(),"llw-v401-download-bytes-"));
  const prepare=createAssistantSourcePreparer({
    tempRoot,maxFileBytes:10,maxTurnSourceBytes:15,
    download:async({attachment:value})=>{
      const tempDir=join(downloadRoot,value.sourceAttachmentId);
      await mkdir(tempDir,{mode:0o700});
      const file=join(tempDir,"attachment.txt");
      await writeFile(file,value.sourceAttachmentId==="file-1"
        ?"1234567890":"abcdef",{mode:0o600});
      return {file,tempDir};
    }
  });
  try {
    await assert.rejects(()=>prepare({
      source:"wechat",sourceMessageId:"m3",instructionText:"处理",
      attachments:[attachment(1),attachment(2)]
    }),/source_limit_exceeded/);
  } finally {
    await rm(tempRoot,{recursive:true,force:true});
    await rm(downloadRoot,{recursive:true,force:true});
  }
});

test("cleans each downloader directory and the workspace once after partial failure",async()=>{
  const tempRoot=await mkdtemp(join(tmpdir(),"llw-v401-intake-clean-"));
  const downloadRoot=await mkdtemp(join(tmpdir(),"llw-v401-download-clean-"));
  const cleanupCalls=new Map();
  let calls=0;
  const prepare=createAssistantSourcePreparer({
    tempRoot,
    download:async()=>{
      calls+=1;
      if (calls===3) throw new Error("download_failed");
      const tempDir=join(downloadRoot,`job-${calls}`);
      await mkdir(tempDir,{mode:0o700});
      const file=join(tempDir,"attachment.txt");
      await writeFile(file,"safe",{mode:0o600});
      return {file,tempDir};
    },
    cleanup:async directory=>{
      cleanupCalls.set(directory,(cleanupCalls.get(directory)||0)+1);
      await rm(directory,{recursive:true,force:true});
    }
  });
  try {
    await assert.rejects(()=>prepare({
      source:"feishu",sourceMessageId:"m4",instructionText:"处理",
      attachments:[attachment(1),attachment(2),attachment(3)]
    }),/source_receive_failed/);
    assert.equal(cleanupCalls.get(join(downloadRoot,"job-1")),1);
    assert.equal(cleanupCalls.get(join(downloadRoot,"job-2")),1);
    assert.equal(
      [...cleanupCalls.entries()].filter(([path])=>path.startsWith(tempRoot))
        .reduce((sum,[,count])=>sum+count,0),
      1
    );
  } finally {
    await rm(tempRoot,{recursive:true,force:true});
    await rm(downloadRoot,{recursive:true,force:true});
  }
});

test("exports one Feishu cloud document into the original-source workspace and sanitizes its instruction",async()=>{
  const tempRoot=await mkdtemp(join(tmpdir(),"llw-v401-cloud-intake-"));
  const exportRoot=await mkdtemp(join(tmpdir(),"llw-v401-cloud-export-"));
  const exportJob=join(exportRoot,"job-1");
  await mkdir(exportJob,{mode:0o700});
  const snapshot=await createDocx(exportJob);
  let downloads=0,exports=0;
  const prepare=createAssistantSourcePreparer({
    tempRoot,
    download:async()=>{
      downloads+=1;
      throw new Error("uploaded_file_downloader_must_not_run");
    },
    exportFeishuDocument:async input=>{
      exports+=1;
      assert.deepEqual(input,{
        url:"https://example.feishu.cn/docx/synthetic_token"
      });
      return {
        tempDir:exportJob,file:snapshot,extension:"docx",
        displayName:"合成云文档.docx",
        safeSourceReference:`feishu:${"a".repeat(64)}`
      };
    }
  });
  let prepared;
  try {
    prepared=await prepare({
      source:"feishu",sourceMessageId:"cloud-1",
      instructionText:
        "总结这个飞书文档，不保存：https://example.feishu.cn/docx/synthetic_token",
      attachments:[]
    });
    assert.equal(exports,1);
    assert.equal(downloads,0);
    assert.equal(
      prepared.instructionText,
      "总结这个飞书文档，不保存：[飞书文档快照]"
    );
    assert.equal(prepared.sources.length,1);
    assert.equal(prepared.sources[0].handle.format,"docx");
    assert.equal(
      prepared.sources[0].handle.relativePath,
      "source-001.docx"
    );
    assert.equal(prepared.sources[0].handle.displayName,"合成云文档.docx");
    await assert.rejects(()=>lstat(exportJob),/ENOENT/u);
  } finally {
    await prepared?.cleanup();
    await rm(tempRoot,{recursive:true,force:true});
    await rm(exportRoot,{recursive:true,force:true});
  }
});

test("collects multiple cloud-document snapshots and rejects a ninth source before acquisition",async()=>{
  const tempRoot=await mkdtemp(join(tmpdir(),"llw-v401-cloud-limit-"));
  const exportRoot=await mkdtemp(join(tmpdir(),"llw-v401-cloud-multi-"));
  const downloadRoot=await mkdtemp(join(tmpdir(),"llw-v401-cloud-upload-"));
  let downloads=0,exports=0;
  const prepare=createAssistantSourcePreparer({
    tempRoot,
    download:async()=>{
      downloads+=1;
      const tempDir=join(downloadRoot,`job-${downloads}`);
      await mkdir(tempDir,{mode:0o700});
      const file=join(tempDir,"attachment.txt");
      await writeFile(file,"SYNTHETIC-UPLOADED-SOURCE",{mode:0o600});
      return {tempDir,file};
    },
    exportFeishuDocument:async()=>{
      exports+=1;
      const tempDir=join(exportRoot,`job-${exports}`);
      await mkdir(tempDir,{mode:0o700});
      return {
        tempDir,file:await createDocx(tempDir),
        extension:"docx",displayName:`云文档-${exports}.docx`,
        safeSourceReference:`feishu:${String(exports).repeat(64)}`
      };
    }
  });
  let prepared;
  try {
    prepared=await prepare({
      source:"feishu",sourceMessageId:"cloud-multiple",
      instructionText:[
        "比较",
        "https://example.feishu.cn/docx/synthetic_one",
        "https://example.feishu.cn/docx/synthetic_two"
      ].join(" "),
      attachments:[attachment(1)]
    });
    assert.equal(exports,2);
    assert.deepEqual(
      prepared.sources.map(source=>source.handle.sourceId),
      ["source-001","source-002","source-003"]
    );
    await prepared.cleanup();
    prepared=null;
    await assert.rejects(()=>prepare({
      source:"feishu",sourceMessageId:"cloud-ninth",
      instructionText:
        "比较 https://example.feishu.cn/docx/synthetic_one",
      attachments:Array.from({length:8},(_,index)=>attachment(index+1))
    }),/assistant_source_invalid/u);
    assert.equal(downloads,1);
    assert.equal(exports,2);
  } finally {
    await prepared?.cleanup();
    await rm(tempRoot,{recursive:true,force:true});
    await rm(exportRoot,{recursive:true,force:true});
    await rm(downloadRoot,{recursive:true,force:true});
  }
});

async function createDocx(root) {
  const packageRoot=join(root,"package");
  const parts={
    "[Content_Types].xml":
      '<?xml version="1.0"?><Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "word/document.xml":
      '<?xml version="1.0"?><document>SYNTHETIC-CLOUD-DOCUMENT</document>'
  };
  for (const [part,content] of Object.entries(parts)) {
    const target=join(packageRoot,part);
    await mkdir(dirname(target),{recursive:true,mode:0o700});
    await writeFile(target,content,{mode:0o600});
  }
  const output=join(root,"snapshot.docx");
  await run("/usr/bin/zip",["-q","-r",output,"."],{cwd:packageRoot});
  await chmod(output,0o600);
  return output;
}
