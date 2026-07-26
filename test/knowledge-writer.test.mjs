import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {
  chmod,lstat,mkdtemp,mkdir,readFile,readdir,realpath,rm,symlink,writeFile
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {KnowledgeWriter} from "../src/capabilities/knowledge-ingest/knowledge-writer.mjs";

const FIRST_TEXT="原始交流内容。";
const FIRST_SHA="8a080d37fb08374496545f410ff755f79b6e1688766f4bae92fd32e1bc787a32";
const FIRST_ID="04a88556baab09de2f52639490f59d5afecd3a18b72ba2c4c50f71d758d58d9d";

async function harness() {
  const root=await mkdtemp(join(tmpdir(),"llw-knowledge-vault-"));
  await mkdir(join(root,".obsidian"),{mode:0o700});
  await mkdir(join(root,".llw-system"),{mode:0o700});
  await writeFile(join(root,".llw-system","SYSTEM_MAP.md"),"# synthetic\n",{mode:0o600});
  const work=join(root,"work-library"),personal=join(root,"personal-library");
  await mkdir(work,{mode:0o700}); await mkdir(personal,{mode:0o700});
  const libraries=[
    {libraryKey:"work-knowledge",displayName:"Synthetic Work",aliases:[],root:work},
    {libraryKey:"personal-knowledge",displayName:"Synthetic Personal",aliases:[],root:personal}
  ];
  return {root,work,personal,libraries,writer:new KnowledgeWriter({vaultRoot:root,libraries})};
}

function source(content=FIRST_TEXT,overrides={}) {
  const sha256=createHash("sha256").update(content,"utf8").digest("hex");
  return {
    version:1,sourceKind:"text",detectedFormat:"text",displayName:"message.txt",
    sizeBytes:Buffer.byteLength(content),sha256,jobSourceName:"source.txt",
    safeSourceReference:"",content,...overrides
  };
}

function commitInput(overrides={}) {
  return {
    libraryKey:"work-knowledge",folderSegments:["亚信工作","工作文档","交流方案"],
    title:"交流方案",summary:"用于测试的交流方案摘要。",tags:["项目","沟通"],
    source:source(),skillVersion:"1.2.0",preserveSource:true,...overrides
  };
}

test("atomically creates one deterministic direct-text knowledge item",async()=>{
  const h=await harness();
  try {
    const result=await h.writer.commit(commitInput());
    assert.deepEqual(result,{
      status:"created",knowledgeId:FIRST_ID,libraryKey:"work-knowledge",
      relativePath:"work-library/亚信工作/工作文档/交流方案/交流方案",
      files:["work-library/亚信工作/工作文档/交流方案/交流方案/knowledge.md"]
    });
    const expected=`---\nllw_schema: "knowledge-item/v1"\nknowledge_id: "${FIRST_ID}"\nlibrary_key: "work-knowledge"\ntitle: "交流方案"\ntags:\n  - "项目"\n  - "沟通"\nsource_kind: "text"\nsource_format: "text"\nsource_display_name: "message.txt"\nsource_sha256: "${FIRST_SHA}"\nsource_size_bytes: 21\nskill_version: "1.2.0"\npreserve_source: true\n---\n\n# 交流方案\n\n## 摘要\n\n用于测试的交流方案摘要。\n\n## 原始内容\n\n原始交流内容。\n`;
    const item=join(h.root,result.relativePath);
    assert.equal(await readFile(join(item,"knowledge.md"),"utf8"),expected);
    assert.deepEqual(await readdir(item),["knowledge.md"]);
    assert.equal((await lstat(item)).mode&0o777,0o700);
    assert.equal((await lstat(join(item,"knowledge.md"))).mode&0o777,0o600);
  } finally { await rm(h.root,{recursive:true,force:true}); }
});

test("commits directly under a selected managed library root without creating a category",async()=>{
  const h=await harness();
  try {
    const result=await h.writer.commit(commitInput({
      libraryKey:"personal-knowledge",
      folderSegments:[],
      title:"根目录知识项"
    }));
    assert.equal(result.relativePath,"personal-library/根目录知识项");
    assert.deepEqual(await readdir(h.personal),["根目录知识项"]);
    assert.deepEqual(await readdir(join(h.personal,"根目录知识项")),["knowledge.md"]);
    assert.deepEqual(await readdir(h.work),[]);
  } finally { await rm(h.root,{recursive:true,force:true}); }
});

test("returns existing for a stable source and never overwrites a title collision",async()=>{
  const h=await harness();
  try {
    const first=await h.writer.commit(commitInput());
    const duplicate=await h.writer.commit(commitInput({title:"模型后来换了标题"}));
    assert.equal(duplicate.status,"existing");
    assert.equal(duplicate.knowledgeId,FIRST_ID);
    assert.equal(duplicate.relativePath,first.relativePath);
    const otherSource=source("另一份不同来源。");
    const different=await h.writer.commit(commitInput({source:otherSource}));
    assert.equal(different.status,"created");
    assert.match(different.relativePath,new RegExp(`/交流方案--${otherSource.sha256.slice(0,8)}$`));
    assert.equal(await readFile(join(h.root,first.relativePath,"knowledge.md"),"utf8")
      .then(value=>value.includes(FIRST_SHA)),true);
  } finally { await rm(h.root,{recursive:true,force:true}); }
});

test("keeps work and personal roots disjoint and preserves an optional Markdown source",async()=>{
  const h=await harness();
  const content="# 原始 Markdown\n\n正文。\n";
  const fileSource=source(content,{
    sourceKind:"file",detectedFormat:"md",displayName:"plan.md",jobSourceName:"source.md"
  });
  try {
    const result=await h.writer.commit(commitInput({
      libraryKey:"personal-knowledge",folderSegments:["生活","阅读"],
      title:"阅读笔记",summary:"一份生活资料。",tags:["生活"],
      source:fileSource,preserveSource:true
    }));
    assert.equal(result.relativePath.startsWith("personal-library/"),true);
    assert.deepEqual((await readdir(join(h.root,result.relativePath))).sort(),["knowledge.md","source.md"]);
    assert.equal(await readFile(join(h.root,result.relativePath,"source.md"),"utf8"),content);
    assert.deepEqual(await readdir(h.work),[]);
  } finally { await rm(h.root,{recursive:true,force:true}); }
});

test("preserves one verified Office source byte-for-byte without placing binary in Markdown",async()=>{
  const h=await harness();
  const sourceBytes=Buffer.from([
    0x50,0x4b,0x03,0x04,0x00,0x01,0x02,0x03,0xff,0x00,0x7f
  ]);
  const officeSource={
    version:1,sourceKind:"file",detectedFormat:"docx",
    displayName:"交流方案.docx",sizeBytes:sourceBytes.length,
    sha256:createHash("sha256").update(sourceBytes).digest("hex"),
    jobSourceName:"source.docx",safeSourceReference:"",
    content:"# Word 文档\n\n交流方案正文",sourceBytes
  };
  try {
    const result=await h.writer.commit(commitInput({
      source:officeSource,title:"Office 交流方案",preserveSource:true
    }));
    const item=join(h.root,result.relativePath);
    assert.deepEqual((await readdir(item)).sort(),["knowledge.md","source.docx"]);
    assert.equal(Buffer.compare(await readFile(join(item,"source.docx")),sourceBytes),0);
    const markdown=await readFile(join(item,"knowledge.md"),"utf8");
    assert.match(markdown,/source_format: "docx"/);
    assert.match(markdown,/交流方案正文/);
    assert.equal(markdown.includes(sourceBytes.toString("latin1")),false);
  } finally { await rm(h.root,{recursive:true,force:true}); }
});

test("records only a bounded hashed Feishu source reference and remains snapshot-idempotent",async()=>{
  const h=await harness();
  const sourceBytes=Buffer.from([0x50,0x4b,0x03,0x04,0x09,0x08,0x07]);
  const snapshot={
    version:1,sourceKind:"feishu_document",detectedFormat:"docx",
    displayName:"飞书交流方案.docx",sizeBytes:sourceBytes.length,
    sha256:createHash("sha256").update(sourceBytes).digest("hex"),
    jobSourceName:"source.docx",
    safeSourceReference:`feishu:${"a".repeat(64)}`,
    content:"# Word 文档\n\n飞书快照正文",sourceBytes
  };
  try {
    const first=await h.writer.commit(commitInput({
      source:snapshot,title:"飞书交流方案",preserveSource:true
    }));
    const duplicate=await h.writer.commit(commitInput({
      source:snapshot,title:"另一个标题",preserveSource:true
    }));
    assert.equal(first.status,"created");
    assert.equal(duplicate.status,"existing");
    assert.equal(duplicate.relativePath,first.relativePath);
    const markdown=await readFile(join(h.root,first.relativePath,"knowledge.md"),"utf8");
    assert.match(markdown,/source_kind: "feishu_document"/);
    assert.match(markdown,new RegExp(`safe_source_reference: "feishu:${"a".repeat(64)}"`));
    assert.equal(markdown.includes("doxcn"),false);
  } finally { await rm(h.root,{recursive:true,force:true}); }
});

test("creates only safe empty category folders and is idempotent",async()=>{
  const h=await harness();
  try {
    const first=await h.writer.createFolder({
      libraryKey:"work-knowledge",segments:["亚信工作","工作文档","交流方案"]
    });
    assert.deepEqual(first,{
      status:"created",libraryKey:"work-knowledge",
      relativePath:"work-library/亚信工作/工作文档/交流方案"
    });
    assert.equal((await lstat(join(h.work,"亚信工作","工作文档","交流方案"))).mode&0o777,0o700);
    assert.equal((await h.writer.createFolder({
      libraryKey:"work-knowledge",segments:["亚信工作","工作文档","交流方案"]
    })).status,"existing");
    for (const segments of [[".."],[".hidden"],["CON"],["a/b"],["a\\b"],[]]) {
      await assert.rejects(
        h.writer.createFolder({libraryKey:"work-knowledge",segments}),
        /knowledge_write_rejected/
      );
    }
  } finally { await rm(h.root,{recursive:true,force:true}); }
});

test("rejects missing Vault identity, root mismatch, nested roots and symlink components",async()=>{
  const h=await harness();
  const outside=await mkdtemp(join(tmpdir(),"llw-knowledge-outside-"));
  try {
    await rm(join(h.root,".llw-system","SYSTEM_MAP.md"));
    await assert.rejects(h.writer.commit(commitInput()),/knowledge_write_rejected/);
    await writeFile(join(h.root,".llw-system","SYSTEM_MAP.md"),"# synthetic\n",{mode:0o600});
    await symlink(outside,join(h.work,"link"));
    await assert.rejects(
      h.writer.commit(commitInput({folderSegments:["link"],title:"越界"})),
      /knowledge_write_rejected/
    );
    const alias=join(h.root,"alias-library");
    await symlink(outside,alias);
    const aliasWriter=new KnowledgeWriter({
      vaultRoot:h.root,libraries:[{libraryKey:"alias",root:alias}]
    });
    await assert.rejects(
      aliasWriter.createFolder({libraryKey:"alias",segments:["x"]}),
      /knowledge_write_rejected/
    );
    const nestedWriter=new KnowledgeWriter({
      vaultRoot:h.root,
      libraries:[
        {libraryKey:"outer",root:h.work},
        {libraryKey:"inner",root:join(h.work,"nested")}
      ]
    });
    await assert.rejects(
      nestedWriter.createFolder({libraryKey:"outer",segments:["x"]}),
      /knowledge_write_rejected/
    );
  } finally {
    await rm(h.root,{recursive:true,force:true});
    await rm(outside,{recursive:true,force:true});
  }
});

test("a staging failure leaves no item or staging residue",async()=>{
  const h=await harness();
  const category=join(h.work,"locked");
  await mkdir(category,{mode:0o700});
  await chmod(category,0o500);
  try {
    await assert.rejects(
      h.writer.commit(commitInput({folderSegments:["locked"],title:"不会写入"})),
      /knowledge_write_rejected/
    );
    assert.deepEqual(await readdir(category),[]);
  } finally {
    await chmod(category,0o700);
    await rm(h.root,{recursive:true,force:true});
  }
});

test("concurrent publication creates once and verifies fixed ordinary files",async()=>{
  const h=await harness();
  try {
    const results=await Promise.all([
      h.writer.commit(commitInput()),
      h.writer.commit(commitInput())
    ]);
    assert.deepEqual(results.map(item=>item.status).sort(),["created","existing"]);
    assert.equal(new Set(results.map(item=>item.relativePath)).size,1);
    const item=join(h.root,results[0].relativePath);
    assert.deepEqual(await readdir(item),["knowledge.md"]);
    const metadata=await lstat(join(item,"knowledge.md"));
    assert.equal(metadata.isFile(),true);
    assert.equal(metadata.isSymbolicLink(),false);
    assert.equal(createHash("sha256").update(await readFile(join(item,"knowledge.md")))
      .digest("hex").length,64);
    assert.equal((await realpath(item)).startsWith(await realpath(h.work)),true);
  } finally { await rm(h.root,{recursive:true,force:true}); }
});
