import {readFile,writeFile} from "node:fs/promises";
import {pathToFileURL} from "node:url";
import {invokeDeepSeek} from "../src/ai/deepseek-client.mjs";

const WORKSPACE_ROOT="/Volumes/ZHUTONG/LLW的私人助手/LLW";
const MODEL="deepseek-v4-pro";
const KEYCHAIN_SERVICE="com.llw.deepseek-api";
const KEYCHAIN_ACCOUNT="llw-assistant";
const REPORT_PATH="/private/tmp/llw-v32-real-deepseek-eval-report.json";
const RERUN_REPORT_PATH="/private/tmp/llw-v32-real-deepseek-eval-rerun-report.json";
const SUITES=[
  {
    name:"router",
    skillRoot:`${WORKSPACE_ROOT}/.agents/skills/feishu-intent-router`,
    casesPath:`${WORKSPACE_ROOT}/.agents/skills/feishu-intent-router/evals/cases.jsonl`,
    requiredCount:10
  },
  {
    name:"daily-work",
    skillRoot:`${WORKSPACE_ROOT}/.agents/skills/feishu-daily-work`,
    casesPath:`${WORKSPACE_ROOT}/.agents/skills/feishu-daily-work/evals/cases.jsonl`,
    requiredCount:12
  }
];

export async function runRealDeepSeekEvals({
  invoke=invokeRealCase,
  writeReport=writeDefaultReport,
  caseIds=null
}={}) {
  const selected=caseIds===null?null:validatedCaseIdSet(caseIds);
  const loadedSuites=await Promise.all(SUITES.map(async suite=>({
    ...suite,
    cases:await readCases(suite)
  })));
  if (selected) {
    const known=new Set(loadedSuites.flatMap(suite=>suite.cases.map(evalCase=>evalCase.id)));
    if ([...selected].some(id=>!known.has(id))) throw new Error("evaluation_case_selection_invalid");
  }
  const report={
    reportVersion:2,
    generatedAt:new Date().toISOString(),
    model:MODEL,
    temperature:0,
    keychain:{service:KEYCHAIN_SERVICE,account:KEYCHAIN_ACCOUNT,keyIncluded:false},
    rawInputsIncluded:false,
    rawOutputsIncluded:false,
    selection:selected?"prior_failures":"all",
    suites:[],
    summary:{total:0,passed:0,failed:0}
  };

  for (const suite of loadedSuites) {
    const cases=selected?suite.cases.filter(evalCase=>selected.has(evalCase.id)):suite.cases;
    if (cases.length===0) continue;
    const suiteReport={name:suite.name,total:cases.length,passed:0,failed:0,cases:[]};
    report.suites.push(suiteReport);

    for (const evalCase of cases) {
      const started=Date.now();
      const caseReport={
        id:evalCase.id,
        kind:evalCase.kind,
        task:evalCase.task,
        passed:false,
        durationMs:0,
        failureCodes:[],
        safeResult:{}
      };
      try {
        const result=await invoke({evalCase,skillRoot:suite.skillRoot});
        caseReport.failureCodes.push(...partialMismatchCodes(normalizedExpected(evalCase),result));
        caseReport.failureCodes.push(...manualReviewCodes(evalCase,result));
        caseReport.safeResult=safeResult(result);
        caseReport.passed=caseReport.failureCodes.length===0;
      } catch (error) {
        caseReport.failureCodes.push(safeErrorCode(error));
      }
      caseReport.durationMs=Date.now()-started;
      if (caseReport.passed) suiteReport.passed+=1;
      else suiteReport.failed+=1;
      report.summary.total+=1;
      if (caseReport.passed) report.summary.passed+=1;
      else report.summary.failed+=1;
      suiteReport.cases.push(caseReport);
      await writeReport(report);
    }
  }
  return report;
}

export function selectFailedCaseIds(report) {
  if (
    !report||typeof report!=="object"||Array.isArray(report)||
    report.model!==MODEL||
    report.rawInputsIncluded!==false||
    report.rawOutputsIncluded!==false||
    report.keychain?.keyIncluded!==false||
    !report.summary||!Number.isInteger(report.summary.total)||
    !Number.isInteger(report.summary.passed)||!Number.isInteger(report.summary.failed)||
    !Array.isArray(report.suites)
  ) throw new Error("evaluation_report_invalid");
  const cases=report.suites.flatMap(suite=>Array.isArray(suite?.cases)?suite.cases:[]);
  if (
    cases.length!==report.summary.total||
    report.summary.passed+report.summary.failed!==report.summary.total||
    cases.some(item=>typeof item?.id!=="string"||!item.id||typeof item.passed!=="boolean")||
    new Set(cases.map(item=>item.id)).size!==cases.length
  ) throw new Error("evaluation_report_invalid");
  const failed=cases.filter(item=>!item.passed).map(item=>item.id);
  if (failed.length!==report.summary.failed) throw new Error("evaluation_report_invalid");
  return failed;
}

async function listEvaluationPlan() {
  const suites=[];
  for (const suite of SUITES) {
    const cases=await readCases(suite);
    suites.push({name:suite.name,count:cases.length,skillRoot:suite.skillRoot});
  }
  return {
    model:MODEL,
    temperature:0,
    keychainRead:false,
    networkAccess:false,
    suites
  };
}

