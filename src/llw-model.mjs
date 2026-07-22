import {loadConfig} from "./config.mjs";
import {handleModelCommand,parseLocalModelCommand} from "./core/model-command.mjs";
import {ModelMode} from "./core/model-mode.mjs";
import {pathToFileURL} from "node:url";

const configFile="/Users/ccrt/Library/Application Support/LLW Assistant/state/feishu-daily-work/config.json";
export async function runModelCli({argumentsList=process.argv.slice(2),load=loadConfig,createMode=file=>new ModelMode(file),stdout=process.stdout,stderr=process.stderr}={}) {
  const command=parseLocalModelCommand(argumentsList);
  if (!command) { stderr.write("usage: llw-model <status|codex|deepseek>\n"); return 2; }
  try {
    const config=await load(configFile);
    const result=await handleModelCommand(`/llw-model ${command}`,{modelMode:createMode(config.modelStateFile),deepseekEnabled:config.deepseekEnabled});
    if (result.status==="rejected") { stderr.write(`${result.reply}\n`); return 1; }
    stdout.write(`${result.reply}\n`);
    return 0;
  } catch { stderr.write("llw-model failed\n"); return 1; }
}

if (process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) process.exitCode=await runModelCli();
