import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createAssistantSourcePreparer} from "../src/personal-assistant/source-preparer.mjs";

test("prepares same-turn PDF as complete evidence and preserves original bytes",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v401-source-"));
  const file=join(root,"source.pdf");
  const bytes=Buffer.from("%PDF-1.7\nsynthetic");
  await writeFile(file,bytes,{mode:0o600});
  const prepare=createAssistantSourcePreparer({
    download:async()=>({file,tempDir:root}),
    inspect:async()=>({
      kind:"pdf",format:"pdf",extension:"pdf",sizeBytes:bytes.length
    }),
    preparePdf:async()=>({
      originalFile:file,detectedFormat:"pdf",archiveExtension:"pdf",
      pageImages:[join(root,"page-1.png")],extractedText:"PDF 正文",
      documentFacts:{pageCount:1,textAvailable:true}
    }),
    prepareOffice:async()=>{throw new Error("unexpected");},
    prepareTextFile:async()=>{throw new Error("unexpected");},
    cleanup:async()=>{}
  });
  try {
    const result=await prepare({
      source:"feishu",sourceMessageId:"m1",
      instructionText:"整理后保存到日常生活",
      attachments:[{
        type:"file",sourceAttachmentId:"file_1",
        displayName:"材料.pdf",extension:"pdf"
      }]
    });
    assert.equal(result.evidence.kind,"pdf");
    assert.equal(result.evidence.integrity,"complete");
    assert.equal(result.evidence.text,"PDF 正文");
    assert.deepEqual(result.imageFiles,[join(root,"page-1.png")]);
    assert.deepEqual(result.preparedSource.sourceBytes,bytes);
    assert.equal(result.analysisInput.originalFile,file);
    await result.cleanup();
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("prepares a text turn without downloading an attachment",async()=>{
  let downloads=0;
  const prepare=createAssistantSourcePreparer({
    download:async()=>{downloads+=1;},
    inspect:async()=>{},
    preparePdf:async()=>{},
    prepareOffice:async()=>{},
    prepareTextFile:async()=>{}
  });
  const result=await prepare({
    source:"wechat",sourceMessageId:"m2",
    instructionText:"把这段文字保存下来",attachments:[]
  });
  assert.equal(downloads,0);
  assert.equal(result.evidence.kind,"text");
  assert.equal(result.preparedSource.content,"把这段文字保存下来");
  assert.deepEqual(result.imageFiles,[]);
});

