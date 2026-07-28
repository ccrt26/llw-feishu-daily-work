import {createHash} from "node:crypto";
import {validateToolCall} from "../tool-definitions.mjs";
import {createSourceHandle} from "../source-handle.mjs";
import {
  validateInvoiceExtraction,deriveInvoiceRuleDecision
} from "../../capabilities/invoice/decision-validator.mjs";

export async function executeArchiveDiningInvoice({
  toolCall,sourceBindings,taskKey,writer,currentInstruction=""
}) {
  const call=validateToolCall(toolCall);
  if (call.name!=="archive_dining_invoice") {
    throw new Error("tool_call_invalid");
  }
  if (/(?:不要|不|无需|禁止)(?:自动)?归档|只(?:看|告诉).*(?:金额|内容)/u
    .test(currentInstruction)) {
    return {
      status:"rejected",items:[],
      reply:"已按本轮要求只查看，不归档。",artifacts:[]
    };
  }
  if (typeof taskKey!=="string"||!taskKey||
      typeof writer?.archive!=="function") {
    throw new Error("tool_call_invalid");
  }
  const bindings=bindingMap(sourceBindings);
  const prepared=[];
  let clarification=false;
  try {
    for (const item of call.arguments.items) {
      const binding=bindings.get(item.sourceId);
      if (!binding) throw new Error("unknown_source");
      const extraction=validateInvoiceExtraction(item.extraction);
      const decision=deriveInvoiceRuleDecision(extraction);
      if (decision.action!=="archive_dining") {
        clarification||=decision.action==="needs_clarification";
        prepared.push({sourceId:item.sourceId,decision:null});
      } else {
        prepared.push({sourceId:item.sourceId,binding,decision});
      }
    }
  } catch {
    return {
      status:"rejected",items:[],
      reply:"这批发票中有文件未满足安全归档条件，本次一张也没有归档。",
      artifacts:[]
    };
  }
  if (prepared.some(item=>item.decision===null)) {
    return {
      status:clarification?"awaiting_clarification":"rejected",
      items:[],
      reply:"这批发票中有文件未满足餐饮发票归档条件，本次一张也没有归档。",
      artifacts:[]
    };
  }
  const outcomes=[],artifacts=[];
  for (const item of prepared) {
    const transactionId=createHash("sha256")
      .update(`${taskKey}\0${item.sourceId}`)
      .digest("hex").slice(0,32);
    try {
      const result=await writer.archive({
        transactionId,
        source:item.binding.absolutePath,
        invoice:item.decision.invoice,
        extension:item.binding.archiveExtension||
          item.binding.handle.format
      });
      const path=result?.relativePath||result?.path;
      if (!result||!new Set(["committed","existing"]).has(result.status)||
          !safeRelative(path)) {
        throw new Error("writer_result_invalid");
      }
      const status=result.status==="existing"?"existing":"committed";
      outcomes.push({
        sourceId:item.sourceId,status,relativePath:path,reasonCode:null
      });
      artifacts.push(path);
    } catch {
      outcomes.push({
        sourceId:item.sourceId,status:"failed",
        relativePath:null,reasonCode:"tool_execution_failed"
      });
      return {
        status:artifacts.length?"partial":"failed",
        items:outcomes,
        reply:artifacts.length
          ?"部分餐饮发票已归档；后续发票写入失败，系统保留了已完成结果，没有重复调用 AI。"
          :"发票内容已理解，但本次归档失败；你不需要重新发送说明。",
        artifacts
      };
    }
  }
  const allExisting=outcomes.every(item=>item.status==="existing");
  return {
    status:allExisting?"existing":"committed",
    items:outcomes,
    reply:allExisting
      ?`这些餐饮发票已经归档过，没有重复写入。\n位置：${artifacts.join("、")}`
      :`餐饮发票已归档。\n位置：${artifacts.join("、")}`,
    artifacts
  };
}

function bindingMap(sourceBindings) {
  if (!Array.isArray(sourceBindings)||sourceBindings.length>8) {
    throw new Error("tool_call_invalid");
  }
  const result=new Map();
  for (const binding of sourceBindings) {
    if (!binding||typeof binding.absolutePath!=="string") {
      throw new Error("tool_call_invalid");
    }
    const handle=createSourceHandle(binding.handle??binding);
    if (result.has(handle.sourceId)) throw new Error("tool_call_invalid");
    result.set(handle.sourceId,{...binding,handle});
  }
  return result;
}

function safeRelative(value) {
  return typeof value==="string"&&value.length>0&&!value.startsWith("/")&&
    !value.startsWith("~")&&!value.includes("\\")&&
    value.split("/").every(segment=>segment&&segment!=="."&&segment!=="..");
}
