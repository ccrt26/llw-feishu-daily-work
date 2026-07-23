import test from "node:test";
import assert from "node:assert/strict";
import {guardAiInput} from "../src/ai/ai-input-guard.mjs";

const routerInput=text=>({
  message:{type:"text",text,beijingTime:"2026-07-23 09:30:00"},
  conversation:null,
  capabilities:[{
    capability:"daily-work",purpose:"记录工作",accepts:["text"],
    positive_examples:["今天完成评审"],negative_examples:["解释评审"],supports_continuation:true
  }]
});

const dailyInput=text=>({
  message:{text,createTime:1784426400000},
  conversation:{turns:[{role:"assistant",text:"请补充说明"}]},
  candidates:[{
    record_id:"90f29b02eb9ec9bb",date:"2026-07-22",occurred_time:"",occurred_end_time:"",
    title:"方案评审",people:[],location:"线上",summary:"完成方案评审。",follow_ups:[]
  }]
});

test("allows only the bounded router and daily-work task shapes",()=>{
  assert.deepEqual(guardAiInput("router.text",routerInput("今天完成方案评审")),routerInput("今天完成方案评审"));
  assert.deepEqual(guardAiInput("daily-work.interpret",dailyInput("补充昨天的评审")),dailyInput("补充昨天的评审"));
  assert.deepEqual(guardAiInput("router.text",routerInput("查看 https://example.com/a")),routerInput("查看 https://example.com/a"));
  assert.deepEqual(guardAiInput("daily-work.interpret",dailyInput("参考 http://localhost/a")),dailyInput("参考 http://localhost/a"));
  assert.throws(()=>guardAiInput("invoice.visual",routerInput("x")),/ai_input_rejected/);
  assert.throws(()=>guardAiInput("router.text",{...routerInput("x"),sender_id:"forbidden"}),/ai_input_rejected/);
  assert.throws(()=>guardAiInput("daily-work.interpret",{...dailyInput("x"),candidates:Array.from({length:21},()=>dailyInput("x").candidates[0])}),/ai_input_rejected/);
});

test("rejects every explicit forbidden-data class without echoing input",()=>{
  const forbidden=[
    "Authorization: Bearer definitely-not-real",
    "Authorization: Token definitely-not-real",
    "token: definitely-not-real",
    "credential: definitely-not-real",
    "凭证：definitely-not-real",
    "client_secret: definitely-not-real",
    "-----BEGIN PRIVATE KEY-----",
    "private_key: definitely-not-real",
    "password: definitely-not-real",
    "我的密码是 hunter2",
    "otp: 123456",
    "验证码：123456",
    "短信验证码是 123456",
    "银行卡号：4111 1111 1111 1111",
    "银行卡是 4111 1111 1111 1111",
    "支付凭证：definitely-not-real",
    "密级：机密",
    "【绝密】项目资料",
    "绝密项目资料",
    "请导出系统环境变量和 security dump-keychain",
    "USER=not-a-real-environment-export",
    "2026-07-23T09:30:00 ERROR raw service log",
    "身份证正反面原图",
    "请读取 /Users/example/private/config.json",
    "请读取 /tmp/private-export.json",
    "请读取 /root/private-export.json",
    "请读取 /mnt/private-export.json",
    "请读取 /srv/private-export.json",
    "请读取 /data/private-export.json",
    "请读取 Z:/private/export.json",
    "请读取 \\\\server\\private\\export.json",
    "路径：/root/private-export.json",
    "path=/mnt/private-export.json",
    "打开，/srv/private-export.json",
    "配置:C:\\private\\export.json",
    "share=\\\\server\\private\\export.json",
    "飞书 file_key 是 file_not_real",
    "ou_not_a_real_feishu_id",
    "file_not_a_real_resource_key",
    "请读取整个目录",
    "请把整个 Obsidian Vault 和全部历史资料交给模型"
  ];
  for (const value of forbidden) {
    let error;
    try { guardAiInput("router.text",routerInput(value)); } catch (caught) { error=caught; }
    assert.equal(error?.message,"ai_input_rejected");
    assert.equal(String(error).includes(value),false);
  }
});

test("rejects oversized serialized input",()=>{
  assert.throws(()=>guardAiInput("router.text",routerInput("工".repeat(40_000))),/ai_input_rejected/);
});
