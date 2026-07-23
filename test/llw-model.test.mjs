import test from "node:test";
import assert from "node:assert/strict";
import {runModelCli} from "../src/llw-model.mjs";

test("local CLI directs successful status to stdout and disabled DeepSeek rejection to stderr",async () => {
  const stdout=[],stderr=[];
  const config={modelStateFile:"/private/model-state",deepseekEnabled:false};
  const mode={read:async()=>"deepseek",write:async()=>assert.fail("must not write")};
  const common={load:async()=>config,createMode:()=>mode,stdout:{write:value=>stdout.push(value)},stderr:{write:value=>stderr.push(value)}};
  assert.equal(await runModelCli({argumentsList:["status"],...common}),0);
  assert.deepEqual(stdout,["当前模型：Codex\n切换方式：手工\n"]); assert.deepEqual(stderr,[]);
  stdout.length=0;
  assert.equal(await runModelCli({argumentsList:["deepseek"],...common}),1);
  assert.deepEqual(stdout,[]); assert.deepEqual(stderr,["DeepSeek 模型当前未启用。\n"]);
});
