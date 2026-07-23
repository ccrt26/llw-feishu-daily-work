import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdtemp,mkdir,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {invokeDeepSeek} from "../src/ai/deepseek-client.mjs";

const routerInput={
  message:{type:"text",text:"今天完成方案评审",beijingTime:"2026-07-23 09:30:00"},conversation:null,
  capabilities:[{capability:"daily-work",purpose:"记录工作",accepts:["text"],positive_examples:["今天完成评审"],negative_examples:["解释评审"],supports_continuation:true}]
};
const routerDecision={action:"route",capability:"daily-work",confidence:"high",reason_code:"direct_match",question:"",reason:""};
const dailySchema={
  type:"object",additionalProperties:false,
  required:["action","confidence","reason","question","source_text","target_record_id","records"],
  properties:{
    action:{type:"string",enum:["create_record","supplement_record","ask_user","ignore"]},
    confidence:{type:"string",enum:["high","medium","low"]},reason:{type:"string",maxLength:500},question:{type:"string",maxLength:200},
    source_text:{type:"string",minLength:1,maxLength:12000},target_record_id:{type:"string",pattern:"^$|^[a-f0-9]{16}$"},
    records:{type:"array",maxItems:20,items:{type:"object",additionalProperties:false,
      required:["occurred_date","occurred_time","occurred_end_time","title","people","location","summary","follow_ups","original_text"],
      properties:{occurred_date:{type:"string",pattern:"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"},occurred_time:{type:"string",pattern:"^$|^([01][0-9]|2[0-3]):[0-5][0-9]$"},occurred_end_time:{type:"string",pattern:"^$|^([01][0-9]|2[0-3]):[0-5][0-9]$"},title:{type:"string",minLength:1,maxLength:80},people:{type:"array",maxItems:50,items:{type:"string",minLength:1,maxLength:80}},location:{type:"string",maxLength:120},summary:{type:"string",minLength:1,maxLength:4000},follow_ups:{type:"array",maxItems:50,items:{type:"string",minLength:1,maxLength:500}},original_text:{type:"string",minLength:1,maxLength:12000}}
    }}
  }
};

async function skillRoot(name="feishu-intent-router") {
  const root=await mkdtemp(join(tmpdir(),"llw-deepseek-skill-"));
  await mkdir(join(root,"references"),{recursive:true});
  await writeFile(join(root,"SKILL.md"),`---\nname: ${name}\n---\n# 规则\n只输出 JSON。\n`);
  await writeFile(join(root,"references","output-schema.json"),JSON.stringify(name==="feishu-daily-work"?dailySchema:{type:"object",additionalProperties:false}));
  return root;
}

async function server(handler) {
  const requests=[];
  const instance=createServer(async (request,response)=>{
    let body=""; for await (const chunk of request) body+=chunk;
    requests.push({method:request.method,url:request.url,headers:request.headers,body});
    await handler(request,response,body);
  });
  await new Promise((resolve,reject)=>{instance.once("error",reject);instance.listen(0,"127.0.0.1",resolve);});
  const address=instance.address();
  return {
    endpoint:`http://127.0.0.1:${address.port}/chat/completions`,requests,
    close:()=>new Promise((resolve,reject)=>instance.close(error=>error?reject(error):resolve()))
  };
}

function responseFor(content=routerDecision,finishReason="stop") {
  return JSON.stringify({choices:[{finish_reason:finishReason,message:{role:"assistant",content:typeof content==="string"?content:JSON.stringify(content)}}]});
}

async function call({endpoint,keyReader=async()=>"not-a-real-key",input=routerInput,...overrides}={}) {
  return invokeDeepSeek({
    task:"router.text",model:"deepseek-v4-flash",keychainService:"com.llw.deepseek-api",
    keychainAccount:"llw-assistant",skillRoot:await skillRoot(),input,keyReader,testEndpoint:endpoint,...overrides
  });
}

