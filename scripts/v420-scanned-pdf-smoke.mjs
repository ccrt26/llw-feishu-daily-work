import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {
  chmod,constants as fsConstants,copyFile,lstat,mkdir,mkdtemp,
  readFile,realpath,rm
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname,isAbsolute,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {
  validatePdfiumRuntime
} from "../src/capabilities/invoice/pdfium-runtime.mjs";
import {
  buildAgentTurnContext
} from "../src/personal-assistant/context-builder.mjs";
import {
  getModelToolDeclarations
} from "../src/personal-assistant/tool-definitions.mjs";
import {
  invokePersonalAssistantCodex
} from "../src/personal-assistant/invoke-personal-assistant.mjs";
import {
  PersonalAssistantClient
} from "../src/personal-assistant/client.mjs";
import {
  loadPersonalAssistantSkillBundle
} from "../src/personal-assistant/skill-bundle.mjs";
import {
  createSourceHandle
} from "../src/personal-assistant/source-handle.mjs";
import {
  TaskPdfReader
} from "../src/personal-assistant/task-pdf-reader.mjs";

const MAX_CODEX_TIMEOUT_MS=120_000;
const SHA=/^[a-f0-9]{64}$/u;
const REPORT_FIELDS=new Set([
  "sourceSha256","pageCount","pageImageSha256","codexImageCount",
  "elapsedMs","outcomeStatus","writerCalls","diagnosticCode"
]);
const CONFIG_FIELDS=new Set([
  "version","sourcePdf","codexPath","pdfProcessorPath","skillRoot",
  "skillManifestPath","tempRoot","pdfPrepareTimeoutMs"
]);

export async function runScannedPdfSmoke({
  sourcePdf,
  codexPath,
  pdfProcessorPath,
  skillBundle,
  tempRoot=tmpdir(),
  pdfPrepareTimeoutMs=60_000,
  timeoutMs=MAX_CODEX_TIMEOUT_MS,
  environment=process.env,
  preparePdf,
  invokeCodex=invokePersonalAssistantCodex,
  now=()=>new Date().toISOString(),
  clock=Date.now
}) {
  validateSmokeConfiguration({
    sourcePdf,codexPath,pdfProcessorPath,skillBundle,tempRoot,
    pdfPrepareTimeoutMs,timeoutMs,environment,preparePdf,
    invokeCodex,now,clock
  });
  const started=clock();
  if (!Number.isSafeInteger(started)||started<0) {
    throw new Error("smoke_configuration_invalid");
  }
  const sourceInfo=await safeInputFile(sourcePdf);
  await ensurePrivateTempBase(tempRoot);
  const root=await mkdtemp(join(tempRoot,"llw-v420-pdf-smoke-"));
  await chmod(root,0o700);
  try {
    const workspaceDir=join(root,"workspace");
    await mkdir(workspaceDir,{mode:0o700});
    await chmod(workspaceDir,0o700);
    const absolutePath=join(workspaceDir,"source-001.pdf");
    await copyFile(sourcePdf,absolutePath,fsConstants.COPYFILE_EXCL);
    await chmod(absolutePath,0o600);
    const sourceSha256=await sha256File(absolutePath);
    const source={
      handle:createSourceHandle({
        sourceId:"source-001",
        displayName:"scanned-one-page.pdf",
        mediaClass:"document",
        format:"pdf",
        relativePath:"source-001.pdf",
        byteSize:sourceInfo.size,
        sha256:sourceSha256,
        availability:"ready"
      }),
      absolutePath,
      archiveExtension:"pdf"
    };
    const reader=new TaskPdfReader({
      pdfProcessorPath,
      ...(preparePdf===undefined?{}:{preparePdf}),
      tempRoot:join(root,"pdf-jobs"),
      maxPages:10,
      maxTextBytes:262_144,
      maxRenderBytes:100*1024*1024,
      maxDimension:3508,
      timeoutMs:pdfPrepareTimeoutMs
    });
    const receivedAt=now();
    if (!canonicalIso(receivedAt)) {
      throw new Error("smoke_configuration_invalid");
    }
    const evidence=await reader.prepare({
      workspaceDir,
      sources:[source],
      now:receivedAt
    });
    const observation=readScannedObservation(evidence);
    if (observation.textAvailable!==false||
        observation.extractedText.trim()!==""||
        evidence.modelImageFiles.length<1) {
      throw new Error("smoke_fixture_not_scanned");
    }
    if (observation.pageCount!==evidence.modelImageFiles.length) {
      throw new Error("smoke_image_evidence_missing");
    }
    const context=buildAgentTurnContext({
      message:{
        source:"wechat",
        instructionText:"先总结，不保存",
        receivedAt
      },
      sources:[source],
      personalRules:[],
      model:"codex",
      toolDeclarations:getModelToolDeclarations(),
      sourceObservations:evidence.observations
    });
    const assistant=new PersonalAssistantClient({
      codex:(modelContext,options)=>invokeCodex({
        codexPath,
        workspaceDir,
        skillBundle,
        context:modelContext,
        imageFiles:options.imageFiles,
        modelImageFiles:options.modelImageFiles,
        environment,
        timeoutMs
      }),
      deepseek:async()=>{throw new Error("smoke_model_invalid");}
    });
    const decision=await assistant.decide(context,{
      workspaceDir,
      imageFiles:[],
      modelImageFiles:evidence.modelImageFiles
    });
    if (decision.kind!=="reply") {
      throw new Error("smoke_direct_reply_required");
    }
    const finished=clock();
    if (!Number.isSafeInteger(finished)||finished<started) {
      throw new Error("smoke_configuration_invalid");
    }
    return validateScannedPdfSmokeReport({
      sourceSha256,
      pageCount:observation.pageCount,
      pageImageSha256:evidence.modelImageFiles[0].sha256,
      codexImageCount:evidence.modelImageFiles.length,
      elapsedMs:finished-started,
      outcomeStatus:"reply",
      writerCalls:0,
      diagnosticCode:null
    });
  } finally {
    await rm(root,{recursive:true,force:true});
  }
}

export function validateScannedPdfSmokeReport(value) {
  if (!plainExact(value,REPORT_FIELDS)||
      !SHA.test(value.sourceSha256||"")||
      !Number.isSafeInteger(value.pageCount)||
      value.pageCount<1||value.pageCount>10||
      !SHA.test(value.pageImageSha256||"")||
      !Number.isSafeInteger(value.codexImageCount)||
      value.codexImageCount!==value.pageCount||
      !Number.isSafeInteger(value.elapsedMs)||
      value.elapsedMs<0||value.elapsedMs>MAX_CODEX_TIMEOUT_MS||
      value.outcomeStatus!=="reply"||
      value.writerCalls!==0||
      value.diagnosticCode!==null) {
    throw new Error("smoke_report_invalid");
  }
  return structuredClone(value);
}

export async function runScannedPdfSmokeFromConfig(configFile) {
  const config=await loadSmokeConfig(configFile);
  await validatePdfiumRuntime(config.pdfProcessorPath);
  const manifest=JSON.parse(
    await readBoundedFile(config.skillManifestPath,256*1024)
  );
  const entry=manifest?.skills?.find(
    item=>item?.name==="llw-personal-assistant"
  );
  if (!entry||!Array.isArray(entry.runtime_files)) {
    throw new Error("smoke_configuration_invalid");
  }
  const skillBundle=await loadPersonalAssistantSkillBundle({
    skillRoot:config.skillRoot,
    runtimeFiles:entry.runtime_files.map(item=>({
      path:item.path,
      sha256:item.sha256
    }))
  });
  return runScannedPdfSmoke({
    sourcePdf:config.sourcePdf,
    codexPath:config.codexPath,
    pdfProcessorPath:config.pdfProcessorPath,
    skillBundle,
    tempRoot:config.tempRoot,
    pdfPrepareTimeoutMs:config.pdfPrepareTimeoutMs,
    timeoutMs:MAX_CODEX_TIMEOUT_MS
  });
}

async function loadSmokeConfig(configFile) {
  if (typeof configFile!=="string"||!isAbsolute(configFile)) {
    throw new Error("smoke_configuration_invalid");
  }
  let value;
  try {
    value=JSON.parse(await readBoundedFile(configFile,64*1024));
  } catch {
    throw new Error("smoke_configuration_invalid");
  }
  if (!plainExact(value,CONFIG_FIELDS)||value.version!==1||
      !isAbsolute(value.sourcePdf||"")||
      !isAbsolute(value.codexPath||"")||
      !isAbsolute(value.pdfProcessorPath||"")||
      !isAbsolute(value.skillRoot||"")||
      !isAbsolute(value.skillManifestPath||"")||
      !isAbsolute(value.tempRoot||"")||
      dirname(value.skillRoot)!==dirname(value.skillManifestPath)||
      !Number.isSafeInteger(value.pdfPrepareTimeoutMs)||
      value.pdfPrepareTimeoutMs<1||
      value.pdfPrepareTimeoutMs>MAX_CODEX_TIMEOUT_MS) {
    throw new Error("smoke_configuration_invalid");
  }
  return structuredClone(value);
}

function validateSmokeConfiguration(value) {
  if (!isAbsolute(value.sourcePdf||"")||
      !isAbsolute(value.codexPath||"")||
      !isAbsolute(value.pdfProcessorPath||"")||
      !isAbsolute(value.tempRoot||"")||
      !validSkillBundle(value.skillBundle)||
      !Number.isSafeInteger(value.pdfPrepareTimeoutMs)||
      value.pdfPrepareTimeoutMs<1||
      value.pdfPrepareTimeoutMs>MAX_CODEX_TIMEOUT_MS||
      !Number.isSafeInteger(value.timeoutMs)||
      value.timeoutMs<1||value.timeoutMs>MAX_CODEX_TIMEOUT_MS||
      !value.environment||typeof value.environment!=="object"||
      Array.isArray(value.environment)||
      !(value.preparePdf===undefined||
        typeof value.preparePdf==="function")||
      typeof value.invokeCodex!=="function"||
      typeof value.now!=="function"||
      typeof value.clock!=="function") {
    throw new Error("smoke_configuration_invalid");
  }
}

function validSkillBundle(value) {
  return value&&typeof value==="object"&&!Array.isArray(value)&&
    Object.keys(value).length===4&&
    typeof value.content==="string"&&value.content.trim()&&
    Number.isSafeInteger(value.fileCount)&&value.fileCount>=1&&
    Number.isSafeInteger(value.totalBytes)&&value.totalBytes>=1&&
    Buffer.byteLength(value.content,"utf8")===
      value.totalBytes+2*(value.fileCount-1)&&
    SHA.test(value.sha256||"")&&
    createHash("sha256").update(value.content,"utf8")
      .digest("hex")===value.sha256;
}

function readScannedObservation(evidence) {
  if (!evidence||!Array.isArray(evidence.observations)||
      evidence.observations.length!==1||
      !Array.isArray(evidence.modelImageFiles)||
      evidence.modelImageFiles.length>10) {
    throw new Error("smoke_image_evidence_missing");
  }
  let value;
  try {
    value=JSON.parse(evidence.observations[0].content);
  } catch {
    throw new Error("smoke_image_evidence_missing");
  }
  if (!value||typeof value!=="object"||Array.isArray(value)||
      value.kind!=="pdf"||
      !Number.isSafeInteger(value.pageCount)||
      value.pageCount<1||value.pageCount>10||
      typeof value.textAvailable!=="boolean"||
      typeof value.extractedText!=="string") {
    throw new Error("smoke_image_evidence_missing");
  }
  return value;
}

async function safeInputFile(file) {
  try {
    const info=await lstat(file);
    if (!info.isFile()||info.isSymbolicLink()||
        info.uid!==process.getuid()||info.size<1||
        info.size>20*1024*1024) {
      throw new Error("unsafe");
    }
    await realpath(file);
    return info;
  } catch {
    throw new Error("smoke_configuration_invalid");
  }
}

async function ensurePrivateTempBase(base) {
  try {
    const info=await lstat(base);
    if (!info.isDirectory()||info.isSymbolicLink()) {
      throw new Error("unsafe");
    }
    await realpath(base);
  } catch {
    throw new Error("smoke_configuration_invalid");
  }
}

async function readBoundedFile(file,maxBytes) {
  const info=await lstat(file);
  if (!info.isFile()||info.isSymbolicLink()||
      info.uid!==process.getuid()||info.size<1||info.size>maxBytes) {
    throw new Error("smoke_configuration_invalid");
  }
  await realpath(file);
  return readFile(file,"utf8");
}

async function sha256File(file) {
  const hash=createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function canonicalIso(value) {
  return typeof value==="string"&&Number.isFinite(Date.parse(value))&&
    new Date(value).toISOString()===value;
}

function plainExact(value,fields) {
  return value&&typeof value==="object"&&!Array.isArray(value)&&
    Object.getPrototypeOf(value)===Object.prototype&&
    Object.keys(value).length===fields.size&&
    Object.keys(value).every(key=>fields.has(key));
}

if (process.argv[1]&&
    resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const report=await runScannedPdfSmokeFromConfig(process.argv[2]);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    const allowed=new Set([
      "smoke_configuration_invalid",
      "smoke_fixture_not_scanned",
      "smoke_image_evidence_missing",
      "smoke_direct_reply_required",
      "smoke_report_invalid",
      "assistant_timeout",
      "assistant_process_failed",
      "assistant_result_invalid",
      "assistant_model_failed",
      "pdf_prepare_failed"
    ]);
    const diagnosticCode=allowed.has(error?.message)
      ?error.message
      :"smoke_failed";
    process.stderr.write(`${JSON.stringify({diagnosticCode})}\n`);
    process.exitCode=1;
  }
}
