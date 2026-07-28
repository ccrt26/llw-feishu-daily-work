import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,mkdtemp,mkdir,readFile,realpath,rm,writeFile
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {
  invokePersonalAssistantCodex,invokePersonalAssistantDeepSeek
} from "../src/personal-assistant/invoke-personal-assistant.mjs";

const fixture=fileURLToPath(
  new URL("./fixtures/fake-codex.mjs",import.meta.url)
);

test("invokes one private Skill read-only with bounded context and visual pages",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-pa-invoke-"));
  const skillRoot=join(root,"llw-personal-assistant");
  const workspaceDir=join(root,"llw-turn-private");
  const argsFile=join(root,"args.json");
  const stdinFile=join(root,"stdin.txt");
  const cwdFile=join(root,"cwd.txt");
  try {
    await mkdir(join(skillRoot,"references"),{recursive:true,mode:0o700});
    await mkdir(workspaceDir,{mode:0o700});
    const imageFiles=[
      join(workspaceDir,"source-001.png"),
      join(workspaceDir,"source-002.png")
    ];
    await writeFile(imageFiles[0],"image-a",{mode:0o600});
    await writeFile(imageFiles[1],"image-b",{mode:0o600});
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
      tools:[{name:"save_knowledge",description:"save",parameters:{type:"object"}}],
      priority:["program_safety"]
    };
    const result=await invokePersonalAssistantCodex({
      codexPath:fixture,workspaceDir,skillRoot,context,imageFiles,
      environment:{
        ...process.env,FAKE_ARGS_FILE:argsFile,FAKE_STDIN_FILE:stdinFile,
        FAKE_CWD_ONLY_FILE:cwdFile,
        FAKE_RESPONSE:JSON.stringify({type:"reply",text:"只读总结。"})
      }
    });
    assert.deepEqual(result,{type:"reply",text:"只读总结。"});
    const args=JSON.parse(await readFile(argsFile,"utf8"));
    assert.deepEqual(args.slice(0,5),[
      "exec","--ephemeral","--sandbox","read-only","--skip-git-repo-check"
    ]);
    assert.equal(args.filter(value=>value==="--image").length,2);
    assert.ok(args.includes("source-001.png"));
    assert.ok(args.includes("source-002.png"));
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
    assert.match(prompt,/不得提前宣称工具成功/);
    assert.match(
      prompt,
      /waiting_confirmation.*preparedRule/s
    );
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("rejects every DeepSeek turn containing an original source",async()=>{
  let keyReads=0;
  await assert.rejects(()=>invokePersonalAssistantDeepSeek({
    model:"deepseek-v4-pro",
    keychainService:"test",keychainAccount:"test",
    skillRoot:"/private/tmp/skill",
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
