import test from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_VISUAL_EVIDENCE_SPLIT_REPLY,
  planModelVisualEvidence
} from "../src/personal-assistant/model-visual-evidence-plan.mjs";

function derived(count) {
  return Array.from({length:count},(_,index)=>({
    sourceId:"source-001",
    relativePath:
      `source-001.page-${String(index+1).padStart(3,"0")}.png`,
    sha256:"a".repeat(64),
    pageNumber:index+1
  }));
}

test("keeps every derived image when the total is at most sixteen",()=>{
  const files=derived(14);
  const result=planModelVisualEvidence({
    imageFiles:["/private/source-001.png","/private/source-002.png"],
    modelImageFiles:files
  });
  assert.equal(result.kind,"ready");
  assert.deepEqual(result.modelImageFiles,files);
  assert.notEqual(result.modelImageFiles,files);
});

test("requires batching instead of truncating an over-budget source set",()=>{
  const result=planModelVisualEvidence({
    imageFiles:["/private/source-001.png","/private/source-002.png"],
    modelImageFiles:derived(15)
  });
  assert.deepEqual(result,{
    kind:"requires_split",
    maxModelImages:16,
    originalImageCount:2,
    derivedImageCount:15,
    availableDerivedImageCount:14
  });
  assert.match(MODEL_VISUAL_EVIDENCE_SPLIT_REPLY,/开始新任务/u);
  assert.match(
    MODEL_VISUAL_EVIDENCE_SPLIT_REPLY,
    /没有执行保存或其他写入/u
  );
});

test("classifies a bounded twenty-page aggregate before file validation",()=>{
  assert.equal(planModelVisualEvidence({
    imageFiles:[],
    modelImageFiles:derived(20)
  }).kind,"requires_split");
});

test("rejects more than eight original image entries",()=>{
  assert.throws(()=>planModelVisualEvidence({
    imageFiles:Array(9).fill("/private/image.png"),
    modelImageFiles:[]
  }),/model_visual_evidence_plan_invalid/u);
});

test("rejects an unbounded derived-image aggregate",()=>{
  assert.throws(()=>planModelVisualEvidence({
    imageFiles:[],
    modelImageFiles:Array(129).fill({})
  }),/model_visual_evidence_plan_invalid/u);
});
