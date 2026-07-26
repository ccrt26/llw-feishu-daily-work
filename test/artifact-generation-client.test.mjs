import test from "node:test";
import assert from "node:assert/strict";
import {chmod,mkdtemp,mkdir,readFile,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {invokeLocalArtifactGeneration} from "../src/capabilities/assistant-work/artifact-generation-client.mjs";

const fixture=fileURLToPath(new URL("./fixtures/fake-codex.mjs",import.meta.url));

for (const [kind,skill] of [
  ["docx","documents"],["pptx","Presentations"],["xlsx","Spreadsheets"]
]) {
  test(`runs one bounded workspace-only ${kind} generation with the local ${skill} skill`,async()=>{
    await chmod(fixture,0o755);
    const root=await mkdtemp(join(tmpdir(),"llw-artifact-client-"));
    const deliverable=join(root,"deliverable");
    await mkdir(deliverable,{mode:0o700});
    const draftFile=join(root,"current-draft.md");
    const outputFile=join(deliverable,`output.${kind}`);
    const argsFile=join(root,"args.json"),promptFile=join(root,"prompt.txt");
    await writeFile(draftFile,"# 合成工作稿\n\n正文",{mode:0o600});
    await invokeLocalArtifactGeneration({
      codexPath:fixture,jobRoot:root,draftFile,outputFile,kind,
      displayName:`工作稿-v1.${kind}`,timeoutMs:120_000,
      environment:{
        ...process.env,FAKE_CODEX_MODE:"artifact",
        FAKE_ARGS_FILE:argsFile,FAKE_STDIN_FILE:promptFile
      }
    });
    const args=JSON.parse(await readFile(argsFile,"utf8"));
    assert.deepEqual(args,[
      "exec","--ephemeral","--sandbox","workspace-write",
      "--skip-git-repo-check","--color","never",
      "-c",'model_reasoning_effort="low"',"-"
    ]);
    const prompt=await readFile(promptFile,"utf8");
    assert.match(prompt,new RegExp(`\\$${skill}`,"u"));
    assert.match(prompt,/current-draft\.md/u);
    assert.match(prompt,new RegExp(`deliverable/output\\.${kind}`,"u"));
    assert.match(prompt,/WPS 可用的常规字体/u);
    assert.doesNotMatch(prompt,/Volumes\/test|token|飞书事件/u);
  });
}

test("rejects paths outside the private job before spawning",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-artifact-client-"));
  await assert.rejects(()=>invokeLocalArtifactGeneration({
    codexPath:fixture,jobRoot:root,draftFile:"/etc/hosts",
    outputFile:join(root,"deliverable","output.docx"),kind:"docx",
    displayName:"工作稿.docx",timeoutMs:120_000
  }),/artifact_generation_failed/);
});
