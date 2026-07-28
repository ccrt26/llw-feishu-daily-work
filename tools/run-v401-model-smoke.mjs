import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {PersonalAssistantClient} from "../src/personal-assistant/client.mjs";
import {
  invokePersonalAssistantCodex,invokePersonalAssistantDeepSeek
} from "../src/personal-assistant/invoke-personal-assistant.mjs";
import {
  getModelToolDeclarations
} from "../src/personal-assistant/tool-definitions.mjs";

const CONFIG="/Users/ccrt/Library/Application Support/LLW Assistant/state/feishu-daily-work/config.json";

export async function runV401ModelSmoke({
  configFile=CONFIG,
  skillRoot,
  codexInvoke=invokePersonalAssistantCodex,
  deepseekInvoke=invokePersonalAssistantDeepSeek
}) {
  const config=JSON.parse(await readFile(configFile,"utf8"));
  const root=resolve(skillRoot);
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
    instructionText:"请用一句话概括这段测试材料，不保存。",
    sourceEvidence:{
      kind:"text",displayName:"message.txt",byteSize:24,
      sha256:"a".repeat(64),text:"测试材料说明需要先确认交流目标。",
      structure:[],integrity:"complete",limitations:[],
      jobRef:"source.txt"
    }
  };
  const deepseekContext={
    ...common,model:"deepseek",entry:"feishu",
    instructionText:"今天完成了方案评审。",
    sourceEvidence:{
      kind:"text",displayName:"message.txt",byteSize:33,
      sha256:"b".repeat(64),text:"今天完成了方案评审。",
      structure:[],integrity:"complete",limitations:[],
      jobRef:"source.txt"
    }
  };
  const codexRuleContext={
    ...common,model:"codex",entry:"feishu",
    instructionText:"以后清晰且符合归档规则的餐饮发票都默认归档。",
    sourceEvidence:{
      kind:"text",displayName:"message.txt",byteSize:72,
      sha256:"c".repeat(64),
      text:"以后清晰且符合归档规则的餐饮发票都默认归档。",
      structure:[],integrity:"complete",limitations:[],
      jobRef:"source.txt"
    }
  };
  const client=new PersonalAssistantClient({
    codex:context=>codexInvoke({
      codexPath:config.codexPath,workspaceRoot:config.vaultRoot,
      skillRoot:root,context,imageFiles:[],timeoutMs:120_000
    }),
    deepseek:context=>deepseekInvoke({
      model:config.deepseekModel,
      keychainService:config.deepseekKeychainService,
      keychainAccount:config.deepseekKeychainAccount,
      skillRoot:root,context,imageFiles:[]
    })
  });
  const codex=await client.decide(codexContext);
  const codexRule=await client.decide(codexRuleContext);
  const deepseek=config.deepseekEnabled
    ?await client.decide(deepseekContext)
    :null;
  return {
    rawInputsIncluded:false,rawOutputsIncluded:false,
    codex:safeDecision(codex),
    codexRule:safeDecision(codexRule),
    deepseek:deepseek?safeDecision(deepseek):{skipped:true}
  };
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
