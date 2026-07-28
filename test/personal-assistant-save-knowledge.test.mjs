import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {
  executeSaveKnowledge
} from "../src/personal-assistant/tools/save-knowledge.mjs";

const sections={
  keyFacts:["客户需要一份交流方案。"],
  structureAndMainContent:"资料说明了交流目标和主要内容。",
  reusableContent:["交流前确认目标。"],
  sourceNotes:"根据当前原件忠实整理。",
  contentIndex:"来源共两份。"
};

function toolCall(sourceIds=["source-001","source-002"]) {
  return {
    name:"save_knowledge",
    arguments:{
      libraryKey:"personal-knowledge",
      folderSegments:["学习资料"],
      title:"交流方案",
      summary:"用于交流前准备的资料。",
      tags:["交流"],sourceIds,
      knowledgeSections:sections
    }
  };
}

function binding(sourceId,format,sha256) {
  return {
    handle:{
      sourceId,displayName:`材料.${format}`,mediaClass:"document",
      format,relativePath:`${sourceId}.${format}`,
      byteSize:100,sha256,availability:"ready"
    },
    absolutePath:`/private/llw-turn-test/${sourceId}.${format}`,
    archiveExtension:format
  };
}

test("binds two declared current originals and creates the receipt from Writer",async()=>{
  const sourceBindings=[
    binding("source-001","docx","a".repeat(64)),
    binding("source-002","pdf","b".repeat(64))
  ];
  const calls=[];
  const result=await executeSaveKnowledge({
    toolCall:toolCall(),sourceBindings,
    instructionText:"整理后保存到日常生活",
    writer:{async commit(input) {
      calls.push(structuredClone(input));
      return {
        status:"created",knowledgeId:"k1",
        libraryKey:"personal-knowledge",
        relativePath:"日常生活/学习资料/交流方案",
        files:[
          "日常生活/学习资料/交流方案/knowledge.md",
          "日常生活/学习资料/交流方案/source-001.docx",
          "日常生活/学习资料/交流方案/source-002.pdf"
        ]
      };
    }},
    skillVersion:"4.0.1",
    ingestedAt:"2026-07-28T00:00:00.000Z"
  });
  assert.equal(calls.length,1);
  assert.deepEqual(
    calls[0].sources.map(source=>source.sourceId),
    ["source-001","source-002"]
  );
  assert.equal("extractionIntegrity" in calls[0],false);
  assert.equal(calls[0].sourceSetDigest,createHash("sha256")
    .update(`source-001\0${"a".repeat(64)}\0source-002\0${"b".repeat(64)}`)
    .digest("hex"));
  assert.equal(result.status,"committed");
  assert.equal(result.artifacts.length,3);
});

test("rejects unknown, duplicate and cross-turn source IDs with zero writes",async()=>{
  let writerCalls=0;
  const sourceBindings=[
    binding("source-001","docx","a".repeat(64)),
    binding("source-002","pdf","b".repeat(64))
  ];
  const writer={async commit(){writerCalls+=1;}};
  for (const sourceIds of [
    ["source-003"],["source-001","source-001"]
  ]) {
    const operation=executeSaveKnowledge({
      toolCall:toolCall(sourceIds),sourceBindings,
      instructionText:"保存",writer,skillVersion:"4.0.1",
      ingestedAt:"2026-07-28T00:00:00.000Z"
    });
    if (sourceIds[0]===sourceIds[1]) {
      await assert.rejects(operation,/tool_call_invalid/);
    } else {
      assert.equal((await operation).status,"rejected");
    }
  }
  assert.equal(writerCalls,0);
});

test("derives pure-text knowledge identity from the current instruction",async()=>{
  let committed;
  const instructionText="把这段关于交流准备的文字保存下来。";
  await executeSaveKnowledge({
    toolCall:toolCall([]),sourceBindings:[],instructionText,
    writer:{async commit(input) {
      committed=input;
      return {
        status:"existing",relativePath:"日常生活/交流准备",
        files:["日常生活/交流准备/knowledge.md"]
      };
    }},
    skillVersion:"4.0.1",ingestedAt:"2026-07-28T00:00:00.000Z"
  });
  assert.deepEqual(committed.sources,[]);
  assert.equal(committed.sourceSetDigest,createHash("sha256")
    .update(`text\0${instructionText}`).digest("hex"));
});

test("reports Writer failure without claiming success or retrying the Writer",async()=>{
  let calls=0;
  const result=await executeSaveKnowledge({
    toolCall:toolCall([]),sourceBindings:[],instructionText:"保存这段文字",
    writer:{async commit(){calls+=1;throw new Error("disk_unavailable");}},
    skillVersion:"4.0.1",ingestedAt:"2026-07-28T00:00:00.000Z"
  });
  assert.equal(calls,1);
  assert.deepEqual(result,{
    status:"failed",
    reply:"内容已理解，但本次保存失败；你不需要重新解释内容。",
    artifacts:[]
  });
});
