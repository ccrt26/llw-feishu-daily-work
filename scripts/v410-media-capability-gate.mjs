import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {
  chmod,copyFile,mkdtemp,readFile,rename,rm,writeFile
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename,isAbsolute,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";

const SCRIPT_PATH=fileURLToPath(import.meta.url);
const EXPECTED={
  audioPhrase:"请把测试代号海风七三一九记录下来",
  visualCode:"BLUE-7319",
  visualSequence:["circle","square","triangle"],
  codeTimeRangeMs:{start:5_000,end:7_000}
};

if (process.argv[1]&&resolve(process.argv[1])===SCRIPT_PATH) {
  try {
    const options=parseArguments(process.argv.slice(2));
    const evidence=await runMediaCapabilityGate(options);
    const report=renderGateReport(evidence);
    await atomicWrite(options.writeReport,report);
    process.stdout.write(
      `${evidence.result.mandatoryPassed
        ?"DIRECT_MEDIA_BACKEND_ELIGIBLE"
        :"STOP_AFTER_FOUNDATION"}\n`
    );
  } catch (error) {
    process.stderr.write(`${sanitize(error?.message||String(error))}\n`);
    process.exitCode=1;
  }
}

export async function runMediaCapabilityGate({
  fixtureRoot,
  writeReport,
  codexBinary="codex",
  timeoutMs=180_000,
  invoke=invokeCurrentCodex
}) {
  if (!isAbsolute(fixtureRoot)||!isAbsolute(writeReport)||
      !Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>300_000) {
    throw new Error("media_gate_invalid");
  }
  const manifest=JSON.parse(
    await readFile(join(fixtureRoot,"manifest.json"),"utf8")
  );
  validateManifest(manifest);
  const audio=join(fixtureRoot,manifest.files.audio);
  const video=join(fixtureRoot,manifest.files.video);
  if (await sha256(audio)!==manifest.sha256.audio||
      await sha256(video)!==manifest.sha256.video) {
    throw new Error("media_gate_fixture_integrity");
  }

  const workspace=await mkdtemp(join(tmpdir(),"llw-v410-codex-media-"));
  await chmod(workspace,0o700);
  const started=Date.now();
  let raw,result,invocationError=null;
  try {
    const modelAudio=join(workspace,"source-001.aiff");
    const modelVideo=join(workspace,"source-002.mov");
    await copyFile(audio,modelAudio);
    await copyFile(video,modelVideo);
    await chmod(modelAudio,0o600);
    await chmod(modelVideo,0o600);
    raw=await invoke({
      codexBinary,workspace,timeoutMs
    });
    result=evaluateGateResult(raw);
  } catch (error) {
    invocationError=sanitize(error?.message||String(error));
    result=errorGateResult(invocationError);
  } finally {
    await rm(workspace,{recursive:true,force:true});
  }
  return {
    environment:{
      codexVersion:await commandVersion(codexBinary),
      nodeVersion:process.version,
      invocationMode:"one read-only Codex call; no media preprocessing"
    },
    elapsedMs:Date.now()-started,
    invocationError,
    result
  };
}

export function evaluateGateResult(raw) {
  validateRawResult(raw);
  const audioInspected=raw.directlyInspectedAudio===true;
  const videoInspected=raw.directlyInspectedVideo===true;
  const normalizedPhrase=normalizePhrase(raw.audioPhrase);
  const expectedPhrase=normalizePhrase(EXPECTED.audioPhrase);
  const observedSequence=raw.visualSequence.map(value=>
    value.trim().toLocaleLowerCase("en-US")
  );
  const range=raw.codeTimeRangeMs;
  const cases=[
    gateCase({
      id:"audio_instruction",
      inspected:audioInspected,
      passed:normalizedPhrase.includes(expectedPhrase)||
        normalizedPhrase.includes("海风7319"),
      expected:"synthetic spoken code 海风七三一九",
      observed:raw.audioPhrase,
      limitations:raw.limitations
    }),
    gateCase({
      id:"video_visual_only_fact",
      inspected:videoInspected,
      passed:raw.visualCode?.trim().toUpperCase()===EXPECTED.visualCode,
      expected:EXPECTED.visualCode,
      observed:raw.visualCode,
      limitations:raw.limitations
    }),
    gateCase({
      id:"video_temporal_order",
      inspected:videoInspected,
      passed:observedSequence.length===3&&
        observedSequence.every(
          (value,index)=>value===EXPECTED.visualSequence[index]
        ),
      expected:EXPECTED.visualSequence.join(" -> "),
      observed:observedSequence.join(" -> "),
      limitations:raw.limitations
    }),
    gateCase({
      id:"video_time_lookup",
      inspected:videoInspected,
      passed:validObservedRange(range)&&
        range.start<=EXPECTED.codeTimeRangeMs.end&&
        range.end>=EXPECTED.codeTimeRangeMs.start&&
        range.start>=3_000&&range.end<=9_000,
      expected:"approximately 5000-7000 ms",
      observed:range?`${range.start}-${range.end} ms`:null,
      limitations:raw.limitations
    })
  ];
  return {
    cases,
    mandatoryPassed:cases
      .filter(item=>new Set([
        "video_visual_only_fact","video_temporal_order"
      ]).has(item.id))
      .every(item=>item.status==="pass"),
    directMediaSupported:cases.every(item=>item.status==="pass"),
    limitations:raw.limitations.map(sanitize)
  };
}

export function renderGateReport({
  environment,elapsedMs,result,invocationError=null
}) {
  const decision=result.mandatoryPassed
    ?"DIRECT_MEDIA_BACKEND_ELIGIBLE"
    :"STOP_AFTER_FOUNDATION";
  const rows=result.cases.map(item=>
    `| ${item.id} | ${item.status} | ${safeCell(item.expected)} | ${safeCell(item.observed)} |`
  ).join("\n");
  const limitations=result.limitations.length
    ?result.limitations.map(value=>`- ${sanitize(value)}`).join("\n")
    :"- 无";
  return `# V4.1.0 当前 Codex 媒体能力门禁

Decision: ${decision}

- Codex：${sanitize(environment.codexVersion)}
- Node.js：${sanitize(environment.nodeVersion)}
- 调用方式：${sanitize(environment.invocationMode)}
- 耗时：${elapsedMs} ms
- 调用错误：${invocationError?sanitize(invocationError):"无"}

本门禁使用一段系统现场生成的虚构音频和一段只含几何图形与虚构代号的视频。Codex 只收到原始音频和原始视频，没有收到 manifest、转写、截图或答案。

| 检查项 | 结果 | 预期 | 观察 |
|---|---|---|---|
${rows}

## 限制

${limitations}

## 判定规则

只有 \`video_visual_only_fact\` 与 \`video_temporal_order\` 都通过，才允许继续把当前 Codex 运行链作为直接视频读取候选。本报告不代表已启用生产媒体输入。
`;
}

async function invokeCurrentCodex({
  codexBinary,workspace,timeoutMs
}) {
  const outputRoot=await mkdtemp(join(tmpdir(),"llw-v410-codex-output-"));
  const schemaPath=join(outputRoot,"schema.json");
  const outputPath=join(outputRoot,"result.json");
  await writeFile(schemaPath,`${JSON.stringify(outputSchema(),null,2)}\n`,{
    mode:0o600
  });
  const prompt=[
    "Inspect only source-001.aiff and source-002.mov in the current read-only directory.",
    "Do not search outside this directory. Do not use the internet. Do not install or create tools.",
    "Do not infer answers from filenames. No manifest, transcript, frames, or expected answers are provided.",
    "Determine directly from the original media:",
    "1. What exact Chinese instruction is spoken in the audio?",
    "2. What exact alphanumeric code appears only in the video image?",
    "3. What is the order of the three visible geometric shapes?",
    "4. At approximately what millisecond range does the code appear?",
    "If the current Codex CLI cannot inspect a source, set its directlyInspected flag to false, use null or an empty array for its answers, and state the limitation. Never guess."
  ].join("\n");
  try {
    await runChild(codexBinary,[
      "exec","--ephemeral","--sandbox","read-only",
      "--skip-git-repo-check","--color","never",
      "-c",'model_reasoning_effort="medium"',
      "--output-schema",schemaPath,
      "--output-last-message",outputPath,
      "-"
    ],{
      cwd:workspace,stdin:prompt,timeoutMs
    });
    const bytes=await readFile(outputPath);
    if (!bytes.length||bytes.length>64*1024) {
      throw new Error("media_gate_codex_output_invalid");
    }
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    await rm(outputRoot,{recursive:true,force:true});
  }
}

function outputSchema() {
  return {
    type:"object",
    additionalProperties:false,
    required:[
      "audioPhrase","visualCode","visualSequence","codeTimeRangeMs",
      "directlyInspectedAudio","directlyInspectedVideo","limitations"
    ],
    properties:{
      audioPhrase:{type:["string","null"]},
      visualCode:{type:["string","null"]},
      visualSequence:{
        type:"array",maxItems:3,items:{type:"string"}
      },
      codeTimeRangeMs:{
        anyOf:[
          {type:"null"},
          {
            type:"object",additionalProperties:false,
            required:["start","end"],
            properties:{
              start:{type:"integer",minimum:0,maximum:30_000},
              end:{type:"integer",minimum:0,maximum:30_000}
            }
          }
        ]
      },
      directlyInspectedAudio:{type:"boolean"},
      directlyInspectedVideo:{type:"boolean"},
      limitations:{
        type:"array",maxItems:8,
        items:{type:"string",maxLength:1_000}
      }
    }
  };
}

function validateRawResult(raw) {
  const fields=new Set([
    "audioPhrase","visualCode","visualSequence","codeTimeRangeMs",
    "directlyInspectedAudio","directlyInspectedVideo","limitations"
  ]);
  if (!raw||typeof raw!=="object"||Array.isArray(raw)||
      Object.keys(raw).length!==fields.size||
      Object.keys(raw).some(key=>!fields.has(key))||
      !nullableText(raw.audioPhrase)||
      !nullableText(raw.visualCode)||
      !Array.isArray(raw.visualSequence)||raw.visualSequence.length>3||
      raw.visualSequence.some(value=>typeof value!=="string")||
      !(raw.codeTimeRangeMs===null||validObservedRange(raw.codeTimeRangeMs))||
      typeof raw.directlyInspectedAudio!=="boolean"||
      typeof raw.directlyInspectedVideo!=="boolean"||
      !Array.isArray(raw.limitations)||raw.limitations.length>8||
      raw.limitations.some(value=>
        typeof value!=="string"||Buffer.byteLength(value,"utf8")>4_000
      )) {
    throw new Error("media_gate_result_invalid");
  }
}

function validateManifest(value) {
  if (value?.version!==1||value.containsUserData!==false||
      value.audioPhrase!==EXPECTED.audioPhrase||
      value.visualOnlyCode!==EXPECTED.visualCode||
      value.visualOnlyCodeSpoken!==false||
      value.sequenceSpoken!==false||
      value.files?.audio!=="instruction.aiff"||
      value.files?.video!=="visual-facts.mov"||
      !/^[a-f0-9]{64}$/u.test(value.sha256?.audio||"")||
      !/^[a-f0-9]{64}$/u.test(value.sha256?.video||"")) {
    throw new Error("media_gate_manifest_invalid");
  }
}

function gateCase({
  id,inspected,passed,expected,observed,limitations
}) {
  return {
    id,
    status:inspected?(passed?"pass":"fail"):"unsupported",
    expected,
    observed:observed??null,
    limitation:inspected?null:sanitize(limitations.join("; "))
  };
}

function errorGateResult(error) {
  return {
    cases:[
      "audio_instruction","video_visual_only_fact",
      "video_temporal_order","video_time_lookup"
    ].map(id=>({
      id,status:"error",expected:null,observed:null,
      limitation:sanitize(error)
    })),
    mandatoryPassed:false,
    directMediaSupported:false,
    limitations:[sanitize(error)]
  };
}

function validObservedRange(value) {
  return value&&typeof value==="object"&&!Array.isArray(value)&&
    Object.keys(value).length===2&&
    Number.isInteger(value.start)&&Number.isInteger(value.end)&&
    value.start>=0&&value.end>value.start&&value.end<=30_000;
}

function nullableText(value) {
  return value===null||
    (typeof value==="string"&&Buffer.byteLength(value,"utf8")<=4_000);
}

function normalizePhrase(value) {
  return typeof value==="string"
    ?value.normalize("NFKC").replaceAll(/\s|[，。！？、,!.?]/gu,"")
    :"";
}

function safeCell(value) {
  const text=Array.isArray(value)?value.join(" -> "):String(value??"无");
  return sanitize(text).replaceAll("|","\\|").replaceAll("\n"," ");
}

function sanitize(value) {
  return String(value)
    .replaceAll(
      /\/(?:Users|Volumes|private|var|tmp)\/[^\s)\]}`"']+/gu,
      "<absolute-path>"
    )
    .slice(0,4_096);
}

async function sha256(file) {
  const hash=createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function runChild(command,args,{cwd,stdin="",timeoutMs=30_000}={}) {
  return new Promise((resolvePromise,rejectPromise)=>{
    const child=spawn(command,args,{
      cwd,stdio:["pipe","ignore","pipe"]
    });
    let stderr="";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data",chunk=>{
      if (stderr.length<8_192) stderr+=chunk;
    });
    let settled=false;
    const timeout=setTimeout(()=>{
      if (settled) return;
      settled=true;
      child.kill("SIGKILL");
      rejectPromise(new Error("media_gate_codex_timeout"));
    },timeoutMs);
    child.once("error",error=>{
      if (settled) return;
      settled=true;
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.once("close",code=>{
      if (settled) return;
      settled=true;
      clearTimeout(timeout);
      code===0
        ?resolvePromise()
        :rejectPromise(new Error(
          `media_gate_codex_failed:${sanitize(stderr)}`
        ));
    });
    child.stdin.on("error",()=>{});
    child.stdin.end(stdin,"utf8");
  });
}

async function commandVersion(command) {
  return new Promise(resolvePromise=>{
    const child=spawn(command,["--version"],{
      stdio:["ignore","pipe","ignore"]
    });
    let output="";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data",chunk=>{
      if (output.length<1_000) output+=chunk;
    });
    child.once("error",()=>resolvePromise("unavailable"));
    child.once("close",code=>resolvePromise(
      code===0?sanitize(output.trim()):"unavailable"
    ));
  });
}

async function atomicWrite(file,text) {
  const temporary=`${file}.partial`;
  await writeFile(temporary,text,{encoding:"utf8",mode:0o600});
  await rename(temporary,file);
}

function parseArguments(args) {
  const result={codexBinary:"codex",timeoutMs:180_000};
  for (let index=0;index<args.length;index+=2) {
    const key=args[index],value=args[index+1];
    if (!value) throw new Error("media_gate_arguments_invalid");
    if (key==="--fixture-root") result.fixtureRoot=resolve(value);
    else if (key==="--write-report") result.writeReport=resolve(value);
    else if (key==="--codex") result.codexBinary=value;
    else throw new Error("media_gate_arguments_invalid");
  }
  if (!result.fixtureRoot||!result.writeReport||
      basename(result.writeReport).startsWith(".")) {
    throw new Error("media_gate_arguments_invalid");
  }
  return result;
}
