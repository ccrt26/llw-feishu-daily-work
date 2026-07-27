import {validateToolCall} from "../tool-definitions.mjs";
import {
  validateInvoiceExtraction,deriveInvoiceRuleDecision
} from "../../capabilities/invoice/decision-validator.mjs";

export async function executeArchiveDiningInvoice({
  toolCall,analysisInput,transactionId,writer,currentInstruction=""
}) {
  const call=validateToolCall(toolCall);
  if (call.name!=="archive_dining_invoice") throw new Error("tool_call_invalid");
  if (/(?:不要|不|无需|禁止)(?:自动)?归档|只(?:看|告诉).*(?:金额|内容)/u
    .test(currentInstruction)) {
    return {status:"rejected",reply:"已按本轮要求只查看，不归档。",artifacts:[]};
  }
  const extraction=validateInvoiceExtraction(call.arguments.extraction);
  const decision=deriveInvoiceRuleDecision(extraction);
  if (decision.action!=="archive_dining") {
    return {
      status:decision.action==="needs_clarification"
        ?"awaiting_clarification":"rejected",
      reply:"这张发票未满足餐饮发票归档条件，本次未归档。",
      artifacts:[]
    };
  }
  try {
    const result=await writer.archive({
      transactionId,
      source:analysisInput.originalFile,
      invoice:decision.invoice,
      extension:analysisInput.archiveExtension
    });
    const path=result.relativePath||result.path;
    return {
      status:result.status==="existing"?"existing":"committed",
      reply:`餐饮发票已归档。\n位置：${path}`,
      artifacts:[path]
    };
  } catch {
    return {
      status:"failed",
      reply:"发票内容已理解，但本次归档失败；你不需要重新发送说明。",
      artifacts:[]
    };
  }
}
