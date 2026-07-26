const TOP_FIELDS=new Set([
  "action","reason_code","question","reply","source_paths","grounding_report","output"
]);
const REPORT_FIELDS=new Set([
  "mode","uses_model_knowledge","contains_inference",
  "needs_current_fact_verification"
]);
const OUTPUT_FIELDS=new Set(["kind","job_file","display_name"]);
const ARTIFACT_FIELDS=new Set(["kind","jobFile","displayName"]);
const ACTIONS=new Set([
  "reply_text","create_draft","revise_draft","reply_file","ask_user",
  "not_found","complete","cancel"
]);
const REASONS=new Set([
  "ready","clarification_required","source_not_found","source_conflict",
  "base_version_conflict","output_format_unsupported","file_evidence_missing",
  "external_action_forbidden","knowledge_write_forbidden",
  "new_task_requires_router","default_chat_disabled","unsafe_instruction",
  "model_switch_forbidden","task_completed","task_cancelled"
]);
const MODES=new Set(["source_strict","hybrid","creative"]);
const OUTPUTS=new Map([
  ["docx","output.docx"],["pptx","output.pptx"],["xlsx","output.xlsx"],
  ["pdf","output.pdf"],["md","output.md"]
]);
const REASONS_BY_ACTION=new Map([
  ["reply_text",new Set([
    "ready","source_conflict","external_action_forbidden",
    "knowledge_write_forbidden","model_switch_forbidden"
  ])],
  ["create_draft",new Set(["ready"])],
  ["revise_draft",new Set(["ready"])],
  ["reply_file",new Set(["ready"])],
  ["ask_user",new Set([
    "clarification_required","base_version_conflict","file_evidence_missing",
    "new_task_requires_router"
  ])],
  ["not_found",new Set([
    "source_not_found","output_format_unsupported","default_chat_disabled",
    "unsafe_instruction"
  ])],
  ["complete",new Set(["task_completed"])],
  ["cancel",new Set(["task_cancelled"])]
]);

export function validateAssistantWorkDecision(value,{
  verifiedSourcePaths,groundingMode,allowedOutputFormats,verifiedArtifact
}) {
  try {
    exact(value,TOP_FIELDS);
    fail(!ACTIONS.has(value.action)||!REASONS.has(value.reason_code)||
      !REASONS_BY_ACTION.get(value.action).has(value.reason_code));
    bounded(value.question,200,true);
    bounded(value.reply,12_000,true);
    fail(!Array.isArray(value.source_paths)||value.source_paths.length>20||
      new Set(value.source_paths).size!==value.source_paths.length);
    const verified=verifiedPaths(verifiedSourcePaths);
    for (const path of value.source_paths) {
      safePath(path);
      fail(!verified.has(path));
    }
    validateReport(value.grounding_report,groundingMode);
    const formats=validateFormats(allowedOutputFormats);
    validateActionShape(value,formats,verifiedArtifact);
    return structuredClone(value);
  } catch {
    throw new Error("assistant_work_decision_invalid");
  }
}

function validateActionShape(value,formats,verifiedArtifact) {
  if (value.action==="ask_user") {
    fail(!value.question||value.reply!==""||value.source_paths.length||
      value.output!==null);
    return;
  }
  fail(value.question!=="");
  if (value.action==="reply_file") {
    fail(!value.reply);
    const output=validateOutput(value.output);
    fail(!formats.has(output.kind));
    const artifact=validateArtifact(verifiedArtifact);
    fail(output.kind!==artifact.kind||output.job_file!==artifact.jobFile||
      output.display_name!==artifact.displayName);
    return;
  }
  fail(value.output!==null);
  fail(!value.reply);
  if (new Set(["not_found","complete","cancel"]).has(value.action)) {
    fail(value.source_paths.length!==0);
  }
}

function validateReport(value,expectedMode) {
  exact(value,REPORT_FIELDS);
  fail(!MODES.has(value.mode)||value.mode!==expectedMode);
  for (const field of [
    "uses_model_knowledge","contains_inference","needs_current_fact_verification"
  ]) fail(typeof value[field]!=="boolean");
  fail(value.mode==="source_strict"&&value.uses_model_knowledge);
}

function validateOutput(value) {
  exact(value,OUTPUT_FIELDS);
  fail(!OUTPUTS.has(value.kind)||value.job_file!==OUTPUTS.get(value.kind));
  bounded(value.display_name,160,false);
  fail(/[\\/\u0000-\u001f\u007f]/u.test(value.display_name));
  return value;
}

function validateArtifact(value) {
  exact(value,ARTIFACT_FIELDS);
  fail(!OUTPUTS.has(value.kind)||value.jobFile!==OUTPUTS.get(value.kind));
  bounded(value.displayName,160,false);
  return value;
}

function validateFormats(value) {
  fail(!Array.isArray(value)||value.length>OUTPUTS.size||
    new Set(value).size!==value.length||value.some(kind=>!OUTPUTS.has(kind)));
  return new Set(value);
}

function verifiedPaths(value) {
  fail(!Array.isArray(value)||value.length>20||new Set(value).size!==value.length);
  for (const path of value) safePath(path);
  return new Set(value);
}

function safePath(value) {
  bounded(value,240,false);
  fail(Buffer.byteLength(value,"utf8")>240||
    value.startsWith("/")||value.startsWith("~")||value.includes("\\")||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value));
  const segments=value.split("/");
  fail(segments.some(segment=>!segment||segment==="."||segment===".."));
}

function exact(value,fields) {
  fail(!value||typeof value!=="object"||Array.isArray(value));
  const keys=Object.keys(value);
  fail(keys.length!==fields.size||keys.some(key=>!fields.has(key)));
}

function bounded(value,max,allowEmpty) {
  fail(typeof value!=="string"||(!allowEmpty&&!value.trim())||
    [...value].length>max||value.includes("\0")||
    (value.length>0&&!value.trim()));
}

function fail(condition) {
  if (condition) throw new Error("invalid");
}
