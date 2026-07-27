import test from "node:test";
import assert from "node:assert/strict";
import {adaptProviderResult} from "../src/personal-assistant/provider-adapter.mjs";

test("adapts direct replies, one question and one tool without business rewriting",() => {
  assert.deepEqual(adaptProviderResult({
    provider:"codex",raw:{type:"reply",text:"这是总结。"}
  }),{kind:"reply",text:"这是总结。"});
  assert.deepEqual(adaptProviderResult({
    provider:"deepseek",raw:{action:"ask",question:"希望保存到工作还是生活资料？"}
  }),{kind:"ask",question:"希望保存到工作还是生活资料？"});
  const args={libraryKey:"personal"};
  const result=adaptProviderResult({
    provider:"codex",raw:{type:"tool_call",toolName:"save_knowledge",arguments:args}
  });
  assert.deepEqual(result,{kind:"tool",toolCall:{name:"save_knowledge",arguments:args}});
});

test("rejects multiple tools, mixed success claims and unknown envelopes",() => {
  for (const raw of [
    {type:"tool_calls",calls:[{name:"save_knowledge"},{name:"create_document"}]},
    {type:"tool_call",toolName:"save_knowledge",arguments:{},text:"已经保存成功"},
    {type:"route",capability:"knowledge-ingest"},
    null
  ]) assert.throws(()=>adaptProviderResult({provider:"codex",raw}),/provider_result_invalid/);
});
