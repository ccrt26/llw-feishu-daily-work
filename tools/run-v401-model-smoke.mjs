import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {
  chmod,lstat,mkdir,mkdtemp,readFile,rm,writeFile
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import {PersonalAssistantClient} from "../src/personal-assistant/client.mjs";
import {
  invokePersonalAssistantCodex,invokePersonalAssistantDeepSeek
} from "../src/personal-assistant/invoke-personal-assistant.mjs";
import {
  getModelToolDeclarations
} from "../src/personal-assistant/tool-definitions.mjs";

const CONFIG="/Users/ccrt/Library/Application Support/LLW Assistant/state/feishu-daily-work/config.json";
const run=promisify(execFile);

export async function runV401ModelSmoke({
  configFile=CONFIG,
  skillRoot,
  codexInvoke=invokePersonalAssistantCodex,
  deepseekInvoke=invokePersonalAssistantDeepSeek
}) {
  const config=JSON.parse(await readFile(configFile,"utf8"));
  const root=resolve(skillRoot);
  const workspaceDir=await mkdtemp(join(tmpdir(),"llw-v401-real-model-"));
  await chmod(workspaceDir,0o700);
  const first=join(workspaceDir,"source-001.docx");
  const second=join(workspaceDir,"source-002.docx");
  await createSyntheticDocx(
    first,"合成材料甲：项目代号青竹，交流对象为测试甲。"
  );
  await createSyntheticDocx(
    second,"合成材料乙：项目代号青竹，后续动作为周五前确认方案。"
  );
  const sourceOne=await sourceHandle(
    first,"source-001","合成材料甲.docx"
  );
  const sourceTwo=await sourceHandle(
    second,"source-002","合成材料乙.docx"
  );
  const common={
    currentTime:"2026-07-28T02:00:00.000Z",
    conversation:null,confirmedPersonalRules:[],
    tools:getModelToolDeclarations().map(item=>structuredClone(item)),
    priority:[
      "program_safety","current_instruction","confirmed_personal_rules",
      "source_facts","weak_metadata"
    ],
    dailyCandidates:[]
  };
  const codexContext={
    ...common,model:"codex",entry:"feishu",
    instructionText:"整理这份原始 DOCX 后保存到日常生活/测试资料。",
    sources:[sourceOne]
  };
  const codexMultiContext={
    ...common,model:"codex",entry:"feishu",
    instructionText:"比较并概括这两份材料，不保存。",
    sources:[sourceOne,sourceTwo]
  };
  const deepseekContext={
    ...common,model:"deepseek",entry:"feishu",
    instructionText:"今天完成了方案评审。",
    sources:[]
  };
  let codexCalls=0,deepseekCalls=0;
  const client=new PersonalAssistantClient({
    codex:async(context,{workspaceDir:turnWorkspace})=>{
      codexCalls+=1;
      return codexInvoke({
        codexPath:config.codexPath,workspaceDir:turnWorkspace,
        skillRoot:root,context,imageFiles:[],timeoutMs:120_000
      });
    },
    deepseek:async context=>{
      deepseekCalls+=1;
      return deepseekInvoke({
        model:config.deepseekModel,
        keychainService:config.deepseekKeychainService,
        keychainAccount:config.deepseekKeychainAccount,
        skillRoot:root,context,imageFiles:[]
      });
    }
  });
  try {
    const codexDocx=await client.decide(
      codexContext,{workspaceDir}
    );
    if (codexDocx.kind!=="tool"||
        codexDocx.toolCall.name!=="save_knowledge"||
        JSON.stringify(codexDocx.toolCall.arguments.sourceIds)!==
          JSON.stringify(["source-001"])) {
      throw new Error("model_smoke_unexpected");
    }
    const codexMulti=await client.decide(
      codexMultiContext,{workspaceDir}
    );
    if (codexMulti.kind!=="reply") {
      throw new Error("model_smoke_unexpected");
    }
    const deepseek=config.deepseekEnabled
      ?await client.decide(deepseekContext)
      :null;
    if (deepseek&&(
      deepseek.kind!=="tool"||
      deepseek.toolCall.name!=="record_daily_work"
    )) {
      throw new Error("model_smoke_unexpected");
    }
    return {
      rawInputsIncluded:false,rawOutputsIncluded:false,
      calls:{codex:codexCalls,deepseek:deepseekCalls,writer:0},
      tokens:{input:null,output:null,available:false},
      codexDocx:{
        ...safeDecision(codexDocx),
        selectedSourceIds:["source-001"],writerCalls:0
      },
      codexMulti:{
        ...safeDecision(codexMulti),
        sourceCount:2,writerCalls:0,zeroWrite:true
      },
      deepseek:deepseek
        ?{...safeDecision(deepseek),sourceCount:0,writerCalls:0}
        :{skipped:true,sourceCount:0,writerCalls:0},
      zeroWriteCases:1
    };
  } finally {
    await rm(workspaceDir,{recursive:true,force:true});
  }
}

function safeDecision(value) {
  if (value.kind==="tool") {
    return {kind:"tool",toolName:value.toolCall.name};
  }
  if (value.kind==="ask") {
    return {
      kind:"ask",hasPreparedRule:typeof value.preparedRule==="string"
    };
  }
  return {kind:value.kind};
}

async function createSyntheticDocx(output,text) {
  const packageRoot=join(
    dirname(output),`.${output.split("/").at(-1)}-package`
  );
  const parts={
    "[Content_Types].xml":`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "word/document.xml":`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${xml(text)}</w:t></w:r></w:p></w:body></w:document>`
  };
  for (const [name,content] of Object.entries(parts)) {
    const target=join(packageRoot,name);
    await mkdir(dirname(target),{recursive:true,mode:0o700});
    await writeFile(target,content,{mode:0o600});
  }
  await run("/usr/bin/zip",["-X","-q","-r",output,"."],{
    cwd:packageRoot
  });
  await chmod(output,0o600);
  await rm(packageRoot,{recursive:true,force:true});
}

async function sourceHandle(file,sourceId,displayName) {
  const bytes=await readFile(file);
  const metadata=await lstat(file);
  return {
    sourceId,displayName,mediaClass:"document",format:"docx",
    relativePath:`${sourceId}.docx`,byteSize:metadata.size,
    sha256:createHash("sha256").update(bytes).digest("hex"),
    availability:"ready"
  };
}

function xml(value) {
  return value
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;");
}

if (process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const skillRoot=process.argv[2];
  if (!skillRoot) process.exitCode=1;
  else {
    try {
      process.stdout.write(`${JSON.stringify(
        await runV401ModelSmoke({skillRoot})
      )}\n`);
    } catch {
      process.stdout.write(`${JSON.stringify({
        rawInputsIncluded:false,rawOutputsIncluded:false,status:"failed"
      })}\n`);
      process.exitCode=1;
    }
  }
}