test("posts one bounded non-streaming JSON request to the explicit loopback fake endpoint",async()=>{
  const fake=await server(async (_request,response)=>{response.writeHead(200,{"content-type":"application/json"});response.end(responseFor());});
  try {
    const result=await call({endpoint:fake.endpoint});
    assert.deepEqual(result,{action:"route",capability:"daily-work",confidence:"high",reasonCode:"direct_match"});
    assert.equal(fake.requests.length,1);
    const request=fake.requests[0],body=JSON.parse(request.body);
    assert.equal(request.method,"POST"); assert.equal(request.url,"/chat/completions");
    assert.equal(request.headers.authorization,"Bearer not-a-real-key");
    assert.equal(request.headers["content-type"],"application/json");
    assert.equal(body.model,"deepseek-v4-flash"); assert.equal(body.stream,false);
    assert.deepEqual(body.thinking,{type:"disabled"});
    assert.deepEqual(body.response_format,{type:"json_object"});
    assert.equal(body.max_tokens,4096); assert.equal(body.messages.length,2);
    assert.match(body.messages[0].content,/SKILL_MD/); assert.match(body.messages[0].content,/JSON.*结构示例/s);
    assert.match(body.messages[1].content,/CONTEXT_JSON/); assert.match(body.messages[1].content,/今天完成方案评审/);
    assert.equal(request.body.includes("not-a-real-key"),false);
  } finally { await fake.close(); }
});

test("times out one request without retrying",async()=>{
  const fake=await server(async()=>{});
  try {
    await assert.rejects(()=>call({endpoint:fake.endpoint,testTimeoutMs:30}),error=>error.message==="deepseek_timeout");
    assert.equal(fake.requests.length,1);
  } finally { await fake.close(); }
});

test("maps connection, HTTP, oversized and malformed responses to safe categories",async t=>{
  await t.test("connection",async()=>{
    const closed=await server(async()=>{}); const endpoint=closed.endpoint; await closed.close();
    await assert.rejects(()=>call({endpoint}),error=>error.message==="deepseek_connection_failed");
  });
  for (const [name,status,body,code] of [
    ["non-2xx",503,"upstream included user text and not-a-real-key","deepseek_http_error"],
    ["outer invalid JSON",200,"{","deepseek_response_invalid"],
    ["missing choices",200,"{}","deepseek_response_invalid"],
    ["empty content",200,responseFor(""),"deepseek_content_empty"],
    ["truncated",200,responseFor(routerDecision,"length"),"deepseek_finish_reason_invalid"],
    ["content invalid JSON",200,responseFor("{"),"deepseek_output_invalid"],
    ["schema invalid",200,responseFor({...routerDecision,unexpected:true}),"deepseek_output_invalid"]
  ]) await t.test(name,async()=>{
    const fake=await server(async (_request,response)=>{response.writeHead(status,{"content-type":"application/json"});response.end(body);});
    try {
      let error; try { await call({endpoint:fake.endpoint}); } catch (caught) { error=caught; }
      assert.equal(error?.message,code); assert.equal(String(error).includes("今天完成方案评审"),false); assert.equal(String(error).includes("not-a-real-key"),false);
      assert.equal(fake.requests.length,1);
    } finally { await fake.close(); }
  });
  await t.test("oversized",async()=>{
    const fake=await server(async (_request,response)=>{response.writeHead(200,{"content-type":"application/json"});response.end("x".repeat(70_000));});
    try { await assert.rejects(()=>call({endpoint:fake.endpoint}),error=>error.message==="deepseek_response_too_large"); }
    finally { await fake.close(); }
  });
});

