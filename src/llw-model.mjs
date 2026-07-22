import {loadConfig} from "./config.mjs";
import {handleModelCommand,parseLocalModelCommand} from "./core/model-command.mjs";
import {ModelMode} from "./core/model-mode.mjs";

const configFile="/Users/ccrt/Library/Application Support/LLW Assistant/state/feishu-daily-work/config.json";
const command=parseLocalModelCommand(process.argv.slice(2));
if (!command) {
  process.stderr.write("usage: llw-model <status|codex|deepseek>\n");
  process.exitCode=2;
} else {
  const config=await loadConfig(configFile);
  const result=await handleModelCommand(`/llw-model ${command}`,{modelMode:new ModelMode(config.modelStateFile),deepseekEnabled:config.deepseekEnabled});
  process.stdout.write(`${result.reply}\n`);
}
