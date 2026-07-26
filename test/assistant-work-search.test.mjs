import test from "node:test";
import assert from "node:assert/strict";
import {chmod,mkdir,mkdtemp,symlink,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  loadKnowledgeSources,searchKnowledge
} from "../src/capabilities/assistant-work/knowledge-search.mjs";

async function fixture(){
  const vault=await mkdtemp(join(tmpdir(),"llw-aw-search-"));
  await chmod(vault,0o700);
  const work=join(vault,"工作资料"),life=join(vault,"生活资料");
  await mkdir(join(work,"合成项目"),{recursive:true,mode:0o700});
  await mkdir(life,{mode:0o700});
  await writeFile(join(work,"合成项目","验收.md"),"---\ntags: [验收, 合成]\n---\n# 合成项目验收\n需要书面确认。",{mode:0o600});
  await writeFile(join(work,"合成项目","其他.md"),"# 其他\n不相关正文。",{mode:0o600});
  await writeFile(join(life,"清单.md"),"# 生活清单\n合成咖啡豆。",{mode:0o600});
  return {vault,libraries:[
    {libraryKey:"work",root:work},{libraryKey:"life",root:life}
  ]};
}

test("searches title, tags and body only in allowed libraries and returns verified Vault-relative paths",async()=>{
  const f=await fixture();
  const results=await searchKnowledge({
    vaultRoot:f.vault,libraries:f.libraries,query:"验收 书面确认",
    maxFiles:20,maxFileBytes:4096,maxResults:5,maxTotalExcerptBytes:8192
  });
  assert.equal(results[0].path,"工作资料/合成项目/验收.md");
  assert.match(results[0].excerpt,/书面确认/);
  assert.equal(results.every(item=>!item.path.startsWith("/")&&!item.path.includes("..")),true);
});

test("uses bounded deterministic results and ignores non-Markdown files",async()=>{
  const f=await fixture();
  await writeFile(join(f.libraries[0].root,"合成项目","secret.txt"),"验收 书面确认",{mode:0o600});
  const results=await searchKnowledge({
    vaultRoot:f.vault,libraries:f.libraries,query:"合成",
    maxFiles:20,maxFileBytes:4096,maxResults:1,maxTotalExcerptBytes:256
  });
  assert.equal(results.length,1);
  assert.equal(results[0].path.endsWith(".md"),true);
  assert.ok(Buffer.byteLength(results[0].excerpt,"utf8")<=256);
});

test("fails closed on a symlinked library or escaping Markdown file",async()=>{
  const f=await fixture();
  const outside=await mkdtemp(join(tmpdir(),"llw-aw-outside-"));
  await writeFile(join(outside,"outside.md"),"# 验收\n不应读取",{mode:0o600});
  const link=join(f.vault,"链接资料");
  await symlink(outside,link);
  await assert.rejects(()=>searchKnowledge({
    vaultRoot:f.vault,libraries:[{libraryKey:"bad",root:link}],query:"验收",
    maxFiles:20,maxFileBytes:4096,maxResults:5,maxTotalExcerptBytes:8192
  }),/knowledge_search_rejected/);
  await symlink(join(outside,"outside.md"),join(f.libraries[0].root,"合成项目","逃逸.md"));
  await assert.rejects(()=>searchKnowledge({
    vaultRoot:f.vault,libraries:f.libraries,query:"验收",
    maxFiles:20,maxFileBytes:4096,maxResults:5,maxTotalExcerptBytes:8192
  }),/knowledge_search_rejected/);
});

test("reloads only previously verified relative sources for a continuation",async()=>{
  const f=await fixture();
  const results=await loadKnowledgeSources({
    vaultRoot:f.vault,libraries:f.libraries,
    sourcePaths:["工作资料/合成项目/验收.md"],
    maxFileBytes:4096,maxTotalExcerptBytes:8192
  });
  assert.equal(results[0].path,"工作资料/合成项目/验收.md");
  assert.match(results[0].excerpt,/书面确认/);
  await assert.rejects(()=>loadKnowledgeSources({
    vaultRoot:f.vault,libraries:f.libraries,sourcePaths:["../outside.md"],
    maxFileBytes:4096,maxTotalExcerptBytes:8192
  }),/knowledge_search_rejected/);
});
