import test from "node:test";
import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {appendFile,mkdtemp,mkdir,readdir,readFile,writeFile} from "node:fs/promises";
import {randomBytes} from "node:crypto";
import {tmpdir} from "node:os";
import {dirname,join} from "node:path";
import {promisify} from "node:util";
import {FileOutputWorkspace,selectRequestedOutput} from "../src/workspace/file-output-workspace.mjs";

const run=promisify(execFile);
const required={
  docx:["[Content_Types].xml","word/document.xml"],
  pptx:["[Content_Types].xml","ppt/presentation.xml"],
  xlsx:["[Content_Types].xml","xl/workbook.xml"]
};

async function harness() {
  const root=await mkdtemp(join(tmpdir(),"llw-file-output-"));
  return {
    root,
    workspace:new FileOutputWorkspace({
      tempRoot:join(root,"tmp"),outputRoot:join(root,"stable"),
      maxOutputBytes:20*1024*1024
    })
  };
}

async function writePackage(outputFile,kind,{extra=false}={}) {
  const root=join(dirname(dirname(outputFile)),"package");
  await mkdir(root,{recursive:true,mode:0o700});
  for (const name of required[kind]) {
    const file=join(root,...name.split("/"));
    await mkdir(join(file,".."),{recursive:true,mode:0o700});
    await writeFile(file,`fixture:${name}`,{mode:0o600});
  }
  await run("/usr/bin/zip",["-X","-q","-r",outputFile,"."],{cwd:root});
  if (extra) await writeFile(join(dirname(outputFile),"unexpected.txt"),"bad",{mode:0o600});
}

test("selects exactly one explicit WPS-compatible output format",()=>{
  assert.equal(selectRequestedOutput("把当前稿导出成 Word 文档"),"docx");
  assert.equal(selectRequestedOutput("请生成一份PPTX"),"pptx");
  assert.equal(selectRequestedOutput("做成Excel表格"),"xlsx");
  assert.equal(selectRequestedOutput("生成 Word 和 PPT"),null);
  assert.equal(selectRequestedOutput("继续修改第二段"),null);
});

for (const kind of ["docx","pptx","xlsx"]) {
  test(`validates and publishes exactly one stable ${kind} artifact`,async()=>{
    const h=await harness();
    let calls=0;
    const artifact=await h.workspace.generate({
      sessionId:"018f-test-session",draftVersion:2,kind,
      displayName:`交流方案.${kind}`,draftText:"# 交流方案\n\n正文",
      generate:async({outputFile})=>{ calls+=1; await writePackage(outputFile,kind); }
    });
    assert.equal(calls,1);
    assert.equal(artifact.kind,kind);
    assert.equal(artifact.displayName,`交流方案.${kind}`);
    assert.match(artifact.sha256,/^[0-9a-f]{64}$/);
    assert.ok(artifact.size>0);
    assert.equal(artifact.path,join(h.root,"stable","018f-test-session","draft-v2",`交流方案.${kind}`));
    assert.deepEqual(await readdir(join(h.root,"stable","018f-test-session","draft-v2")),[`交流方案.${kind}`]);
  });
}

test("rejects an extra deliverable and publishes nothing",async()=>{
  const h=await harness();
  await assert.rejects(
    h.workspace.generate({
      sessionId:"session-a",draftVersion:1,kind:"docx",
      displayName:"方案.docx",draftText:"正文",
      generate:({outputFile})=>writePackage(outputFile,"docx",{extra:true})
    }),
    /file_output_invalid/
  );
  await assert.rejects(readdir(join(h.root,"stable","session-a")),/ENOENT/);
});

test("rejects mismatched OOXML contents and over-limit output",async()=>{
  const h=await harness();
  await assert.rejects(
    h.workspace.generate({
      sessionId:"session-b",draftVersion:1,kind:"pptx",
      displayName:"方案.pptx",draftText:"正文",
      generate:({outputFile})=>writePackage(outputFile,"docx")
    }),
    /file_output_invalid/
  );
  const tiny=new FileOutputWorkspace({
    tempRoot:join(h.root,"tiny-tmp"),outputRoot:join(h.root,"tiny-out"),
    maxOutputBytes:1024
  });
  await assert.rejects(
    tiny.generate({
      sessionId:"session-c",draftVersion:1,kind:"docx",
      displayName:"方案.docx",draftText:"正文",
      generate:async({outputFile})=>{
        await writePackage(outputFile,"docx");
        await appendFile(outputFile,randomBytes(2048));
      }
    }),
    /file_output_invalid/
  );
});

test("an existing stable artifact is reused byte-for-byte without regeneration",async()=>{
  const h=await harness();
  const input={
    sessionId:"session-d",draftVersion:3,kind:"xlsx",
    displayName:"清单.xlsx",draftText:"正文"
  };
  const first=await h.workspace.generate({
    ...input,generate:({outputFile})=>writePackage(outputFile,"xlsx")
  });
  const second=await h.workspace.generate({
    ...input,generate:async()=>{ throw new Error("must_not_regenerate"); }
  });
  assert.deepEqual(second,first);
  assert.deepEqual(await readFile(second.path),await readFile(first.path));
});
