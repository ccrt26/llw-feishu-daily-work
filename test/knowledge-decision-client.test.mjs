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
  action:"commit",confidence:"high",reason_code:"ready",
  library_key:"Synthetic Work Library",
  target:{
    scope:"existing_folder",segments:["Synthetic Client","Exchange Plan"],
    origin:"skill_suggested"
  },
  title:"Synthetic Exchange Plan",summary:"A grounded synthetic summary.",
  tags:["synthetic"],
  knowledge_sections:{
    key_facts:["A grounded fact."],
    structure_and_main_content:"A grounded structure.",
    reusable_content:["A reusable item."],
    source_notes:"Extracted completely.",
    content_index:"Section 1"
  },
  source_integrity:"complete"
};

const normalizedDecision={
  action:"commit",reasonCode:"ready",question:"",
  libraryKey:"work-knowledge",
  target:{
    scope:"existing_folder",segments:["Synthetic Client","Exchange Plan"],
    origin:"skill_suggested"
  },
  title:"Synthetic Exchange Plan",summary:"A grounded synthetic summary.",
  tags:["synthetic"],
  knowledgeSections:{
    keyFacts:["A grounded fact."],
    structureAndMainContent:"A grounded structure.",
    reusableContent:["A reusable item."],
    sourceNotes:"Extracted completely.",
    contentIndex:"Section 1"
  },
  sourceIntegrity:"complete"
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
    assert.deepEqual(result,normalizedDecision);
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
    assert.deepEqual(result,normalizedDecision);
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
    assert.deepEqual(result,normalizedDecision);
    assert.equal(await readFile(attempts,"utf8"),"2");
    assert.deepEqual(await readdir(h.tempRoot),[]);
  } finally { await rm(h.root,{recursive:true,force:true}); }
});

test("returns bounded stage codes for every private decision-client failure boundary",async()=>{
  const request="Save one synthetic note.";
  const source={
    version:1,sourceKind:"text",detectedFormat:"text",displayName:"message.txt",
    sizeBytes:Buffer.byteLength(request),sha256:"e".repeat(64),
    jobSourceName:"source.txt",safeSourceReference:""
  };
  const input={
    request,source,sourceContent:request,allowedLibraries:libraries,taskSummary:null
  };
  const cases=[
    {
      name:"copy",
      prepare:async h=>writeFile(
        join(h.skillRoot,"references",".DS_Store"),
        "synthetic metadata",
        {mode:0o600}
      ),
      invoke:h=>({
        codexPath:fakeCodex,skillRoot:h.skillRoot,tempRoot:h.tempRoot,input,
        environment:{...process.env,FAKE_RESPONSE:JSON.stringify(decision)}
      }),
      expected:"knowledge_decision_copy_failed"
    },
    {
      name:"spawn",
      invoke:h=>({
        codexPath:join(h.root,"missing-codex"),
        skillRoot:h.skillRoot,tempRoot:h.tempRoot,input,
        environment:{...process.env}
      }),
      expected:"knowledge_decision_spawn_failed"
    },
    {
      name:"timeout",
      invoke:h=>({
        codexPath:fakeCodex,skillRoot:h.skillRoot,tempRoot:h.tempRoot,input,
        timeoutMs:20,maxAttempts:1,retryDelayMs:0,
        environment:{
          ...process.env,FAKE_CODEX_MODE:"timeout",
          FAKE_RESPONSE:JSON.stringify(decision)
        }
      }),
      expected:"knowledge_decision_timeout"
    },
    {
      name:"process",
      invoke:h=>({
        codexPath:fakeCodex,skillRoot:h.skillRoot,tempRoot:h.tempRoot,input,
        maxAttempts:2,retryDelayMs:0,
        environment:{
          ...process.env,FAKE_CODEX_MODE:"process-failure",
          FAKE_RESPONSE:JSON.stringify(decision)
        }
      }),
      expected:"knowledge_decision_process_failed",
      metrics:{stderrBytes:44,retryCount:1}
    },
    {
      name:"missing output",
      invoke:h=>({
        codexPath:fakeCodex,skillRoot:h.skillRoot,tempRoot:h.tempRoot,input,
        environment:{
          ...process.env,FAKE_CODEX_MODE:"no-output",
          FAKE_RESPONSE:JSON.stringify(decision)
        }
      }),
      expected:"knowledge_decision_output_failed"
    },
    {
      name:"invalid JSON",
      invoke:h=>({
        codexPath:fakeCodex,skillRoot:h.skillRoot,tempRoot:h.tempRoot,input,
        environment:{
          ...process.env,FAKE_CODEX_MODE:"raw",FAKE_RESPONSE:"not-json"
        }
      }),
      expected:"knowledge_decision_output_failed"
    },
    {
      name:"validation",
      invoke:h=>({
        codexPath:fakeCodex,skillRoot:h.skillRoot,tempRoot:h.tempRoot,input,
        environment:{
          ...process.env,
          FAKE_RESPONSE:JSON.stringify({...decision,library_key:"unknown"})
        }
      }),
      expected:"knowledge_decision_validation_failed"
    }
  ];
  for (const entry of cases) {
    const h=await harness();
    try {
      await entry.prepare?.(h);
      let caught;
      try { await invokeKnowledgeDecision(entry.invoke(h)); }
      catch (error) { caught=error; }
      assert.equal(caught?.message,"knowledge_decision_failed",entry.name);
      assert.equal(caught?.code,entry.expected,entry.name);
      if (entry.metrics) {
        assert.equal(caught.stderrBytes,entry.metrics.stderrBytes,entry.name);
        assert.equal(caught.retryCount,entry.metrics.retryCount,entry.name);
      }
      const serialized=JSON.stringify(caught);
      for (const forbidden of [
        "synthetic private stderr","/Users/owner/secret",h.root,request
      ]) assert.equal(serialized.includes(forbidden),false,entry.name);
      assert.deepEqual(await readdir(h.tempRoot),[],entry.name);
    } finally {
      await rm(h.root,{recursive:true,force:true});
    }
  }
});
