import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {
  chmod,lstat,mkdtemp,mkdir,readFile,realpath,rm,writeFile
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {
  invokePersonalAssistantCodex,invokePersonalAssistantDeepSeek
} from "../src/personal-assistant/invoke-personal-assistant.mjs";
import {
  loadPersonalAssistantSkillBundle
} from "../src/personal-assistant/skill-bundle.mjs";
import {
  buildPersonalAssistantOutputSchema,
  decodePersonalAssistantOutputEnvelopeForTools
} from "../src/personal-assistant/personal-assistant-output-schema.mjs";
import {
  getModelToolDeclarations
} from "../src/personal-assistant/tool-definitions.mjs";

const fixture=fileURLToPath(
  new URL("./fixtures/fake-codex.mjs",import.meta.url)
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function png(width,height,marker) {
  const value=Buffer.alloc(33,0);
  Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])
    .copy(value,0);
  value.writeUInt32BE(13,8);
  value.write("IHDR",12,"ascii");
  value.writeUInt32BE(width,16);
  value.writeUInt32BE(height,20);
  value[24]=8;
  value[25]=6;
  value[32]=marker;
  return value;
}

test("invokes one private Skill read-only with bounded context and visual pages",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-pa-invoke-"));
  const skillRoot=join(root,"llw-personal-assistant");
  const workspaceDir=join(root,"llw-turn-private");
  const argsFile=join(root,"args.json");
  const schemaCopyFile=join(root,"schema.json");
  const stdinFile=join(root,"stdin.txt");
  const cwdFile=join(root,"cwd.txt");
  try {
    await mkdir(join(skillRoot,"references"),{recursive:true,mode:0o700});
    await mkdir(workspaceDir,{mode:0o700});
    const imageFiles=[
      join(workspaceDir,"source-001.png"),
      join(workspaceDir,"source-002.png")
    ];
    const derivedBytes=png(12,16,3);
    const derivedImage=join(
      workspaceDir,"source-003.page-001.png"
    );
    await writeFile(imageFiles[0],"image-a",{mode:0o600});
    await writeFile(imageFiles[1],"image-b",{mode:0o600});
    await writeFile(derivedImage,derivedBytes,{mode:0o600});
    const modelImageFiles=[{
      sourceId:"source-003",
      relativePath:"source-003.page-001.png",
      sha256:sha256(derivedBytes),
      pageNumber:1
    }];
    await writeFile(
      join(skillRoot,"SKILL.md"),
      "---\nname: llw-personal-assistant\ndescription: test\n---\n# Test\n",
      {mode:0o600}
    );
    await writeFile(
      join(skillRoot,"references","model-policy.md"),
      "# Model policy\n",
      {mode:0o600}
    );
    await writeFile(
      join(skillRoot,"references","._model-policy.md"),
      "AppleDouble fixture marker that must not enter the prompt.\n",
      {mode:0o600}
    );
    const skillBundle=await loadPersonalAssistantSkillBundle({
      skillRoot,
      runtimeFiles:[
        {
          path:"SKILL.md",
          sha256:sha256(
            "---\nname: llw-personal-assistant\ndescription: test\n---\n# Test\n"
          )
        },
        {
          path:"references/model-policy.md",
          sha256:sha256("# Model policy\n")
        }
      ]
    });
    await chmod(fixture,0o755);
    const context={
      model:"codex",instructionText:"总结，不保存",
      currentTime:"2026-07-28T00:00:00.000Z",
      sources:[
        {
          sourceId:"source-001",displayName:"第一页.png",
          mediaClass:"image",format:"png",
          relativePath:"source-001.png",byteSize:7,
          sha256:"a".repeat(64),availability:"ready"
        },
        {
          sourceId:"source-002",displayName:"第二页.png",
          mediaClass:"image",format:"png",
          relativePath:"source-002.png",byteSize:7,
          sha256:"b".repeat(64),availability:"ready"
        }
      ],
      conversation:null,confirmedPersonalRules:[],
      tools:[{
        name:"save_knowledge",description:"save",
        parameters:{
          type:"object",additionalProperties:false,
          required:["title"],
          properties:{title:{type:"string"}}
        }
      }],
      priority:["program_safety"]
    };
    const result=await invokePersonalAssistantCodex({
      codexPath:fixture,workspaceDir,skillBundle,context,
      imageFiles,modelImageFiles,
      environment:{
        ...process.env,FAKE_ARGS_FILE:argsFile,FAKE_STDIN_FILE:stdinFile,
        FAKE_CWD_ONLY_FILE:cwdFile,
        FAKE_SCHEMA_FILE_COPY:schemaCopyFile,
        FAKE_RESPONSE:JSON.stringify({
          type:"reply",
          reply:{text:"只读总结。"},
          ask:null,sourceReadRequest:null,toolCall:null,taskUpdate:null
        })
      }
    });
    assert.deepEqual(result,{type:"reply",text:"只读总结。"});
    const args=JSON.parse(await readFile(argsFile,"utf8"));
    assert.deepEqual(args.slice(0,5),[
      "exec","--ephemeral","--sandbox","read-only","--skip-git-repo-check"
    ]);
    assert.equal(args.filter(value=>value==="--image").length,3);
    const schemaIndex=args.indexOf("--output-schema");
    assert.ok(schemaIndex>0);
    const schemaCopy=JSON.parse(await readFile(schemaCopyFile,"utf8"));
    assert.equal(schemaCopy.path,args[schemaIndex+1]);
    assert.equal(schemaCopy.mode,0o600);
    await assert.rejects(()=>lstat(schemaCopy.path),{code:"ENOENT"});
    assert.equal(schemaCopy.content.type,"object");
    assert.equal(schemaCopy.content.additionalProperties,false);
    assert.deepEqual(schemaCopy.content.required,[
      "type","reply","ask","sourceReadRequest","toolCall","taskUpdate"
    ]);
    assert.equal(
      schemaCopy.content.properties.toolCall.anyOf[1]
        .properties.toolName.const,
      "save_knowledge"
    );
    assert.deepEqual(
      schemaCopy.content.properties.toolCall.anyOf[1]
        .properties.arguments,
      context.tools[0].parameters
    );
    assert.ok(args.includes("source-001.png"));
    assert.ok(args.includes("source-002.png"));
    assert.ok(args.includes("source-003.page-001.png"));
    assert.equal(args.some(value=>value.includes(workspaceDir)),false);
    assert.equal(await readFile(cwdFile,"utf8"),await realpath(workspaceDir));
    assert.equal(args.some(value=>value.includes("总结，不保存")),false);
    const prompt=await readFile(stdinFile,"utf8");
    assert.match(prompt,/\$llw-personal-assistant/);
    assert.match(prompt,/总结，不保存/);
    assert.match(prompt,/save_knowledge/);
    assert.match(prompt,/original files are in the current read-only working directory/i);
    assert.match(prompt,/source-001/);
    assert.match(prompt,/source-002/);
    assert.doesNotMatch(prompt,/\/Volumes\/ZHUTONG/);
    assert.doesNotMatch(prompt,/AppleDouble fixture marker/u);
    assert.match(prompt,/不得提前宣称工具成功/);
    assert.match(
      prompt,
      /waiting_confirmation.*preparedRule/s
    );
    assert.match(
      prompt,
      /taskUpdate.*workingSummary.*confirmedRequirements.*rejectedDirections/s
    );
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("rejects every DeepSeek turn containing an original source",async()=>{
  let keyReads=0;
  await assert.rejects(()=>invokePersonalAssistantDeepSeek({
    model:"deepseek-v4-pro",
    keychainService:"test",keychainAccount:"test",
    skillBundle:{
      content:"# Synthetic Skill\n",
      fileCount:1,
      totalBytes:Buffer.byteLength("# Synthetic Skill\n","utf8"),
      sha256:sha256("# Synthetic Skill\n")
    },
    context:{
      model:"deepseek",instructionText:"处理附件",
      sourceEvidence:{kind:"text"},
      sources:[{
        sourceId:"source-001",relativePath:"source-001.pdf"
      }],
      tools:[{name:"record_daily_work"}]
    },
    keyReader:async()=>{keyReads+=1;return "must-not-read";}
  }),/assistant_deepseek_subset_unsupported/);
  assert.equal(keyReads,0);
});

test("strictifies all four tool schemas for the Codex output subset",()=>{
  const schema=buildPersonalAssistantOutputSchema(
    getModelToolDeclarations()
  );
  const serialized=JSON.stringify(schema);
  assert.doesNotMatch(serialized,/"uniqueItems"|"x-[^"]+"/u);
  assert.equal(allObjectPropertiesRequired(schema),true);
});

test("source-read is absent unless a real backend enables it",()=>{
  const tools=getModelToolDeclarations();
  const disabled=buildPersonalAssistantOutputSchema(tools);
  assert.equal(
    disabled.properties.type.enum.includes("source_read_request"),
    false
  );
  assert.deepEqual(
    disabled.properties.sourceReadRequest,
    {type:"null"}
  );
  assert.throws(
    ()=>buildPersonalAssistantOutputSchema(
      tools,{allowSourceRead:"yes"}
    ),
    /assistant_output_schema_invalid/u
  );

  const enabled=buildPersonalAssistantOutputSchema(
    tools,{allowSourceRead:true}
  );
  assert.equal(
    enabled.properties.type.enum.includes("source_read_request"),
    true
  );
  assert.equal(
    enabled.properties.sourceReadRequest.anyOf[0]
      .properties.requests.maxItems,
    1
  );
  assert.deepEqual(
    enabled.properties.sourceReadRequest.anyOf[0]
      .properties.requests.items.properties.view.enum,
    ["inspect_time_range"]
  );

  const envelope={
    type:"source_read_request",
    reply:null,ask:null,
    sourceReadRequest:{requests:[{
      sourceId:"source-001",view:"inspect_time_range",
      startMs:1_000,endMs:2_000
    }]},
    toolCall:null,taskUpdate:null
  };
  assert.throws(
    ()=>decodePersonalAssistantOutputEnvelopeForTools(envelope,tools),
    /assistant_output_invalid/u
  );
  assert.throws(
    ()=>decodePersonalAssistantOutputEnvelopeForTools(
      envelope,tools,{allowSourceRead:"yes"}
    ),
    /assistant_output_invalid/u
  );
  assert.equal(
    decodePersonalAssistantOutputEnvelopeForTools(
      envelope,tools,{allowSourceRead:true}
    ).type,
    "source_read_request"
  );
});

test("Codex prompt advertises source-read only when enabled",async()=>{
  await assert.rejects(
    ()=>capturedCodexCapability("yes"),
    error=>error?.message==="assistant_codex_invalid"
  );
  const disabled=await capturedCodexCapability(false);
  assert.equal(
    disabled.schema.properties.type.enum.includes("source_read_request"),
    false
  );
  assert.doesNotMatch(
    disabled.prompt,/sourceReadRequest|inspect_time_range/u
  );

  const enabled=await capturedCodexCapability(true);
  assert.equal(
    enabled.schema.properties.type.enum.includes("source_read_request"),
    true
  );
  assert.match(
    enabled.prompt,
    /sourceReadRequest.*inspect_time_range.*一个.*60 秒/su
  );
});

test("decodes every strict Codex envelope into the existing runtime contract",()=>{
  const tools=[{
    name:"save_knowledge",
    parameters:{
      type:"object",additionalProperties:false,
      required:["title","sourceIds"],
      properties:{
        title:{type:"string"},
        evidenceSourceIds:{
          type:"array",items:{type:"string"}
        },
        sourceIds:{
          type:"array",items:{type:"string"}
        }
      }
    }
  }];
  const empty={
    reply:null,ask:null,sourceReadRequest:null,toolCall:null,taskUpdate:null
  };
  assert.deepEqual(
    decodePersonalAssistantOutputEnvelopeForTools({
      ...empty,type:"reply",reply:{text:"完成"}
    },tools),
    {type:"reply",text:"完成"}
  );
  assert.deepEqual(
    decodePersonalAssistantOutputEnvelopeForTools({
      ...empty,type:"ask",
      ask:{
        question:"保存吗？",waitingType:"waiting_confirmation",
        preparedTool:"save_knowledge",preparedRule:null
      }
    },tools),
    {
      type:"ask",question:"保存吗？",
      waitingType:"waiting_confirmation",
      preparedTool:"save_knowledge",preparedRule:null
    }
  );
  assert.throws(
    ()=>decodePersonalAssistantOutputEnvelopeForTools({
      ...empty,type:"source_read_request",
      sourceReadRequest:{requests:[{
        sourceId:"source-001",view:"transcribe_audio",
        startMs:null,endMs:null
      }]}
    },tools,{allowSourceRead:true}),
    /assistant_output_invalid/u
  );
  assert.deepEqual(
    decodePersonalAssistantOutputEnvelopeForTools({
      ...empty,type:"tool_call",
      toolCall:{
        toolName:"save_knowledge",
        arguments:{
          title:"视频摘要",evidenceSourceIds:null,sourceIds:[]
        }
      }
    },tools),
    {
      type:"tool_call",toolName:"save_knowledge",
      arguments:{title:"视频摘要",sourceIds:[]}
    }
  );
});

test("reports a bounded assistant timeout without exposing child details",async()=>{
  await assert.rejects(
    invokeSyntheticCodex({FAKE_CODEX_MODE:"timeout"},50),
    error=>error?.message==="assistant_timeout"&&
      Object.keys(error).length===0
  );
});

test("reports a bounded assistant process failure without stderr",async()=>{
  await assert.rejects(
    invokeSyntheticCodex({FAKE_CODEX_MODE:"process-failure"}),
    error=>error?.message==="assistant_process_failed"&&
      !String(error).includes("synthetic private stderr")&&
      Object.keys(error).length===0
  );
});

test("reports malformed and oversized Codex output as an invalid result",async()=>{
  for (const response of ["{",`{"text":"${"x".repeat(64*1024)}"}`]) {
    await assert.rejects(
      invokeSyntheticCodex({
        FAKE_CODEX_MODE:"raw",
        FAKE_RESPONSE:response
      }),
      error=>error?.message==="assistant_result_invalid"&&
        Object.keys(error).length===0
    );
  }
});

async function invokeSyntheticCodex(environment,timeoutMs=2_000) {
  const root=await mkdtemp(join(tmpdir(),"llw-pa-failure-"));
  const workspaceDir=join(root,"workspace");
  await mkdir(workspaceDir,{mode:0o700});
  await chmod(fixture,0o755);
  const content="# Synthetic Skill\n";
  try {
    return await invokePersonalAssistantCodex({
      codexPath:fixture,
      workspaceDir,
      skillBundle:{
        content,
        fileCount:1,
        totalBytes:Buffer.byteLength(content,"utf8"),
        sha256:sha256(content)
      },
      context:{
        model:"codex",
        instructionText:"只读分析",
        sources:[],
        tools:[]
      },
      environment:{...process.env,...environment},
      timeoutMs
    });
  } finally {
    await rm(root,{recursive:true,force:true});
  }
}

async function capturedCodexCapability(allowSourceRead) {
  const root=await mkdtemp(join(tmpdir(),"llw-pa-capability-"));
  const workspaceDir=join(root,"workspace");
  const schemaFile=join(root,"schema.json");
  const stdinFile=join(root,"stdin.txt");
  const content="# Synthetic Skill\n";
  await mkdir(workspaceDir,{mode:0o700});
  await chmod(fixture,0o755);
  try {
    await invokePersonalAssistantCodex({
      codexPath:fixture,workspaceDir,
      skillBundle:{
        content,
        fileCount:1,
        totalBytes:Buffer.byteLength(content,"utf8"),
        sha256:sha256(content)
      },
      context:{
        model:"codex",instructionText:"只读分析",
        sources:[],tools:[]
      },
      allowSourceRead,
      environment:{
        ...process.env,
        FAKE_SCHEMA_FILE_COPY:schemaFile,
        FAKE_STDIN_FILE:stdinFile,
        FAKE_RESPONSE:JSON.stringify({
          type:"reply",reply:{text:"完成"},
          ask:null,sourceReadRequest:null,toolCall:null,taskUpdate:null
        })
      }
    });
    return {
      schema:JSON.parse(await readFile(schemaFile,"utf8")).content,
      prompt:await readFile(stdinFile,"utf8")
    };
  } finally {
    await rm(root,{recursive:true,force:true});
  }
}

function allObjectPropertiesRequired(value) {
  if (Array.isArray(value)) return value.every(allObjectPropertiesRequired);
  if (!value||typeof value!=="object") return true;
  if (value.type==="object") {
    const propertyNames=Object.keys(value.properties??{}).sort();
    if (!Array.isArray(value.required)||
        JSON.stringify([...value.required].sort())!==
          JSON.stringify(propertyNames)) {
      return false;
    }
  }
  return Object.values(value).every(allObjectPropertiesRequired);
}
