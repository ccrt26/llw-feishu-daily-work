const FEISHU_COMMANDS=new Map([
  ["/llw-model status","status"],
  ["/llw-model codex","codex"],
  ["/llw-model deepseek","deepseek"]
]);
const LOCAL_COMMANDS=new Set(["status","codex","deepseek"]);

export function parseModelCommand(content) { return typeof content==="string"?FEISHU_COMMANDS.get(content)||null:null; }

export function parseLocalModelCommand(argumentsList) {
  if (!Array.isArray(argumentsList) || argumentsList.length!==1 || typeof argumentsList[0]!=="string") return null;
  return LOCAL_COMMANDS.has(argumentsList[0])?argumentsList[0]:null;
}

export async function handleModelCommand(content,{modelMode,deepseekEnabled}) {
  const command=parseModelCommand(content);
  if (!command) return null;
  if (command==="deepseek"&&!deepseekEnabled) return draft("rejected","DeepSeek 模型当前未启用。");
  if (command==="status") return draft("existing",statusReply(await modelMode.read()));
  await modelMode.write(command);
  return draft("existing",command==="codex"
    ?"模型已切换为 Codex。\n生效范围：下一条新任务。\n当前处理中任务不受影响。"
    :"模型已切换为 DeepSeek。\n生效范围：下一条新任务。\n当前处理中任务不受影响。\n注意：发票图片/PDF视觉判断暂不支持 DeepSeek。");
}

function draft(status,reply) { return {status,reply,artifacts:[]}; }
function statusReply(mode) {
  return mode==="deepseek"
    ?"当前模型：DeepSeek\n切换方式：手工\n发票视觉任务：不可用"
    :"当前模型：Codex\n切换方式：手工";
}
