import {validateToolCall} from "../tool-definitions.mjs";

export async function executeRecordDailyWork({
  toolCall,messageId,createTime,writer
}) {
  const call=validateToolCall(toolCall);
  if (call.name!=="record_daily_work") throw new Error("tool_call_invalid");
  const {operation,targetRecordId,records}=call.arguments;
  if ((operation==="create"&&targetRecordId!=="")||
      (operation==="supplement"&&(!/^[a-f0-9]{16}$/u.test(targetRecordId)||
        records.length!==1))) {
    throw new Error("tool_call_invalid");
  }
  try {
    const result=operation==="create"
      ?await writer.create({messageId,createTime,records})
      :await writer.supplement({
        messageId,createTime,targetRecordId,record:records[0]
      });
    const files=[...(result.files||[])];
    return {
      status:"committed",
      reply:`${operation==="create"?"已记录每日工作":"已补充每日工作"}。\n位置：${files.join("、")}`,
      artifacts:files
    };
  } catch {
    return {
      status:"failed",
      reply:"内容已理解，但本次每日工作写入失败；你不需要重新解释内容。",
      artifacts:[]
    };
  }
}
