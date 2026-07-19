import test from "node:test";
import assert from "node:assert/strict";
import {chmod,mkdtemp,readFile,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {invokeIntentRouter,validateIntentRouterSkill} from "../src/core/intent-router-client.mjs";

const fixture=fileURLToPath(new URL("./fixtures/fake-codex.mjs",import.meta.url));
const skillRoot="/Volumes/ZHUTONG/LLW的私人助手/LLW/.agents/skills/feishu-intent-router";
const input={
  message:{type:"text",text:"今天完成方案评审",beijingTime:"2026-07-19 20:00:00"},conversation:null,
  capabilities:[{capability:"daily-work",purpose:"记录工作",accepts:["text"],positive_examples:["今天完成评审"],negative_examples:["解释评审"],supports_continuation:true}]
};
const response={action:"route",capability:"daily-work",confidence:"high",reason_code:"direct_match",question:"",reason:""};

test("invokes Codex read-only with only sanitized router context",async () => {
  await chmod(fixture,0o700);
  const dir=await mkdtemp(join(tmpdir(),"llw-router-client-"));
  const argsFile=join(dir,"args.json"),stdinFile=join(dir,"stdin.txt");
  const result=await invokeIntentRouter({codexPath:fixture,workspaceRoot:"/tmp",skillRoot,input,environment:{...process.env,FAKE_ARGS_FILE:argsFile,FAKE_STDIN_FILE:stdinFile,FAKE_RESPONSE:JSON.stringify(response)}});
  assert.equal(result.capability,"daily-work");
  const args=JSON.parse(await readFile(argsFile,"utf8"));
  for (const value of ["--ephemeral","read-only","--output-schema","--output-last-message"]) assert.equal(args.includes(value),true);
  const stdin=await readFile(stdinFile,"utf8");
  assert.match(stdin,/\$feishu-intent-router/);
  assert.match(stdin,/今天完成方案评审/);
  for (const secret of ["sender_id","chat_id","message_id","file_key","/Users/ccrt"]) assert.equal(stdin.includes(secret),false);
});

test("retries one transient Codex failure and returns the second valid decision",async () => {
  await chmod(fixture,0o700);
  const dir=await mkdtemp(join(tmpdir(),"llw-router-retry-"));
  const attempts=join(dir,"attempts"); await writeFile(attempts,"0");
  const result=await invokeIntentRouter({codexPath:fixture,workspaceRoot:"/tmp",skillRoot,input,environment:{...process.env,FAKE_CODEX_MODE:"transient",FAKE_CODEX_ATTEMPTS:attempts,FAKE_RESPONSE:JSON.stringify(response)}});
  assert.equal(result.action,"route");
  assert.equal(await readFile(attempts,"utf8"),"2");
});

test("validates the router Skill before startup and rejects any extra context field",async () => {
  await assert.doesNotReject(()=>validateIntentRouterSkill(skillRoot));
  await assert.rejects(()=>validateIntentRouterSkill("/private/tmp/missing-router-skill"),/unsafe_intent_router_skill/);
  await assert.rejects(()=>invokeIntentRouter({codexPath:fixture,workspaceRoot:"/tmp",skillRoot,input:{...input,senderId:"secret"},environment:{...process.env,FAKE_RESPONSE:JSON.stringify(response)}}),/invalid_intent_input/);
});
