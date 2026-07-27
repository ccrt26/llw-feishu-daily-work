import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,mkdtemp,mkdir,readFile,rm,writeFile
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {
  invokePersonalAssistantCodex
} from "../src/personal-assistant/invoke-personal-assistant.mjs";

const fixture=fileURLToPath(
  new URL("./fixtures/fake-codex.mjs",import.meta.url)
);

test("invokes one private Skill read-only with bounded context and visual pages",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-pa-invoke-"));
  const skillRoot=join(root,"llw-personal-assistant");
  const argsFile=join(root,"args.json");
  const stdinFile=join(root,"stdin.txt");
  try {
    await mkdir(join(skillRoot,"references"),{recursive:true,mode:0o700});
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
      sourceEvidence:{kind:"pdf",text:"正文"},
      conversation:null,confirmedPersonalRules:[],
      tools:[{name:"save_knowledge",description:"save",parameters:{type:"object"}}],
      priority:["program_safety"]
    };
    const result=await invokePersonalAssistantCodex({
      codexPath:fixture,workspaceRoot:root,skillRoot,context,
      imageFiles:["/private/tmp/page-1.png"],
      environment:{
        ...process.env,FAKE_ARGS_FILE:argsFile,FAKE_STDIN_FILE:stdinFile,
        FAKE_RESPONSE:JSON.stringify({type:"reply",text:"只读总结。"})
      }
    });
    assert.deepEqual(result,{type:"reply",text:"只读总结。"});
    const args=JSON.parse(await readFile(argsFile,"utf8"));
    assert.deepEqual(args.slice(0,5),[
      "exec","--ephemeral","--sandbox","read-only","--skip-git-repo-check"
    ]);
    assert.ok(args.includes("--image"));
    assert.ok(args.includes("/private/tmp/page-1.png"));
    assert.equal(args.some(value=>value.includes("总结，不保存")),false);
    const prompt=await readFile(stdinFile,"utf8");
    assert.match(prompt,/\$llw-personal-assistant/);
    assert.match(prompt,/总结，不保存/);
    assert.match(prompt,/save_knowledge/);
    assert.match(prompt,/不得提前宣称工具成功/);
  } finally { await rm(root,{recursive:true,force:true}); }
});

