import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {chmod,lstat,mkdir,mkdtemp,readFile,rm,symlink,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {loadPrivateSkillManifest} from "../src/core/private-skill-manifest.mjs";

const PRIVATE_MARKER="Synthetic private fixture marker that must never be returned.";
const ROUTING=Buffer.from('{"capability":"synthetic-alpha"}\n');
const SCHEMA=Buffer.from('{"type":"object","additionalProperties":false}\n');
const SKILL=Buffer.from(`---\nname: synthetic-alpha\n---\n${PRIVATE_MARKER}\n`);
const fields={
  name:"synthetic-alpha",
  version:"1.2.3",
  enabled:true,
  capability:"synthetic-alpha",
  semantic_tasks:["synthetic.run"],
  model_support:["codex"],
  skill_sha256:sha(SKILL),
  routing_contract_sha256:sha(ROUTING),
  output_schema_sha256:sha(SCHEMA)
};
const allowlist=[{
  name:"synthetic-alpha",
  capability:"synthetic-alpha",
  versions:["1.2.3"],
  semanticTasks:["synthetic.run"],
  modelSupport:["codex"],
  enabled:true
}];

function sha(value) { return createHash("sha256").update(value).digest("hex"); }

async function fixture({nullReferences=false}={}) {
  const outer=await mkdtemp(join(tmpdir(),"llw-private-skill-"));
  const root=join(outer,"private-skills");
  const skillRoot=join(root,"synthetic-alpha");
  const references=join(skillRoot,"references");
  await mkdir(references,{recursive:true,mode:0o700});
  await writeFile(join(skillRoot,"SKILL.md"),SKILL,{mode:0o600});
  const entry={...fields};
  if (nullReferences) {
    entry.routing_contract_sha256=null;
    entry.output_schema_sha256=null;
  } else {
    await writeFile(join(references,"routing-contract.json"),ROUTING,{mode:0o600});
    await writeFile(join(references,"output-schema.json"),SCHEMA,{mode:0o600});
  }
  const manifest={manifest_version:1,skills:[entry]};
  const manifestPath=join(root,"manifest.json");
  const bytes=Buffer.from(`${JSON.stringify(manifest,null,2)}\n`);
  await writeFile(manifestPath,bytes,{mode:0o600});
  return {
    outer,root,skillRoot,references,manifestPath,manifest,bytes,
    options:{root,manifestPath,expectedManifestSha256:sha(bytes),allowlist}
  };
}

async function rewriteManifest(value,mutate) {
  const manifest=structuredClone(value.manifest);
  mutate(manifest);
  const bytes=Buffer.from(`${JSON.stringify(manifest,null,2)}\n`);
  await writeFile(value.manifestPath,bytes,{mode:0o600});
  value.options.expectedManifestSha256=sha(bytes);
}

async function rejected(options) {
  await assert.rejects(
    ()=>loadPrivateSkillManifest(options),
    error=>error?.message==="private_skill_manifest_invalid"&&
      !JSON.stringify(error).includes(PRIVATE_MARKER)&&
      !error.message.includes(options.root)
  );
}

test("loads one strict synthetic manifest and returns metadata without private content or hashes",async()=>{
  const value=await fixture();
  try {
    const result=await loadPrivateSkillManifest(value.options);
    assert.deepEqual(result,{
      manifestVersion:1,
      manifestSha256:sha(value.bytes),
      skills:[{
        name:"synthetic-alpha",
        version:"1.2.3",
        enabled:true,
        capability:"synthetic-alpha",
        semanticTasks:["synthetic.run"],
        modelSupport:["codex"],
        root:value.skillRoot
      }]
    });
    const serialized=JSON.stringify(result);
    assert.equal(serialized.includes(PRIVATE_MARKER),false);
    assert.equal(serialized.includes(fields.skill_sha256),false);
    assert.equal(serialized.includes(fields.routing_contract_sha256),false);
    assert.equal(serialized.includes(fields.output_schema_sha256),false);
  } finally { await rm(value.outer,{recursive:true,force:true}); }
});

test("accepts null reference hashes only when the reference files are absent",async()=>{
  const value=await fixture({nullReferences:true});
  try {
    await assert.doesNotReject(()=>loadPrivateSkillManifest(value.options));
    await writeFile(join(value.references,"routing-contract.json"),ROUTING,{mode:0o600});
    await rejected(value.options);
  } finally { await rm(value.outer,{recursive:true,force:true}); }
});

test("rejects manifest hash, JSON, schema and duplicate-name mutations with one bounded error",async()=>{
  for (const mutation of ["hash","json","top-field","entry-field","duplicate"]) {
    const value=await fixture();
    try {
      if (mutation==="hash") value.options.expectedManifestSha256="0".repeat(64);
      else if (mutation==="json") {
        await writeFile(value.manifestPath,"{\n",{mode:0o600});
        value.options.expectedManifestSha256=sha(Buffer.from("{\n"));
      } else {
        await rewriteManifest(value,manifest=>{
          if (mutation==="top-field") manifest.extra=true;
          if (mutation==="entry-field") manifest.skills[0].extra=true;
          if (mutation==="duplicate") manifest.skills.push(structuredClone(manifest.skills[0]));
        });
      }
      await rejected(value.options);
    } finally { await rm(value.outer,{recursive:true,force:true}); }
  }
});

test("rejects every static allowlist mismatch instead of enabling an unknown Skill",async()=>{
  const mutations=[
    list=>list[0].name="synthetic-other",
    list=>list[0].capability="synthetic-other",
    list=>list[0].versions=["1.2.4"],
    list=>list[0].semanticTasks=["synthetic.other"],
    list=>list[0].modelSupport=["deepseek"],
    list=>list[0].enabled=false,
    list=>list.push(structuredClone(list[0]))
  ];
  for (const mutate of mutations) {
    const value=await fixture();
    try {
      const changed=structuredClone(allowlist);
      mutate(changed);
      await rejected({...value.options,allowlist:changed});
    } finally { await rm(value.outer,{recursive:true,force:true}); }
  }
});

test("rejects malformed manifest field values before any Skill can be selected",async()=>{
  const mutations=[
    entry=>entry.version="v1",
    entry=>entry.enabled="true",
    entry=>entry.capability="Bad_Name",
    entry=>entry.semantic_tasks=[],
    entry=>entry.semantic_tasks=["synthetic.run","synthetic.run"],
    entry=>entry.model_support=["unknown"],
    entry=>entry.skill_sha256="ABC",
    entry=>entry.routing_contract_sha256=42
  ];
  for (const mutate of mutations) {
    const value=await fixture();
    try {
      await rewriteManifest(value,manifest=>mutate(manifest.skills[0]));
      await rejected(value.options);
    } finally { await rm(value.outer,{recursive:true,force:true}); }
  }
});

test("rejects broad permissions, symlinks, path escape, missing files and hash mismatch",async()=>{
  const mutations=[
    async value=>chmod(value.root,0o755),
    async value=>chmod(value.manifestPath,0o640),
    async value=>chmod(value.skillRoot,0o755),
    async value=>chmod(join(value.skillRoot,"SKILL.md"),0o640),
    async value=>rm(join(value.skillRoot,"SKILL.md")),
    async value=>{
      await writeFile(join(value.skillRoot,"SKILL.md"),Buffer.from("changed\n"),{mode:0o600});
    },
    async value=>{
      const target=join(value.outer,"manifest-target.json");
      await writeFile(target,value.bytes,{mode:0o600});
      await rm(value.manifestPath);
      await symlink(target,value.manifestPath);
    },
    async value=>{
      const target=join(value.outer,"skill-target.md");
      await writeFile(target,SKILL,{mode:0o600});
      await rm(join(value.skillRoot,"SKILL.md"));
      await symlink(target,join(value.skillRoot,"SKILL.md"));
    },
    async value=>{
      const outside=join(value.outer,"outside.json");
      await writeFile(outside,value.bytes,{mode:0o600});
      value.options.manifestPath=outside;
    }
  ];
  for (const mutate of mutations) {
    const value=await fixture();
    try {
      await mutate(value);
      await rejected(value.options);
    } finally { await rm(value.outer,{recursive:true,force:true}); }
  }
});

test("rejects a symlinked root and never changes fixture bytes",async()=>{
  const value=await fixture();
  const alias=join(value.outer,"private-skills-alias");
  try {
    const before=await readFile(value.manifestPath);
    await symlink(value.root,alias);
    await rejected({...value.options,root:alias,manifestPath:join(alias,"manifest.json")});
    assert.deepEqual(await readFile(value.manifestPath),before);
    assert.equal((await lstat(value.manifestPath)).isFile(),true);
  } finally { await rm(value.outer,{recursive:true,force:true}); }
});
