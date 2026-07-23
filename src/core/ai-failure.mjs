const SENSITIVE_INPUT_REPLY="检测到可能包含实际密钥、登录凭证或支付控制信息。\n系统没有把本次内容发送给 Codex 或 DeepSeek，也没有写入业务记录。\n请删除或遮盖相关值后重新提交。";
const MODEL_FAILURE_REPLIES={
  codex:"当前模型 Codex 本次调用失败。\n系统没有切换模型，也没有执行写入。\n如需使用 DeepSeek，请手工发送：/llw-model deepseek",
  deepseek:"当前模型 DeepSeek 本次调用失败。\n系统没有切换模型，也没有执行写入。\n如需使用 Codex，请手工发送：/llw-model codex"
};

export function classifyAiFailure(error,model) {
  if (error?.message==="ai_input_rejected") return {status:"rejected",...(["credential","payment"].includes(error.reasonCode)?{reasonCode:error.reasonCode}:{}),reply:SENSITIVE_INPUT_REPLY};
  return {status:"failed",reply:MODEL_FAILURE_REPLIES[model]||MODEL_FAILURE_REPLIES.codex};
}
