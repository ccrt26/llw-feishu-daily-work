import test from "node:test";
import assert from "node:assert/strict";
import {validateManagedFolderPlan} from "../src/core/managed-folder-plan.mjs";


const options={allowedLibraryKeys:["work-knowledge","personal-knowledge"]};

function plan(overrides={}) {
  return {
    library_key:"work-knowledge",
    folder_plan:{
      mode:"create_if_missing",
      segments:["江苏移动","2026专网项目","方案"],
      origin:"user_explicit"
    },
    ...overrides
  };
}

test("validates one user-explicit low-risk empty-folder plan without resolving a path",()=>{
  const input=plan();
  const result=validateManagedFolderPlan(input,options);
  assert.deepEqual(result,{
    libraryKey:"work-knowledge",
    operation:"create_empty_directories",
    segments:["江苏移动","2026专网项目","方案"],
    risk:"low",
    requiresConfirmation:false
  });
  assert.equal("path" in result,false);
  assert.equal(JSON.stringify(result).includes("/Volumes/"),false);
  result.segments.push("changed");
  assert.deepEqual(input.folder_plan.segments,["江苏移动","2026专网项目","方案"]);
});

test("marks a Skill-suggested folder plan as requiring confirmation",()=>{
  assert.deepEqual(validateManagedFolderPlan(plan({
    folder_plan:{
      mode:"create_if_missing",
      segments:["建议分类"],
      origin:"skill_suggested"
    }
  }),options),{
    libraryKey:"work-knowledge",
    operation:"create_empty_directories",
    segments:["建议分类"],
    risk:"confirmation_required",
    requiresConfirmation:true
  });
});

test("accepts an existing managed root without creating anything",()=>{
  assert.deepEqual(validateManagedFolderPlan(plan({
    folder_plan:{
      mode:"use_existing",
      segments:[],
      origin:"user_explicit"
    }
  }),options),{
    libraryKey:"work-knowledge",
    operation:"use_existing",
    segments:[],
    risk:"none",
    requiresConfirmation:false
  });
});

test("rejects unknown roots, unsafe segments, excessive depth and operation injection",()=>{
  const invalid=[
    plan({library_key:"outside-root"}),
    plan({folder_plan:{mode:"create_if_missing",segments:[],origin:"user_explicit"}}),
    plan({folder_plan:{mode:"use_existing",segments:["unexpected"],origin:"user_explicit"}}),
    plan({folder_plan:{mode:"create_if_missing",segments:[".."],origin:"user_explicit"}}),
    plan({folder_plan:{mode:"create_if_missing",segments:[".hidden"],origin:"user_explicit"}}),
    plan({folder_plan:{mode:"create_if_missing",segments:["a/b"],origin:"user_explicit"}}),
    plan({folder_plan:{mode:"create_if_missing",segments:["a\\b"],origin:"user_explicit"}}),
    plan({folder_plan:{mode:"create_if_missing",segments:["CON"],origin:"user_explicit"}}),
    plan({folder_plan:{mode:"create_if_missing",segments:[" trailing "],origin:"user_explicit"}}),
    plan({folder_plan:{mode:"create_if_missing",segments:["a","b","c","d","e","f"],origin:"user_explicit"}}),
    {...plan(),operation:"move"},
    {...plan(),absolute_path:"/outside"}
  ];
  for (const value of invalid) {
    assert.throws(
      ()=>validateManagedFolderPlan(value,options),
      error=>error?.message==="invalid_managed_folder_plan"&&
        !error.message.includes("outside-root")
    );
  }
});

test("rejects malformed allowlists and never accepts move rename delete or overwrite modes",()=>{
  for (const allowedLibraryKeys of [
    [],
    ["work-knowledge","work-knowledge"],
    ["Bad Key"],
    "work-knowledge"
  ]) {
    assert.throws(
      ()=>validateManagedFolderPlan(plan(),{allowedLibraryKeys}),
      /invalid_managed_folder_plan/
    );
  }
  for (const mode of ["move","rename","delete","overwrite","create_file"]) {
    assert.throws(
      ()=>validateManagedFolderPlan(plan({
        folder_plan:{mode,segments:["方案"],origin:"user_explicit"}
      }),options),
      /invalid_managed_folder_plan/
    );
  }
});
