import test from "node:test";
import assert from "node:assert/strict";
import {chmod,mkdir,mkdtemp,readFile,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {invokeAssistantWorkDecision} from "../src/capabilities/assistant-work/decision-client.mjs";

const fixture=fileURLToPath(new URL("./fixtures/fake-codex.mjs",import.meta.url));
const response={
  action:"reply_text",reason_code:"ready",question:"",reply:"合成答复。",
  source_paths:[],
  grounding_report:{
    mode:"hybrid",uses_model_knowledge:true,contains_inference:true,
    needs_current_fact_verification:false
  },
  output:null
};
const input={
  message:{text:"讨论合成方案",received_at:"2026-07-26T01:00:00.000Z"},
  session:{
    session_id:"123e4567-e89b-42d3-a456-426614174000",
    goal:"讨论合成方案",task_summary:"",confirmed_requirements:[],
    rejected_directions:[],source_paths:[],current_draft_version:0,
    recent_turns:[],grounding_mode:"hybrid",model:"codex"
  },
  currentDraft:null,baseVersion:0,sources:[],allowedOutputFormats:[],
  verifiedArtifact:null,entrySupportsFileReply:false,model:"codex"
};

async function syntheticSkillRoot(parent) {
  const root=join(parent,"synthetic-assistant-skill");
  await mkdir(join(root,"references"),{recursive:true,mode:0o700});
  await writeFile(
    join(root,"SKILL.md"),
    "---\nname: llw-assistant-work\ndescription: Synthetic test fixture.\n---\n",
    {mode:0o600}
  );
  await writeFile(
    join(root,"references","output-schema.json"),
    `${JSON.stringify({type:"object"})}\n`,
    {mode:0o600}
  );
  return root;
}

test("runs only the selected private Skill in one read-only bounded job",async()=>{
  await chmod(fixture,0o700);
  const tempRoot=await mkdtemp(join(tmpdir(),"llw-aw-client-"));
  const skillRoot=await syntheticSkillRoot(tempRoot);
  const argsFile=join(tempRoot,"args.json"),stdinFile=join(tempRoot,"stdin.txt");
  const result=await invokeAssistantWorkDecision({
    codexPath:fixture,skillRoot,tempRoot,input,
    environment:{
      ...process.env,FAKE_ARGS_FILE:argsFile,FAKE_STDIN_FILE:stdinFile,
      FAKE_RESPONSE:JSON.stringify(response)
    }
  });
  assert.deepEqual(result,response);
  const args=JSON.parse(await readFile(argsFile,"utf8"));
  for (const value of ["--ephemeral","read-only","--output-schema","--output-last-message"]) {
    assert.equal(args.includes(value),true);
  }
  const prompt=await readFile(stdinFile,"utf8");
  assert.match(prompt,/\$llw-assistant-work/);
  for (const forbidden of ["sender_id","chat_id","message_id","/Users/private-owner"]) {
    assert.equal(prompt.includes(forbidden),false);
  }
});

test("rejects forged source decisions after the model returns",async()=>{
  await chmod(fixture,0o700);
  const tempRoot=await mkdtemp(join(tmpdir(),"llw-aw-client-"));
  const skillRoot=await syntheticSkillRoot(tempRoot);
  await assert.rejects(()=>invokeAssistantWorkDecision({
    codexPath:fixture,skillRoot,tempRoot,
    input:{...input,sources:[{path:"工作资料/合成.md",excerpt:"合成",score:1}]},
    environment:{...process.env,FAKE_RESPONSE:JSON.stringify({
      ...response,source_paths:["../outside.md"]
    })}
  }),/assistant_work_decision_failed/);
});
