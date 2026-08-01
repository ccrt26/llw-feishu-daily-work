const MAX_MODEL_IMAGES=16;
const MAX_ORIGINAL_IMAGES=8;
const MAX_PREVALIDATION_DERIVED_IMAGES=128;

export const MODEL_VISUAL_EVIDENCE_SPLIT_REPLY=
  "这次材料中的扫描页面和视频画面超过一次可靠分析范围。请先发送“开始新任务”，再把材料分批发送；本轮没有继续分析，也没有执行保存或其他写入。";

export function planModelVisualEvidence({
  imageFiles,modelImageFiles
}) {
  if (!Array.isArray(imageFiles)||
      imageFiles.length>MAX_ORIGINAL_IMAGES||
      imageFiles.some(value=>typeof value!=="string")||
      !Array.isArray(modelImageFiles)||
      modelImageFiles.length>MAX_PREVALIDATION_DERIVED_IMAGES||
      modelImageFiles.some(value=>
        !value||typeof value!=="object"||Array.isArray(value)
      )) {
    throw new Error("model_visual_evidence_plan_invalid");
  }
  const availableDerivedImageCount=
    MAX_MODEL_IMAGES-imageFiles.length;
  if (modelImageFiles.length>availableDerivedImageCount) {
    return Object.freeze({
      kind:"requires_split",
      maxModelImages:MAX_MODEL_IMAGES,
      originalImageCount:imageFiles.length,
      derivedImageCount:modelImageFiles.length,
      availableDerivedImageCount
    });
  }
  return Object.freeze({
    kind:"ready",
    modelImageFiles:structuredClone(modelImageFiles)
  });
}
