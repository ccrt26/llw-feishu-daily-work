import test from "node:test";
import assert from "node:assert/strict";
import {validateAssistantWorkDecision} from "../src/capabilities/assistant-work/decision-validator.mjs";

const report=(mode="source_strict")=>({
  mode,uses_model_knowledge:mode!=="source_strict",
  contains_inference:mode!=="source_strict",
  needs_current_fact_verification:false
});
const base=()=>({
  action:"reply_text",reason_code:"ready",question:"",
  reply:"合成资料显示验收需要书面确认。",
  source_paths:["工作资料/合成项目/验收.md"],
  grounding_report:report(),output:null
});

test("accepts one exact grounded text decision and deep-clones it",()=>{
  const input=base();
  const result=validateAssistantWorkDecision(input,{
    verifiedSourcePaths:["工作资料/合成项目/验收.md"],
    groundingMode:"source_strict",allowedOutputFormats:[],verifiedArtifact:null
  });
  assert.deepEqual(result,input);
  input.reply="changed";
  assert.notEqual(result.reply,input.reply);
});

test("rejects forged paths, grounding drift, unknown fields and source-strict model knowledge",()=>{
  const options={
    verifiedSourcePaths:["工作资料/合成项目/验收.md"],
    groundingMode:"source_strict",allowedOutputFormats:[],verifiedArtifact:null
  };
  assert.throws(()=>validateAssistantWorkDecision({...base(),source_paths:["../outside.md"]},options),/assistant_work_decision_invalid/);
  assert.throws(()=>validateAssistantWorkDecision({...base(),grounding_report:report("hybrid")},options),/assistant_work_decision_invalid/);
  assert.throws(()=>validateAssistantWorkDecision({...base(),extra:true},options),/assistant_work_decision_invalid/);
  assert.throws(()=>validateAssistantWorkDecision({
    ...base(),grounding_report:{...report(),uses_model_knowledge:true}
  },options),/assistant_work_decision_invalid/);
});

test("enforces action shapes and blocks file claims without verified evidence",()=>{
  const options={
    verifiedSourcePaths:[],groundingMode:"hybrid",
    allowedOutputFormats:["docx"],verifiedArtifact:null
  };
  assert.doesNotThrow(()=>validateAssistantWorkDecision({
    action:"ask_user",reason_code:"clarification_required",question:"希望面向谁？",
    reply:"",source_paths:[],grounding_report:report("hybrid"),output:null
  },options));
  assert.throws(()=>validateAssistantWorkDecision({
    action:"reply_file",reason_code:"ready",question:"",
    reply:"已确认程序验证的 Word 输出文件。",source_paths:[],
    grounding_report:report("hybrid"),
    output:{kind:"docx",job_file:"output.docx",display_name:"合成方案.docx"}
  },options),/assistant_work_decision_invalid/);
  assert.doesNotThrow(()=>validateAssistantWorkDecision({
    action:"reply_file",reason_code:"ready",question:"",
    reply:"已确认程序验证的 Word 输出文件。",source_paths:[],
    grounding_report:report("hybrid"),
    output:{kind:"docx",job_file:"output.docx",display_name:"合成方案.docx"}
  },{
    ...options,
    verifiedArtifact:{kind:"docx",jobFile:"output.docx",displayName:"合成方案.docx"}
  }));
});