test("keychain and guard failures happen before any network request",async t=>{
  await t.test("keychain",async()=>{
    const fake=await server(async (_request,response)=>response.end(responseFor()));
    try {
      await assert.rejects(()=>call({endpoint:fake.endpoint,keyReader:async()=>{throw new Error("keychain detail");}}),error=>error.message==="deepseek_key_unavailable");
      assert.equal(fake.requests.length,0);
    } finally { await fake.close(); }
  });
  await t.test("guard",async()=>{
    const fake=await server(async (_request,response)=>response.end(responseFor())); let keyReads=0;
    try {
      const prohibited=["我的密码是 hunter2","短信验证码是 123456","银行卡是 4111 1111 1111 1111","绝密项目资料"];
      for (const text of ["Authorization: Bearer not-real","Authorization: Token not-real","token: not-real","client_secret: not-real","凭证：not-real","otp: 123456","支付凭证：not-real","/tmp/private.txt","/root/private.txt","路径：/root/private.txt","path=/mnt/private.txt","打开，/srv/private.txt","Z:/private/file.txt","配置:C:\\private\\file.txt","\\\\server\\private\\file.txt","share=\\\\server\\private\\file.txt","ou_not_a_real_id","file_not_a_real_key",...prohibited]) {
        await assert.rejects(()=>call({endpoint:fake.endpoint,input:{...routerInput,message:{...routerInput.message,text}},keyReader:async()=>{keyReads++;return "not-a-real-key";}}),error=>error.message==="ai_input_rejected");
      }
      const dailySkillRoot=await skillRoot("feishu-daily-work");
      for (const text of ["凭证：not-real","路径：/root/private.txt",...prohibited]) await assert.rejects(()=>invokeDeepSeek({
          task:"daily-work.interpret",model:"deepseek-v4-pro",keychainService:"com.llw.deepseek-api",keychainAccount:"llw-assistant",
          skillRoot:dailySkillRoot,input:{message:{text,createTime:1784426400000},conversation:null,candidates:[]},
          keyReader:async()=>{keyReads++;return "not-a-real-key";},testEndpoint:fake.endpoint
        }),error=>error.message==="ai_input_rejected");
      assert.equal(keyReads,0); assert.equal(fake.requests.length,0);
    } finally { await fake.close(); }
  });
  await t.test("guard precedes Skill reads",async()=>{
    let keyReads=0;
    await assert.rejects(()=>invokeDeepSeek({task:"router.text",model:"deepseek-v4-pro",keychainService:"com.llw.deepseek-api",keychainAccount:"llw-assistant",skillRoot:"/definitely/missing",input:{...routerInput,message:{...routerInput.message,text:"我的密码是 hunter2"}},keyReader:async()=>{keyReads++;return "not-a-real-key";},testEndpoint:"http://127.0.0.1:1/chat/completions"}),error=>error.message==="ai_input_rejected");
    assert.equal(keyReads,0);
  });
});

test("validates a real daily-work response with the existing action validator",async()=>{
  const text="今天完成了方案评审";
  const decision={
    action:"create_record",confidence:"high",reason:"明确新工作",question:"",source_text:text,target_record_id:"",
    records:[{occurred_date:"2026-07-23",occurred_time:"",occurred_end_time:"",title:"方案评审",people:[],location:"",summary:"完成方案评审。",follow_ups:[],original_text:text}]
  };
  const fake=await server(async (_request,response)=>{response.writeHead(200,{"content-type":"application/json"});response.end(responseFor(decision));});
  try {
    const result=await invokeDeepSeek({
      task:"daily-work.interpret",model:"deepseek-v4-pro",keychainService:"com.llw.deepseek-api",keychainAccount:"llw-assistant",
      skillRoot:await skillRoot("feishu-daily-work"),input:{message:{text,createTime:1784426400000},conversation:null,candidates:[]},
      keyReader:async()=>"not-a-real-key",testEndpoint:fake.endpoint
    });
    assert.equal(result.action,"create_record"); assert.equal(result.records[0].original_text,text); assert.equal(fake.requests.length,1);
  } finally { await fake.close(); }
});

