import {spawn} from "node:child_process";
import {mkdtemp,readFile,readdir,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {isAbsolute,join} from "node:path";
import {readDeepSeekApiKey} from "../ai/deepseek-client.mjs";

const MAX_OUTPUT_BYTES=64*1024;

export async function invokePersonalAssistantCodex({
  codexPath,workspaceRoot,skillRoot,context,imageFiles=[],
  environment=process.env,timeoutMs=120_000
}) {
  validateCommon({skillRoot,context,imageFiles,timeoutMs});
  if (!isAbsolute(codexPath)||!isAbsolute(workspaceRoot)) {
    throw new Error("assistant_codex_invalid");
  }
  const outputDir=await mkdtemp(join(tmpdir(),"llw-personal-assistant-"));
  const output=join(outputDir,"result.json");
  const args=[
    "exec","--ephemeral","--sandbox","read-only","--skip-git-repo-check",
    "--color","never","-c",'model_reasoning_effort="medium"',
    ...imageFiles.flatMap(file=>["--image",file]),
    "--output-last-message",output,"-"
  ];
  try {
    const bundle=await readSkillBundle(skillRoot);
    const prompt=[
      "使用 $llw-personal-assistant。",
      "严格根据下面的主 Skill、references、CONTEXT_JSON 和其中唯一工具定义，选择一次直接回复、一次询问或一个工具调用。",
      "直接回复：{\"type\":\"reply\",\"text\":\"...\"}",
      "询问：{\"type\":\"ask\",\"question\":\"...\",\"waitingType\":\"waiting_answer|waiting_file|waiting_confirmation\",\"preparedTool\":null}",
      "工具：{\"type\":\"tool_call\",\"toolName\":\"registered_name\",\"arguments\":{...}}",
      "只输出一个 JSON 对象；不得输出旧 Router/Capability 包装；不得提前宣称工具成功。",
      "SKILL_BUNDLE:",
      bundle,
      "CONTEXT_JSON:",
      JSON.stringify(context)
    ].join("\n");
    await runChild(codexPath,args,{
      cwd:workspaceRoot,environment,stdin:prompt,timeoutMs
    });
    const bytes=await readFile(output);
    if (!bytes.length||bytes.length>MAX_OUTPUT_BYTES) {
      throw new Error("assistant_codex_invalid");
    }
    const value=JSON.parse(bytes.toString("utf8"));
    if (!value||typeof value!=="object"||Array.isArray(value)) {
      throw new Error("assistant_codex_invalid");
    }
    return value;
  } catch (error) {
    if (error?.message==="assistant_codex_invalid") throw error;
    throw new Error("assistant_codex_failed");
  } finally {
    await rm(outputDir,{recursive:true,force:true});
  }
}

export async function invokePersonalAssistantDeepSeek({
  model,keychainService,keychainAccount,skillRoot,context,imageFiles=[],
  keyReader=readDeepSeekApiKey,fetchImpl=fetch,
  endpoint="https://api.deepseek.com/chat/completions",timeoutMs=30_000
}) {
  validateCommon({skillRoot,context,imageFiles,timeoutMs});
  if (imageFiles.length||context.sourceEvidence?.kind!=="text"||
      model!=="deepseek-v4-pro") {
    throw new Error("assistant_deepseek_subset_unsupported");
  }
  const recordTool=context.tools.find(item=>item.name==="record_daily_work");
  if (!recordTool) throw new Error("assistant_deepseek_invalid");
  let key;
  try {
    key=await keyReader({service:keychainService,account:keychainAccount});
  } catch {
    throw new Error("assistant_deepseek_key_unavailable");
  }
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try {
    const bundle=await readSkillBundle(skillRoot);
    const response=await fetchImpl(endpoint,{
      method:"POST",redirect:"error",signal:controller.signal,
      headers:{
        authorization:`Bearer ${key}`,
        "content-type":"application/json",accept:"application/json"
      },
      body:JSON.stringify({
        model,stream:false,thinking:{type:"disabled"},temperature:0,
        messages:[
          {
            role:"system",
            content:[
              "Use the LLW Personal Assistant only for the approved plain-text daily-work subset.",
              "For a direct reply or one question, return one JSON envelope in message content.",
              bundle
            ].join("\n")
          },
          {role:"user",content:JSON.stringify(context)}
        ],
        tools:[{
          type:"function",
          function:{
            name:recordTool.name,
            description:recordTool.description,
            parameters:recordTool.parameters
          }
        }]
      })
    });
    if (!response.ok) throw new Error("assistant_deepseek_failed");
    const envelope=await response.json();
    const message=envelope?.choices?.[0]?.message;
    if (Array.isArray(message?.tool_calls)&&message.tool_calls.length===1) {
      const call=message.tool_calls[0]?.function;
      return {
        type:"tool_call",toolName:call?.name,
        arguments:JSON.parse(call?.arguments)
      };
    }
    const value=JSON.parse(message?.content);
    if (!value||typeof value!=="object"||Array.isArray(value)) {
      throw new Error("assistant_deepseek_failed");
    }
    return value;
  } catch (error) {
    if (error?.message==="assistant_deepseek_subset_unsupported") throw error;
    throw new Error("assistant_deepseek_failed");
  } finally {
    clearTimeout(timer);
  }
}

async function readSkillBundle(skillRoot) {
  const references=join(skillRoot,"references");
  const names=(await readdir(references))
    .filter(name=>name.endsWith(".md")).sort();
  const files=[join(skillRoot,"SKILL.md"),...names.map(name=>
    join(references,name)
  )];
  return (await Promise.all(files.map(async file=>{
    const value=await readFile(file,"utf8");
    if (!value.trim()||Buffer.byteLength(value,"utf8")>256*1024) {
      throw new Error("assistant_skill_invalid");
    }
    return value;
  }))).join("\n\n");
}

function validateCommon({skillRoot,context,imageFiles,timeoutMs}) {
  if (!isAbsolute(skillRoot)||!context||typeof context!=="object"||
      Array.isArray(context)||!Array.isArray(context.tools)||
      !Array.isArray(imageFiles)||imageFiles.length>10||
      imageFiles.some(file=>!isAbsolute(file))||
      !Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>300_000) {
    throw new Error("assistant_invocation_invalid");
  }
}

function runChild(command,args,{cwd,environment,stdin,timeoutMs}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{
      cwd,env:environment,stdio:["pipe","ignore","ignore"]
    });
    let settled=false;
    const timer=setTimeout(()=>{
      if (settled) return;
      settled=true;
      child.kill("SIGKILL");
      reject(new Error("timeout"));
    },timeoutMs);
    child.once("error",error=>{
      if (settled) return;
      settled=true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close",code=>{
      if (settled) return;
      settled=true;
      clearTimeout(timer);
      code===0?resolve():reject(new Error("failed"));
    });
    child.stdin.on("error",()=>{});
    child.stdin.end(stdin,"utf8");
  });
}
