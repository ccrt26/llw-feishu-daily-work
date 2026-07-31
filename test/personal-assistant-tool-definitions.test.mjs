import test from "node:test";
import assert from "node:assert/strict";
import {
  TOOL_DEFINITIONS,getModelToolDeclarations,validateToolCall
} from "../src/personal-assistant/tool-definitions.mjs";

function knowledge(sourceIds=["source-001","source-002"]) {
  return {
    libraryKey:"personal-knowledge",
    folderSegments:["学习资料"],
    title:"交流方法",
    summary:"整理交流前的准备方法。",
    tags:["交流","准备"],
    sourceIds,
    knowledgeSections:{
      keyFacts:["先确认目标"],
      structureAndMainContent:"准备、交流、确认三部分。",
      reusableContent:["交流前确认目标。"],
      sourceNotes:"根据当前完整来源忠实整理。",
      contentIndex:"来源共两段。"
    }
  };
}

function invoiceItem(sourceId) {
  const names=[
    "invoice_number","issue_date","buyer_name","buyer_tax_id",
    "seller_name","item_name","total_with_tax"
  ];
  return {
    sourceId,
    extraction:{
      invoice:Object.fromEntries(names.map(name=>[name,""])),
      field_quality:Object.fromEntries(names.map(name=>[name,"clear"])),
      category:"dining",document_verification:"single_invoice"
    }
  };
}

test("uses the same frozen definition objects for model declarations and execution",() => {
  const declarations=getModelToolDeclarations();
  assert.deepEqual(declarations.map(item=>item.name),[
    "record_daily_work","archive_dining_invoice","save_knowledge","create_document"
  ]);
  assert.strictEqual(declarations[2].parameters,TOOL_DEFINITIONS.save_knowledge.parameters);
  assert.equal(Object.isFrozen(TOOL_DEFINITIONS),true);
});

test("accepts one business-only save_knowledge call",() => {
  assert.deepEqual(
    TOOL_DEFINITIONS.save_knowledge.parameters.properties.libraryKey.enum,
    ["work-knowledge","personal-knowledge"]
  );
  assert.deepEqual(validateToolCall({
    name:"save_knowledge",
    arguments:knowledge()
  }),{
    name:"save_knowledge",
    arguments:knowledge()
  });
  assert.doesNotThrow(()=>validateToolCall({
    name:"save_knowledge",
    arguments:{
      ...knowledge([]),
      evidenceSourceIds:["source-001"]
    }
  }));
  assert.throws(()=>validateToolCall({
    name:"save_knowledge",
    arguments:{
      ...knowledge(["source-002"]),
      evidenceSourceIds:["source-001"]
    }
  }),/tool_call_invalid/u);
});

test("rejects guessed knowledge library keys before Writer execution",() => {
  for (const libraryKey of ["daily_life","personal","work"]) {
    assert.throws(()=>validateToolCall({
      name:"save_knowledge",
      arguments:{...knowledge(),libraryKey}
    }),/tool_call_invalid/);
  }
});

test("binds knowledge, documents and invoice batches to unique current source IDs",() => {
  assert.doesNotThrow(()=>validateToolCall({
    name:"save_knowledge",arguments:knowledge([])
  }));
  assert.doesNotThrow(()=>validateToolCall({
    name:"create_document",
    arguments:{
      sourceIds:["source-001","source-002"],
      format:"docx",title:"交流方案",content:"生成要求"
    }
  }));
  for (const length of [1,8]) {
    assert.doesNotThrow(()=>validateToolCall({
      name:"archive_dining_invoice",
      arguments:{
        items:Array.from({length},(_,index)=>invoiceItem(
          `source-00${index+1}`
        ))
      }
    }));
  }
  for (const call of [
    {name:"save_knowledge",arguments:knowledge([
      "source-001","source-001"
    ])},
    {name:"archive_dining_invoice",arguments:{
      items:Array.from({length:9},(_,index)=>invoiceItem(
        `source-00${Math.min(index+1,8)}`
      ))
    }},
    {name:"archive_dining_invoice",arguments:{
      items:[invoiceItem("source-001"),invoiceItem("source-001")]
    }},
    {name:"archive_dining_invoice",arguments:{
      items:[{...invoiceItem("source-001"),path:"/tmp/private"}]
    }}
  ]) assert.throws(()=>validateToolCall(call),/tool_call_invalid/);
});

test("rejects unknown tools, paths, hashes, source objects and extra fields",() => {
  for (const call of [
    {name:"reply_only",arguments:{}},
    {name:"save_knowledge",arguments:{}},
    {name:"save_knowledge",arguments:{
      ...knowledge(),path:"/tmp/x"
    }},
    {name:"save_knowledge",arguments:{
      ...knowledge(),
      source:{sha256:"a".repeat(64)}
    }}
  ]) assert.throws(()=>validateToolCall(call),/tool_call_invalid/);
});
