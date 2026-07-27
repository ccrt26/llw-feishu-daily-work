import test from "node:test";
import assert from "node:assert/strict";
import {executeRecordDailyWork} from "../src/personal-assistant/tools/record-daily-work.mjs";

const record={
  occurred_date:"2026-07-28",occurred_time:"10:00",occurred_end_time:"",
  title:"方案评审",people:["张三"],location:"会议室",
  summary:"完成方案评审。",follow_ups:[],original_text:"今天完成方案评审"
};

test("creates daily work once with Beijing-time facts and Writer receipt",async()=>{
  const calls=[];
  const result=await executeRecordDailyWork({
    toolCall:{name:"record_daily_work",arguments:{
      operation:"create",targetRecordId:"",records:[record]
    }},
    messageId:"m1",createTime:1785196800000,
    writer:{async create(input){
      calls.push(input);
      return {files:["亚信工作/每日工作/2026年07月28日/工作记录.md"]};
    }}
  });
  assert.equal(calls.length,1);
  assert.equal(calls[0].records[0].original_text,"今天完成方案评审");
  assert.equal(result.status,"committed");
  assert.match(result.reply,/已记录每日工作/);
});

test("supplements only one explicit target and keeps Writer failure non-successful",async()=>{
  let supplementCalls=0;
  const result=await executeRecordDailyWork({
    toolCall:{name:"record_daily_work",arguments:{
      operation:"supplement",targetRecordId:"90f29b02eb9ec9bb",
      records:[{...record,occurred_date:"2026-07-27"}]
    }},
    messageId:"m2",createTime:1785196800000,
    writer:{async supplement(){ supplementCalls+=1; throw new Error("vault"); }}
  });
  assert.equal(supplementCalls,1);
  assert.deepEqual(result,{
    status:"failed",
    reply:"内容已理解，但本次每日工作写入失败；你不需要重新解释内容。",
    artifacts:[]
  });
});
