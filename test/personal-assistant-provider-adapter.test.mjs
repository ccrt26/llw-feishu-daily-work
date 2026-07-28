import test from "node:test";
import assert from "node:assert/strict";
import {adaptProviderResult} from "../src/personal-assistant/provider-adapter.mjs";

test("adapts direct replies, one question and one tool without business rewriting",() => {
  assert.deepEqual(adaptProviderResult({
    provider:"codex",raw:{type:"reply",text:"这是总结。"}
  }),{kind:"reply",text:"这是总结。"});
  assert.deepEqual(adaptProviderResult({
    provider:"deepseek",raw:{
      action:"ask",question:"请发送要保存的文件。",
      waitingType:"waiting_file",preparedTool:"save_knowledge"
    }
  }),{
    kind:"ask",question:"请发送要保存的文件。",
    waitingType:"waiting_file",preparedTool:"save_knowledge"
  });
  const args={libraryKey:"personal"};
  const result=adaptProviderResult({
    provider:"codex",raw:{type:"tool_call",toolName:"save_knowledge",arguments:args}
  });
  assert.deepEqual(result,{kind:"tool",toolCall:{name:"save_knowledge",arguments:args}});
  assert.deepEqual(adaptProviderResult({
    provider:"codex",raw:{
      type:"ask",
      question:"以后遇到清晰的餐饮发票，都默认归档。确认吗？",
      waitingType:"waiting_confirmation",
      preparedTool:null,
      preparedRule:"清晰且符合归档规则的餐饮发票默认归档。"
    }
  }),{
    kind:"ask",
    question:"以后遇到清晰的餐饮发票，都默认归档。确认吗？",
    waitingType:"waiting_confirmation",
    preparedTool:null,
    preparedRule:"清晰且符合归档规则的餐饮发票默认归档。"
  });
});

test("rejects multiple tools, mixed success claims and unknown envelopes",() => {
  for (const raw of [
    {type:"tool_calls",calls:[{name:"save_knowledge"},{name:"create_document"}]},
    {type:"tool_call",toolName:"save_knowledge",arguments:{},text:"已经保存成功"},
    {
      type:"ask",question:"确认吗？",waitingType:"waiting_answer",
      preparedRule:"以后都保存。"
    },
    {
      type:"ask",question:"确认吗？",waitingType:"waiting_confirmation",
      preparedRule:"密码是 hunter2"
    },
    {type:"route",capability:"knowledge-ingest"},
    null
  ]) assert.throws(()=>adaptProviderResult({provider:"codex",raw}),/provider_result_invalid/);
});