test("enforces the current daily-work output Schema before the existing action validator",async t=>{
  const text="今天完成了方案评审";
  const record={occurred_date:"2026-07-23",occurred_time:"",occurred_end_time:"",title:"方案评审",people:[],location:"",summary:"完成方案评审。",follow_ups:[],original_text:text};
  const valid={action:"create_record",confidence:"high",reason:"明确新工作",question:"",source_text:text,target_record_id:"",records:[record]};
  const invalid=[
    ["top-level maxLength",{...valid,reason:"x".repeat(501)}],
    ["record maxItems",{...valid,records:Array.from({length:21},()=>record)}],
    ["record maxLength",{...valid,records:[{...record,title:"x".repeat(81)}]}],
    ["array maxItems",{...valid,records:[{...record,people:Array.from({length:51},()=>"张三")}]}],
    ["array item minLength",{...valid,records:[{...record,follow_ups:[""]}]}]
  ];
  const root=await skillRoot("feishu-daily-work");
  for (const [name,decision] of invalid) await t.test(name,async()=>{
    const fake=await server(async (_request,response)=>{response.writeHead(200,{"content-type":"application/json"});response.end(responseFor(decision));});
    try {
      await assert.rejects(()=>invokeDeepSeek({task:"daily-work.interpret",model:"deepseek-v4-pro",keychainService:"com.llw.deepseek-api",keychainAccount:"llw-assistant",skillRoot:root,input:{message:{text,createTime:1784426400000},conversation:null,candidates:[]},keyReader:async()=>"not-a-real-key",testEndpoint:fake.endpoint}),error=>error.message==="deepseek_output_invalid");
      assert.equal(fake.requests.length,1);
    } finally { await fake.close(); }
  });
});

test("rejects malformed daily input and an oversized request before key or network access",async()=>{
  let keyReads=0; const root=await skillRoot("feishu-daily-work"),routerRoot=await skillRoot();
  await assert.rejects(()=>invokeDeepSeek({
    task:"router.text",model:"deepseek-v4-pro",keychainService:"com.llw.deepseek-api",keychainAccount:"llw-assistant",skillRoot:routerRoot,
    input:{...routerInput,capabilities:[null]},keyReader:async()=>{keyReads++;return "not-a-real-key";},testEndpoint:"http://127.0.0.1:1/chat/completions"
  }),error=>error.message==="ai_input_rejected");
  for (const input of [
    {message:{text:"工作",createTime:Number.NaN},conversation:null,candidates:[]},
    {message:{text:"工作",createTime:1e20},conversation:null,candidates:[]},
    {message:{text:"工作",createTime:1784426400000},conversation:{turns:[null]},candidates:[]},
    {message:{text:"工作",createTime:1784426400000},conversation:null,candidates:[null]}
  ]) await assert.rejects(()=>invokeDeepSeek({
      task:"daily-work.interpret",model:"deepseek-v4-pro",keychainService:"com.llw.deepseek-api",keychainAccount:"llw-assistant",skillRoot:root,input,
      keyReader:async()=>{keyReads++;return "not-a-real-key";},testEndpoint:"http://127.0.0.1:1/chat/completions"
    }),error=>error.message==="ai_input_rejected");
  await writeFile(join(root,"SKILL.md"),`---\nname: feishu-daily-work\n---\n${"x".repeat(140_000)}`);
  await assert.rejects(()=>invokeDeepSeek({
    task:"daily-work.interpret",model:"deepseek-v4-pro",keychainService:"com.llw.deepseek-api",keychainAccount:"llw-assistant",skillRoot:root,
    input:{message:{text:"工作",createTime:1784426400000},conversation:null,candidates:[]},keyReader:async()=>{keyReads++;return "not-a-real-key";},testEndpoint:"http://127.0.0.1:1/chat/completions"
  }),error=>error.message==="deepseek_request_too_large");
  assert.equal(keyReads,0);
});

test("rejects legacy models and non-loopback test endpoints before key access",async()=>{
  let reads=0; const root=await skillRoot();
  for (const [model,testEndpoint] of [["deepseek-chat","http://127.0.0.1:1/chat/completions"],["deepseek-v4-pro","https://example.com/chat/completions"]]) {
    await assert.rejects(()=>invokeDeepSeek({task:"router.text",model,keychainService:"com.llw.deepseek-api",keychainAccount:"llw-assistant",skillRoot:root,input:routerInput,keyReader:async()=>{reads++;return "not-a-real-key";},testEndpoint}),/deepseek_configuration_invalid/);
  }
  assert.equal(reads,0);
});
