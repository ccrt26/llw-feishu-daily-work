import test from "node:test";
import assert from "node:assert/strict";
import {chmod,mkdtemp,mkdir,readFile,readdir,realpath,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {invokeKnowledgeDecision} from "../src/capabilities/knowledge-ingest/decision-client.mjs";

const fakeCodex=fileURLToPath(new URL("./fixtures/fake-codex.mjs",import.meta.url));
const libraries=[
  {
    libraryKey:"work-knowledge",displayName:"Synthetic Work",
    aliases:["Synthetic Work Library"],existingFolders:[["Synthetic Client","Exchange Plan"]]
  },
  {
    libraryKey:"personal-knowledge",displayName:"Synthetic Personal",
    aliases:[],existingFolders:[]
  }
];

const decision={
  action:"commit",confidence:"high",reason_code:"ready",question:"",
  library_key:"work-knowledge",
  folder_plan:{
    mode:"use_existing",segments:["Synthetic Client","Exchange Plan"],origin:"skill_suggested"
  },
  title:"Synthetic Exchange Plan",summary:"A grounded synthetic summary.",
  tags:["synthetic"],note_file:"knowledge.md",
  source_integrity:"complete",preserve_source:true
};

async function harness() {
  const root=await mkdtemp(join(tmpdir(),"llw-knowledge-client-"));
  const skillRoot=join(root,"private-skill");
  const references=join(skillRoot,"references");
  const tempRoot=join(root,"jobs");
  await mkdir(references,{recursive:true,mode:0o700});
  await writeFile(
    join(skillRoot,"SKILL.md"),
    "---\nname: llw-knowledge-ingest\ndescription: Use when synthetic.\n---\n# Synthetic\n",
    {mode:0o600}
  );
  await writeFile(
    join(references,"output-schema.json"),
    JSON.stringify({type:"object"}),
    {mode:0o600}
  );
  await writeFile(join(references,"source-integrity.md"),"# Synthetic\n",{mode:0o600});
  await mkdir(join(root,"other-private-skill"),{mode:0o700});
  await writeFile(join(root,"other-private-skill","secret.md"),"must-not-copy",{mode:0o600});
  await chmod(fakeCodex,0o755);
  return {root,skillRoot,tempRoot};
}

test("runs Codex read-only with only the selected Skill and AI-safe context",async()=>{
  const h=await harness();
  const argsFile=join(h.root,"args.json");
  const stdinFile=join(h.root,"stdin.txt");
  const cwdFile=join(h.root,"cwd.json");
  const request="Save the synthetic Aurora note to the work library.";
  const source={
    version:1,sourceKind:"text",detectedFormat:"text",displayName:"message.txt",
    sizeBytes:Buffer.byteLength(request),sha256:"a".repeat(64),
    jobSourceName:"source.txt",safeSourceReference:""
  };
  try {
    const result=await invokeKnowledgeDecision({
      codexPath:fakeCodex,
      skillRoot:h.skillRoot,
      tempRoot:h.tempRoot,
      input:{request,source,sourceContent:request,allowedLibraries:libraries,taskSummary:null},
      environment:{
        ...process.env,
        FAKE_ARGS_FILE:argsFile,
        FAKE_STDIN_FILE:stdinFile,
        FAKE_CWD_FILE:cwdFile,
        FAKE_RESPONSE:JSON.stringify(decision)
      }
    });
    assert.deepEqual(result,decision);
    const args=JSON.parse(await readFile(argsFile,"utf8"));
    assert.deepEqual(args.slice(0,5),[
      "exec","--ephemeral","--sandbox","read-only","--skip-git-repo-check"
    ]);
    assert.equal(args.includes("--output-schema"),true);
    const context=await readFile(stdinFile,"utf8");
    assert.match(context,/\$llw-knowledge-ingest/);
    assert.match(context,/synthetic Aurora/);
    assert.equal(context.includes(h.root),false);
    assert.equal(context.includes("must-not-copy"),false);
    const cwd=JSON.parse(await readFile(cwdFile,"utf8"));
    assert.deepEqual(cwd.skills,["llw-knowledge-ingest"]);
    assert.equal(cwd.cwd.startsWith(await realpath(h.tempRoot)),true);
    assert.deepEqual(await readdir(h.tempRoot),[]);
  } finally { await rm(h.root,{recursive:true,force:true}); }
});

test("ignores macOS AppleDouble metadata when copying the selected Skill",async()=>{
  const h=await harness();
  const request="Save one synthetic note.";
  const source={
    version:1,sourceKind:"text",detectedFormat:"text",displayName:"message.txt",
    sizeBytes:Buffer.byteLength(request),sha256:"d".repeat(64),
    jobSourceName:"source.txt",safeSourceReference:""
  };
  try {
    await writeFile(
      join(h.skillRoot,"references","._source-integrity.md"),
      "synthetic AppleDouble metadata",
      {mode:0o600}
    );
    const result=await invokeKnowledgeDecision({
      codexPath:fakeCodex,skillRoot:h.skillRoot,tempRoot:h.tempRoot,
      input:{request,source,sourceContent:request,allowedLibraries:libraries,taskSummary:null},
      environment:{...process.env,FAKE_RESPONSE:JSON.stringify(decision)}
    });
    assert.deepEqual(result,decision);
    assert.deepEqual(await readdir(h.tempRoot),[]);
  } finally { await rm(h.root,{recursive:true,force:true}); }
});

test("rejects invalid output, unknown models and unsafe private Skill files without leakage",async()=>{
  const h=await harness();
  const request="Save one synthetic note.";
  const source={
    version:1,sourceKind:"text",detectedFormat:"text",displayName:"message.txt",
    sizeBytes:Buffer.byteLength(request),sha256:"b".repeat(64),
    jobSourceName:"source.txt",safeSourceReference:""
  };
  const common={
    codexPath:fakeCodex,skillRoot:h.skillRoot,tempRoot:h.tempRoot,
    input:{request,source,sourceContent:request,allowedLibraries:libraries,taskSummary:null}
  };
  try {
    await assert.rejects(
      ()=>invokeKnowledgeDecision({
        ...common,
        environment:{...process.env,FAKE_RESPONSE:JSON.stringify({...decision,library_key:"unknown"})}
      }),
      error=>error.message==="knowledge_decision_failed"
    );
    await writeFile(join(h.skillRoot,"references","unsafe-link-target"),"private",{mode:0o600});
    await rm(join(h.skillRoot,"SKILL.md"));
    const {symlink}=await import("node:fs/promises");
    await symlink(join(h.skillRoot,"references","unsafe-link-target"),join(h.skillRoot,"SKILL.md"));
    await assert.rejects(
      ()=>invokeKnowledgeDecision({
        ...common,
        environment:{...process.env,FAKE_RESPONSE:JSON.stringify(decision)}
      }),
      error=>error.message==="knowledge_decision_failed"
    );
    assert.deepEqual(await readdir(h.tempRoot),[]);
  } finally { await rm(h.root,{recursive:true,force:true}); }
});

test("retries one transient Codex exit within the bounded policy",async()=>{
  const h=await harness();
  const attempts=join(h.root,"attempts.txt");
  const request="Save one synthetic note.";
  const source={
    version:1,sourceKind:"text",detectedFormat:"text",displayName:"message.txt",
    sizeBytes:Buffer.byteLength(request),sha256:"c".repeat(64),
    jobSourceName:"source.txt",safeSourceReference:""
  };
  try {
    const result=await invokeKnowledgeDecision({
      codexPath:fakeCodex,skillRoot:h.skillRoot,tempRoot:h.tempRoot,
      input:{request,source,sourceContent:request,allowedLibraries:libraries,taskSummary:null},
      maxAttempts:2,retryDelayMs:1,
      environment:{
        ...process.env,FAKE_CODEX_MODE:"transient",FAKE_CODEX_ATTEMPTS:attempts,
        FAKE_RESPONSE:JSON.stringify(decision)
      }
    });
    assert.deepEqual(result,decision);
    assert.equal(await readFile(attempts,"utf8"),"2");
    assert.deepEqual(await readdir(h.tempRoot),[]);
  } finally { await rm(h.root,{recursive:true,force:true}); }
});
