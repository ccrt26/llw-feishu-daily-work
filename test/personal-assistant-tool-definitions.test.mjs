import test from "node:test";
import assert from "node:assert/strict";
import {
  TOOL_DEFINITIONS,getModelToolDeclarations,validateToolCall
} from "../src/personal-assistant/tool-definitions.mjs";

test("uses the same frozen definition objects for model declarations and execution",() => {
  const declarations=getModelToolDeclarations();
  assert.deepEqual(declarations.map(item=>item.name),[
    "record_daily_work","archive_dining_invoice","save_knowledge","create_document"
  ]);
  assert.strictEqual(declarations[2].parameters,TOOL_DEFINITIONS.save_knowledge.parameters);
  assert.equal(Object.isFrozen(TOOL_DEFINITIONS),true);
});

test("accepts one business-only save_knowledge call",() => {
  assert.deepEqual(validateToolCall({
    name:"save_knowledge",
    arguments:{
      libraryKey:"personal",
      folderSegments:["学习资料"],
      title:"交流方法",
      summary:"整理交流前的准备方法。",
      tags:["交流","准备"],
      body:"## 关键事实\n- 先确认目标"
    }
  }),{
    name:"save_knowledge",
    arguments:{
      libraryKey:"personal",
      folderSegments:["学习资料"],
      title:"交流方法",
      summary:"整理交流前的准备方法。",
      tags:["交流","准备"],
      body:"## 关键事实\n- 先确认目标"
    }
  });
});

test("rejects unknown tools, paths, hashes, source objects and extra fields",() => {
  for (const call of [
    {name:"reply_only",arguments:{}},
    {name:"save_knowledge",arguments:{}},
    {name:"save_knowledge",arguments:{
      libraryKey:"personal",folderSegments:[],title:"x",summary:"x",tags:[],body:"x",
      path:"/tmp/x"
    }},
    {name:"save_knowledge",arguments:{
      libraryKey:"personal",folderSegments:[],title:"x",summary:"x",tags:[],body:"x",
      source:{sha256:"a".repeat(64)}
    }}
  ]) assert.throws(()=>validateToolCall(call),/tool_call_invalid/);
});
