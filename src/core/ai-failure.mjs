const SENSITIVE_INPUT_REPLY="检测到本任务包含不允许发送给 AI 的身份凭证或密钥信息。\n系统未调用 Codex 或 DeepSeek，也未保存该敏感内容。\n请删除或遮盖敏感字段后重新提交。";
const MODEL_FAILURE_REPLIES={
  codex:"当前模型 Codex 本次调用失败。\n系统没有切换模型，也没有执行写入。\n如需使用 DeepSeek，请手工发送：/llw-model deepseek",
  deepseek:"当前模型 DeepSeek 本次调用失败。\n系统没有切换模型，也没有执行写入。\n如需使用 Codex，请手工发送：/llw-model codex"
};

export function classifyAiFailure(error,model) {
  if (error?.message==="ai_input_rejected") return {status:"rejected",reply:SENSITIVE_INPUT_REPLY};
  return {status:"failed",reply:MODEL_FAILURE_REPLIES[model]||MODEL_FAILURE_REPLIES.codex};
}
