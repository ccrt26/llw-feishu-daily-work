import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeKnowledgeCandidate
} from "../src/capabilities/knowledge-ingest/candidate-normalizer.mjs";

const libraries=[
  {
    libraryKey:"work-knowledge",
    displayName:"亚信工作",
    aliases:["工作资料"],
    existingFolders:[["工作文档"],["工作文档","交流方案"]]
  },
  {
    libraryKey:"personal-knowledge",
    displayName:"日常生活",
    aliases:["生活资料"],
    existingFolders:[]
  }
];

const source={
  sourceKind:"text",
  detectedFormat:"text",
  extractionIntegrity:"complete",
  extractionLimitations:[]
};

const sections={
  key_facts:["虚构事实一"],
  structure_and_main_content:"虚构结构化主要内容。",
  reusable_content:["虚构复用项"],
  source_notes:"完整合成来源。",
  content_index:"本地读取器提取内容见最终章节。"
};

function commit(overrides={}) {
  return {
    action:"commit",
    confidence:"high",
    reason_code:"ready",
    library_key:"work-knowledge",
    target:{
      scope:"existing_folder",
      segments:["工作文档","交流方案"],
      origin:"user_explicit"
    },
    title:"虚构交流方案",
    summary:"来源约束的虚构摘要。",
    tags:["虚构"],
    knowledge_sections:sections,
    source_integrity:"complete",
    ...overrides
  };
}

test("normalizes the V3.7.1 commit candidate into one strict internal decision",()=>{
  assert.deepEqual(
    normalizeKnowledgeCandidate(commit({library_key:"工作资料"}),{
      libraries,source
    }),
    {
      action:"commit",
      reasonCode:"ready",
      question:"",
      libraryKey:"work-knowledge",
      target:{
        scope:"existing_folder",
        segments:["工作文档","交流方案"],
        origin:"user_explicit"
      },
      title:"虚构交流方案",
      summary:"来源约束的虚构摘要。",
      tags:["虚构"],
      knowledgeSections:{
        keyFacts:["虚构事实一"],
        structureAndMainContent:"虚构结构化主要内容。",
        reusableContent:["虚构复用项"],
        sourceNotes:"完整合成来源。",
        contentIndex:"本地读取器提取内容见最终章节。"
      },
      sourceIntegrity:"complete"
    }
  );
});

test("maps exact legacy root expressions without guessing a path",()=>{
  const candidate=commit({
    library_key:"personal-knowledge",
    target:undefined,
    folder_plan:{
      mode:"use_existing",
      segments:["日常生活"],
      origin:"user_explicit"
    }
  });
  delete candidate.target;
  assert.deepEqual(
    normalizeKnowledgeCandidate(candidate,{libraries,source}).target,
    {
      scope:"library_root",
      segments:[],
      origin:"user_explicit"
    }
  );
});

test("keeps safe context for await-file and one bounded clarification",()=>{
  assert.deepEqual(
    normalizeKnowledgeCandidate({
      action:"await_file",
      library_key:"日常生活",
      target:{
        scope:"library_root",segments:[],origin:"user_explicit"
      }
    },{libraries,source:null}),
    {
      action:"await_file",
      reasonCode:"source_incomplete",
      question:"",
      libraryKey:"personal-knowledge",
      target:{
        scope:"library_root",segments:[],origin:"user_explicit"
      },
      title:"",
      summary:"",
      tags:[],
      knowledgeSections:null,
      sourceIntegrity:"partial"
    }
  );
  assert.deepEqual(
    normalizeKnowledgeCandidate({
      action:"ask_user",
      reason_code:"folder_confirmation_required",
      question:"是否确认创建建议目录？",
      library_key:"亚信工作",
      target:{
        scope:"new_folder",
        segments:["项目资料"],
        origin:"skill_suggested"
      },
      title:"",
      summary:"",
      tags:[],
      note_file:"",
      preserve_source:true
    },{libraries,source}),
    {
      action:"ask_user",
      reasonCode:"folder_confirmation_required",
      question:"是否确认创建建议目录？",
      libraryKey:"work-knowledge",
      target:{
        scope:"new_folder",
        segments:["项目资料"],
        origin:"skill_suggested"
      },
      title:"",
      summary:"",
      tags:[],
      knowledgeSections:null,
      sourceIntegrity:"complete"
    }
  );
});

test("drops only known harmless legacy empty fields",()=>{
  assert.deepEqual(
    normalizeKnowledgeCandidate({
      action:"reject",
      reason_code:"unsupported_format",
      confidence:"high",
      question:"",
      library_key:"",
      folder_plan:{
        mode:"use_existing",segments:[],origin:"user_explicit"
      },
      title:"",
      summary:"",
      tags:[],
      note_file:"",
      source_integrity:"unreadable",
      preserve_source:false
    },{libraries,source}),
    {
      action:"reject",
      reasonCode:"unsupported_format",
      question:"",
      libraryKey:"",
      target:null,
      title:"",
      summary:"",
      tags:[],
      knowledgeSections:null,
      sourceIntegrity:"unreadable"
    }
  );
});

test("rejects ambiguity, unsafe paths, incomplete commits and unknown fields",()=>{
  const unsafe=[
    commit({library_key:"unknown"}),
    commit({library_key:"资料"}),
    commit({confidence:"medium"}),
    commit({source_integrity:"partial"}),
    commit({target:{
      scope:"existing_folder",segments:["不存在"],origin:"skill_suggested"
    }}),
    commit({target:{
      scope:"new_folder",segments:["建议"],origin:"skill_suggested"
    }}),
    commit({target:{
      scope:"existing_folder",segments:["../逃逸"],origin:"user_explicit"
    }}),
    {...commit(),absolute_path:"/private/secret"},
    {action:"unknown"}
  ];
  for (const candidate of unsafe) {
    assert.throws(
      ()=>normalizeKnowledgeCandidate(candidate,{libraries,source}),
      /knowledge_candidate_invalid/
    );
  }
});
