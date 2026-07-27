import test from "node:test";
import assert from "node:assert/strict";
import {prepareKnowledgeText} from "../src/capabilities/knowledge-ingest/source-preparer.mjs";
import {createSourceEvidence} from "../src/personal-assistant/source-evidence.mjs";
import {assertContentSafe} from "../src/personal-assistant/content-safety.mjs";
import {executeSaveKnowledge} from "../src/personal-assistant/tools/save-knowledge.mjs";

const sections={
  keyFacts:["客户需要一份交流方案。"],
  structureAndMainContent:"资料说明了交流目标和主要内容。",
  reusableContent:["交流前确认目标。"],
  sourceNotes:"根据完整来源忠实整理。",
  contentIndex:"来源共一段。"
};

function toolCall() {
  return {
    name:"save_knowledge",
    arguments:{
      libraryKey:"personal-knowledge",
      folderSegments:["学习资料"],
      title:"交流方案",
      summary:"用于交流前准备的资料。",
      tags:["交流"],
      knowledgeSections:sections
    }
  };
}

test("binds the real current source and creates the receipt from Writer result",async() => {
  const text="把交流目标、对象和后续动作写清楚。";
  const prepared={...prepareKnowledgeText({text,maxSourceBytes:262_144}),content:text};
  const evidence=createSourceEvidence(prepared);
  assert.doesNotThrow(()=>assertContentSafe({
    instructionText:"保存到日常生活/学习资料",
    evidence,conversation:null,limits:{maxContextBytes:512*1024}
  }));
  const calls=[];
  const result=await executeSaveKnowledge({
    toolCall:toolCall(),
    preparedSource:prepared,
    writer:{async commit(input) {
      calls.push(structuredClone(input));
      return {
        status:"created",
        knowledgeId:"k1",
        libraryKey:"personal-knowledge",
        relativePath:"日常生活/学习资料/交流方案",
        files:["日常生活/学习资料/交流方案/knowledge.md"]
      };
    }},
    skillVersion:"4.0.1",
    ingestedAt:"2026-07-28T00:00:00.000Z"
  });
  assert.equal(calls.length,1);
  assert.strictEqual(calls[0].source.sourceBytes,undefined);
  assert.equal(calls[0].source.sha256,prepared.sha256);
  assert.deepEqual(result,{
    status:"committed",
    reply:"知识资料已保存。\n位置：日常生活/学习资料/交流方案",
    artifacts:["日常生活/学习资料/交流方案/knowledge.md"]
  });
});

test("does not call Writer for partial sources or unsafe tool arguments",async() => {
  let writerCalls=0;
  const prepared={
    ...prepareKnowledgeText({text:"部分内容",maxSourceBytes:262_144}),
    content:"部分内容",
    extractionIntegrity:"partial",
    extractionLimitations:["embedded_images_not_extracted"]
  };
  await assert.rejects(executeSaveKnowledge({
    toolCall:toolCall(),
    preparedSource:prepared,
    writer:{async commit() { writerCalls+=1; }},
    skillVersion:"4.0.1",
    ingestedAt:"2026-07-28T00:00:00.000Z"
  }),/knowledge_source_incomplete/);
  await assert.rejects(executeSaveKnowledge({
    toolCall:{...toolCall(),arguments:{...toolCall().arguments,path:"/tmp/x"}},
    preparedSource:{...prepared,extractionIntegrity:"complete",extractionLimitations:[]},
    writer:{async commit() { writerCalls+=1; }},
    skillVersion:"4.0.1",
    ingestedAt:"2026-07-28T00:00:00.000Z"
  }),/tool_call_invalid/);
  assert.equal(writerCalls,0);
});

test("reports Writer failure without claiming success and without a second AI call",async() => {
  const prepared={
    ...prepareKnowledgeText({text:"完整内容",maxSourceBytes:262_144}),
    content:"完整内容"
  };
  const result=await executeSaveKnowledge({
    toolCall:toolCall(),
    preparedSource:prepared,
    writer:{async commit() { throw new Error("disk_unavailable"); }},
    skillVersion:"4.0.1",
    ingestedAt:"2026-07-28T00:00:00.000Z"
  });
  assert.deepEqual(result,{
    status:"failed",
    reply:"内容已理解，但本次保存失败；你不需要重新解释内容。",
    artifacts:[]
  });
});
