import test from "node:test";
import assert from "node:assert/strict";
import {validateKnowledgeDecision} from "../src/capabilities/knowledge-ingest/decision-validator.mjs";

const libraries=[
  {
    libraryKey:"work-knowledge",
    displayName:"Synthetic Work",
    aliases:["Synthetic Work Library"],
    existingFolders:[["Synthetic Client"],["Synthetic Client","Exchange Plan"]]
  },
  {
    libraryKey:"personal-knowledge",
    displayName:"Synthetic Personal",
    aliases:[],
    existingFolders:[]
  }
];

function plan(mode="use_existing",segments=[],origin="user_explicit") {
  return {mode,segments,origin};
}

function commit(overrides={}) {
  return {
    action:"commit",
    confidence:"high",
    reason_code:"ready",
    question:"",
    library_key:"work-knowledge",
    folder_plan:plan("use_existing",["Synthetic Client","Exchange Plan"],"skill_suggested"),
    title:"Synthetic Exchange Plan",
    summary:"A grounded synthetic summary.",
    tags:["synthetic","plan"],
    note_file:"knowledge.md",
    source_integrity:"complete",
    preserve_source:true,
    ...overrides
  };
}

test("accepts high-confidence commit to one supplied existing folder",()=>{
  assert.deepEqual(validateKnowledgeDecision(commit(),{libraries}),commit());
  const explicitNew=commit({
    folder_plan:plan("create_if_missing",["New Category"],"user_explicit")
  });
  assert.deepEqual(validateKnowledgeDecision(explicitNew,{libraries}),explicitNew);
});

test("accepts the bounded create-folder, ask, and reject result shapes",()=>{
  const decisions=[
    {
      action:"create_folder",confidence:"high",reason_code:"folder_ready",question:"",
      library_key:"personal-knowledge",
      folder_plan:plan("create_if_missing",["Reading"],"user_explicit"),
      title:"",summary:"",tags:[],note_file:"",
      source_integrity:"complete",preserve_source:false
    },
    {
      action:"ask_user",confidence:"high",reason_code:"folder_confirmation_required",
      question:"Create the suggested category?",library_key:"work-knowledge",
      folder_plan:plan("create_if_missing",["Suggested Category"],"skill_suggested"),
      title:"",summary:"",tags:[],note_file:"",
      source_integrity:"complete",preserve_source:true
    },
    {
      action:"reject",confidence:"high",reason_code:"existing_change_forbidden",question:"",
      library_key:"",folder_plan:plan(),title:"",summary:"",tags:[],note_file:"",
      source_integrity:"complete",preserve_source:false
    }
  ];
  for (const decision of decisions) {
    assert.deepEqual(validateKnowledgeDecision(decision,{libraries}),decision);
  }
});

test("rejects fabricated folders, unsafe write confidence and absolute or path-like segments",()=>{
  const unsafe=[
    commit({confidence:"medium"}),
    commit({library_key:"unknown"}),
    commit({folder_plan:plan("use_existing",["Fabricated"],"skill_suggested")}),
    commit({folder_plan:plan("create_if_missing",["Suggested"],"skill_suggested")}),
    commit({folder_plan:plan("use_existing",["/absolute"],"user_explicit")}),
    commit({folder_plan:plan("use_existing",[".."],"user_explicit")}),
    commit({folder_plan:plan("use_existing",["a/b"],"user_explicit")}),
    commit({folder_plan:plan("use_existing",[".hidden"],"user_explicit")}),
    commit({note_file:"other.md"}),
    commit({source_integrity:"partial"}),
    {...commit(),absolute_path:"/private/value"}
  ];
  for (const decision of unsafe) {
    assert.throws(
      ()=>validateKnowledgeDecision(decision,{libraries}),
      /knowledge_decision_invalid/
    );
  }
});

test("rejects ambiguous, overlong, duplicate and conditionally inconsistent fields",()=>{
  const unsafe=[
    commit({title:""}),
    commit({summary:""}),
    commit({title:"x".repeat(161)}),
    commit({summary:"x".repeat(4001)}),
    commit({tags:["duplicate","duplicate"]}),
    commit({tags:Array.from({length:21},(_,index)=>`tag-${index}`)}),
    commit({question:"unexpected"}),
    commit({reason_code:"folder_ready"}),
    {
      action:"ask_user",confidence:"high",reason_code:"library_required",question:"",
      library_key:"",folder_plan:plan(),title:"",summary:"",tags:[],note_file:"",
      source_integrity:"complete",preserve_source:true
    },
    {
      action:"create_folder",confidence:"high",reason_code:"folder_ready",question:"",
      library_key:"work-knowledge",folder_plan:plan("create_if_missing",["New"],"skill_suggested"),
      title:"",summary:"",tags:[],note_file:"",
      source_integrity:"complete",preserve_source:false
    }
  ];
  for (const decision of unsafe) {
    assert.throws(
      ()=>validateKnowledgeDecision(decision,{libraries}),
      /knowledge_decision_invalid/
    );
  }
});
