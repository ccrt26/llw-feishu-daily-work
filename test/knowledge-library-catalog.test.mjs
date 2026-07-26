import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,rm,symlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createKnowledgeLibraryCatalog} from "../src/capabilities/knowledge-ingest/library-catalog.mjs";

async function harness() {
  const root=await mkdtemp(join(tmpdir(),"llw-knowledge-catalog-"));
  const work=join(root,"work"),personal=join(root,"personal");
  await mkdir(join(work,"Synthetic Client","Exchange Plan"),{recursive:true});
  await mkdir(join(personal,"Reading"),{recursive:true});
  return {
    root,work,personal,
    libraries:[
      {
        libraryKey:"work-knowledge",displayName:"Synthetic Work",
        aliases:["Synthetic Work Library"],root:work
      },
      {
        libraryKey:"personal-knowledge",displayName:"Synthetic Personal",
        aliases:[],root:personal
      }
    ]
  };
}

test("returns only bounded AI-safe descriptors and verified relative folder segments",async()=>{
  const h=await harness();
  try {
    await mkdir(join(h.work,".hidden"),{recursive:true});
    const result=await createKnowledgeLibraryCatalog(h.libraries);
    assert.deepEqual(result,[
      {
        libraryKey:"work-knowledge",
        displayName:"Synthetic Work",
        aliases:["Synthetic Work Library"],
        existingFolders:[
          ["Synthetic Client"],
          ["Synthetic Client","Exchange Plan"]
        ]
      },
      {
        libraryKey:"personal-knowledge",
        displayName:"Synthetic Personal",
        aliases:[],
        existingFolders:[["Reading"]]
      }
    ]);
    const serialized=JSON.stringify(result);
    assert.equal(serialized.includes(h.root),false);
    assert.equal(serialized.includes(".hidden"),false);
  } finally { await rm(h.root,{recursive:true,force:true}); }
});

test("rejects symlinked, malformed and over-count managed folder catalogs",async()=>{
  const h=await harness();
  const outside=await mkdtemp(join(tmpdir(),"llw-knowledge-catalog-outside-"));
  try {
    await symlink(outside,join(h.work,"linked"));
    await assert.rejects(
      ()=>createKnowledgeLibraryCatalog(h.libraries),
      /knowledge_library_catalog_invalid/
    );
    await rm(join(h.work,"linked"));
    await mkdir(join(h.work,"bad\nname"));
    await assert.rejects(
      ()=>createKnowledgeLibraryCatalog(h.libraries),
      /knowledge_library_catalog_invalid/
    );
    await rm(join(h.work,"bad\nname"),{recursive:true});
    for (let index=0;index<4;index++) await mkdir(join(h.work,`folder-${index}`));
    await assert.rejects(
      ()=>createKnowledgeLibraryCatalog(h.libraries,{maxFolders:5}),
      /knowledge_library_catalog_invalid/
    );
  } finally {
    await rm(h.root,{recursive:true,force:true});
    await rm(outside,{recursive:true,force:true});
  }
});

test("stops at five levels and rejects an unsafe managed root identity",async()=>{
  const h=await harness();
  const outside=await mkdtemp(join(tmpdir(),"llw-knowledge-root-outside-"));
  try {
    await mkdir(join(h.personal,"one","two","three","four","five","six"),{recursive:true});
    const result=await createKnowledgeLibraryCatalog(h.libraries);
    const personal=result.find(item=>item.libraryKey==="personal-knowledge");
    assert.equal(personal.existingFolders.some(parts=>parts.includes("six")),false);
    await rm(h.personal,{recursive:true,force:true});
    await symlink(outside,h.personal);
    await assert.rejects(
      ()=>createKnowledgeLibraryCatalog(h.libraries),
      /knowledge_library_catalog_invalid/
    );
  } finally {
    await rm(h.root,{recursive:true,force:true});
    await rm(outside,{recursive:true,force:true});
  }
});