async function readCases(suite) {
  const cases=(await readFile(suite.casesPath,"utf8"))
    .trim()
    .split(/\n/)
    .filter(Boolean)
    .map(line=>JSON.parse(line));
  if (cases.length!==suite.requiredCount) throw new Error(`${suite.name}_case_count_mismatch`);
  return cases;
}

function invokeRealCase({evalCase,skillRoot}) {
  return invokeDeepSeek({
    task:evalCase.task,
    model:MODEL,
    keychainService:KEYCHAIN_SERVICE,
    keychainAccount:KEYCHAIN_ACCOUNT,
    skillRoot,
    input:evalCase.input
  });
}

function writeDefaultReport(report) {
  return writeFile(REPORT_PATH,`${JSON.stringify(report,null,2)}\n`,{mode:0o600});
}

function writeRerunReport(report) {
  return writeFile(RERUN_REPORT_PATH,`${JSON.stringify(report,null,2)}\n`,{mode:0o600});
}

function validatedCaseIdSet(caseIds) {
  if (!Array.isArray(caseIds)||caseIds.length===0||caseIds.some(id=>typeof id!=="string"||!id)||new Set(caseIds).size!==caseIds.length) {
    throw new Error("evaluation_case_selection_invalid");
  }
  return new Set(caseIds);
}

function partialMismatchCodes(expected,actual,path="expected") {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${path}:type_mismatch`];
    const failures=expected.length===actual.length?[]:[`${path}:length_mismatch`];
    for (let index=0;index<Math.min(expected.length,actual.length);index+=1) {
      failures.push(...partialMismatchCodes(expected[index],actual[index],`${path}[${index}]`));
    }
    return failures;
  }
  if (expected&&typeof expected==="object") {
    if (!actual||typeof actual!=="object"||Array.isArray(actual)) return [`${path}:type_mismatch`];
    return Object.entries(expected).flatMap(([key,value])=>
      Object.hasOwn(actual,key)
        ? partialMismatchCodes(value,actual[key],`${path}.${key}`)
        : [`${path}.${key}:missing`]
    );
  }
  return Object.is(expected,actual)?[]:[`${path}:value_mismatch`];
}

function normalizedExpected(evalCase) {
  if (evalCase.task!=="router.text"||!Object.hasOwn(evalCase.expected,"reason_code")) return evalCase.expected;
  const {reason_code,...expected}=evalCase.expected;
  return {...expected,reasonCode:reason_code};
}

function manualReviewCodes(evalCase,result) {
  if (evalCase.id==="router-negative-cancel-without-conversation") {
    return result.reason==="cancelled"?["manual:cancel_without_conversation"]:[];
  }
  if (evalCase.id==="daily-positive-multiturn-clarified-supplement") {
    const priorUserTexts=(evalCase.input.conversation?.turns??[])
      .filter(turn=>turn?.role==="user"&&typeof turn.text==="string")
      .map(turn=>turn.text);
    const records=Array.isArray(result.records)?result.records:[];
    if (records.length===0) return ["manual:missing_records"];
    return records.every(record=>
      typeof record.original_text==="string"&&
      record.original_text.length>0&&
      priorUserTexts.some(text=>text.includes(record.original_text))
    )?[]:["manual:original_text_not_from_prior_user_fact"];
  }
  return [];
}

function safeResult(result) {
  const allowed=["action","capability","confidence","reasonCode"];
  return Object.fromEntries(
    allowed
      .filter(key=>typeof result?.[key]==="string")
      .map(key=>[key,result[key]])
  );
}

function safeErrorCode(error) {
  const code=error instanceof Error?error.message:"unknown_error";
  return /^(?:deepseek|router|daily-work)_[a-z0-9_-]+$/.test(code)?code:"evaluation_error";
}

async function main(argumentsList) {
  if (argumentsList.length===1&&argumentsList[0]==="--list") {
    process.stdout.write(`${JSON.stringify(await listEvaluationPlan())}\n`);
    return 0;
  }
  if (argumentsList.length===0) {
    const report=await runRealDeepSeekEvals();
    process.stdout.write(`${JSON.stringify({complete:true,reportPath:REPORT_PATH,summary:report.summary})}\n`);
    return report.summary.failed===0?0:2;
  }
  if (argumentsList.length===1&&argumentsList[0]==="--rerun-failures") {
    let prior;
    try { prior=JSON.parse(await readFile(REPORT_PATH,"utf8")); }
    catch { throw new Error("evaluation_report_invalid"); }
    if (prior.summary?.total!==22) throw new Error("evaluation_report_invalid");
    const caseIds=selectFailedCaseIds(prior);
    if (caseIds.length===0) {
      process.stdout.write(`${JSON.stringify({complete:true,reportPath:REPORT_PATH,summary:prior.summary,rerun:false})}\n`);
      return 0;
    }
    const report=await runRealDeepSeekEvals({caseIds,writeReport:writeRerunReport});
    process.stdout.write(`${JSON.stringify({complete:true,reportPath:RERUN_REPORT_PATH,summary:report.summary,rerun:true})}\n`);
    return report.summary.failed===0?0:2;
  }
  process.stderr.write("usage: node tools/run-real-deepseek-evals.mjs [--list|--rerun-failures]\n");
  return 2;
}

if (process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  process.exitCode=await main(process.argv.slice(2));
}
