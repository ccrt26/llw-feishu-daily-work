import test from "node:test";
import assert from "node:assert/strict";
import {validateKnowledgeDecision} from "../src/capabilities/knowledge-ingest/decision-validator.mjs";

const libraries=[
  {
    libraryKey:"work-knowledge",displayName:"Synthetic Work",
    aliases:["Synthetic Work Library"],
    existingFolders:[["Synthetic Client","Exchange Plan"]]
  },
  {
    libraryKey:"personal-knowledge",displayName:"Synthetic Personal",
    aliases:[],existingFolders:[]
  }
];

const sections={
  keyFacts:["A grounded fact."],
  structureAndMainContent:"A grounded structure.",
  reusableContent:["A reusable item."],
  sourceNotes:"Extracted completely.",
  contentIndex:"Section 1"
};

function commit(overrides={}) {
  return {
    action:"commit",reasonCode:"ready",question:"",
    libraryKey:"work-knowledge",
    target:{
      scope:"existing_folder",segments:["Synthetic Client","Exchange Plan"],
      origin:"skill_suggested"
    },
    title:"Synthetic Exchange Plan",
    summary:"A grounded synthetic summary.",
    tags:["synthetic","plan"],knowledgeSections:sections,
    sourceIntegrity:"complete",...overrides
  };
}

test("accepts only the normalized internal commit contract",()=>{
  assert.deepEqual(validateKnowledgeDecision(commit(),{libraries}),commit());
  const root=commit({
    libraryKey:"personal-knowledge",
    target:{scope:"library_root",segments:[],origin:"user_explicit"}
  });
  assert.deepEqual(validateKnowledgeDecision(root,{libraries}),root);
  const explicitNew=commit({
    target:{scope:"new_folder",segments:["New Category"],origin:"user_explicit"}
  });
  assert.deepEqual(validateKnowledgeDecision(explicitNew,{libraries}),explicitNew);
});

test("accepts normalized await-file, create-folder, ask and reject shapes",()=>{
  const decisions=[
    {
      action:"await_file",reasonCode:"source_incomplete",question:"",
      libraryKey:"personal-knowledge",
      target:{scope:"library_root",segments:[],origin:"user_explicit"},
      title:"",summary:"",tags:[],knowledgeSections:null,
      sourceIntegrity:"partial"
    },
    {
      action:"create_folder",reasonCode:"folder_ready",question:"",
      libraryKey:"personal-knowledge",
      target:{scope:"new_folder",segments:["Reading"],origin:"user_explicit"},
      title:"",summary:"",tags:[],knowledgeSections:null,
      sourceIntegrity:"complete"
    },
    {
      action:"ask_user",reasonCode:"folder_confirmation_required",
      question:"Create the suggested category?",libraryKey:"work-knowledge",
      target:{
        scope:"new_folder",segments:["Suggested Category"],
        origin:"skill_suggested"
      },
      title:"",summary:"",tags:[],knowledgeSections:null,
      sourceIntegrity:"complete"
    },
    {
      action:"reject",reasonCode:"existing_change_forbidden",question:"",
      libraryKey:"",target:null,title:"",summary:"",tags:[],
      knowledgeSections:null,sourceIntegrity:"complete"
    }
  ];
  for (const decision of decisions) {
    assert.deepEqual(validateKnowledgeDecision(decision,{libraries}),decision);
  }
});

test("keeps strict safety checks after normalization",()=>{
  const unsafe=[
    commit({libraryKey:"unknown"}),
    commit({target:{
      scope:"existing_folder",segments:["Fabricated"],origin:"skill_suggested"
    }}),
    commit({target:{
      scope:"new_folder",segments:["Suggested"],origin:"skill_suggested"
    }}),
    commit({target:{
      scope:"existing_folder",segments:[".."],origin:"user_explicit"
    }}),
    commit({sourceIntegrity:"partial"}),
    commit({title:""}),
    commit({summary:""}),
    commit({knowledgeSections:null}),
    commit({tags:["duplicate","duplicate"]}),
    {...commit(),absolutePath:"/private/value"}
  ];
  for (const decision of unsafe) {
    assert.throws(
      ()=>validateKnowledgeDecision(decision,{libraries}),
      /knowledge_decision_invalid/
    );
  }
});
