import test from "node:test";
import assert from "node:assert/strict";
import {handleModelCommand,parseLocalModelCommand,parseModelCommand} from "../src/core/model-command.mjs";

const CODEX_SWITCH="模型已切换为 Codex。\n生效范围：下一条新任务。\n当前处理中任务不受影响。";
const DEEPSEEK_SWITCH="模型已切换为 DeepSeek。\n生效范围：下一条新任务。\n当前处理中任务不受影响。\n注意：发票图片/PDF视觉判断暂不支持 DeepSeek。";

test("accepts only the three exact Feishu and local model commands",() => {
  assert.equal(parseModelCommand("/llw-model status"),"status");
  assert.equal(parseModelCommand("/llw-model codex"),"codex");
  assert.equal(parseModelCommand("/llw-model deepseek"),"deepseek");
  for (const value of ["/llw-model  status","/llw-model status ","请切换到 DeepSeek","/llw-model auto",""]) assert.equal(parseModelCommand(value),null);
  assert.equal(parseLocalModelCommand(["status"]),"status");
  assert.equal(parseLocalModelCommand(["codex"]),"codex");
  assert.equal(parseLocalModelCommand(["deepseek"]),"deepseek");
  for (const value of [[],["status","extra"],["/llw-model","status"],["auto"]]) assert.equal(parseLocalModelCommand(value),null);
});

test("reports exact status and confirmation copy while respecting the DeepSeek flag",async () => {
  const writes=[];
  const modelMode={read:async()=>writes.at(-1)||"codex",write:async value=>writes.push(value)};
  assert.deepEqual(await handleModelCommand("/llw-model status",{modelMode,deepseekEnabled:true}),{status:"existing",reply:"当前模型：Codex\n切换方式：手工",artifacts:[]});
  assert.deepEqual(await handleModelCommand("/llw-model codex",{modelMode,deepseekEnabled:true}),{status:"existing",reply:CODEX_SWITCH,artifacts:[]});
  assert.deepEqual(await handleModelCommand("/llw-model deepseek",{modelMode,deepseekEnabled:true}),{status:"existing",reply:DEEPSEEK_SWITCH,artifacts:[]});
  assert.deepEqual(await handleModelCommand("/llw-model status",{modelMode,deepseekEnabled:true}),{status:"existing",reply:"当前模型：DeepSeek\n切换方式：手工\n发票视觉任务：不可用",artifacts:[]});
  assert.deepEqual(await handleModelCommand("/llw-model deepseek",{modelMode,deepseekEnabled:false}),{status:"rejected",reply:"DeepSeek 模型当前未启用。",artifacts:[]});
  assert.deepEqual(writes,["codex","deepseek"]);
  assert.equal(await handleModelCommand("自然语言切换",{modelMode,deepseekEnabled:true}),null);
});
