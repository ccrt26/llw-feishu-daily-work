import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,mkdir,mkdtemp,rm,writeFile
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  createAssistantSourcePreparer
} from "../src/personal-assistant/source-preparer.mjs";

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
