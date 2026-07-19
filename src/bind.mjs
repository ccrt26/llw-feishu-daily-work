import { loadConfig, saveConfig, bindingFromEvent } from "./config.mjs";
import { startLarkListener } from "./lark-runtime.mjs";

process.umask(0o077);

const configFile = process.argv[2] || "/Users/ccrt/Library/Application Support/LLW Assistant/state/feishu-daily-work/config.json";
const config = await loadConfig(configFile, {requireBinding: false});
if (config.senderId && config.chatId) {
  process.stdout.write("bind_ok=true\nchat_type_ok=true\n");
  process.exit(0);
}

let resolveBinding;
let rejectBinding;
const found = new Promise((resolve, reject) => { resolveBinding = resolve; rejectBinding = reject; });
const listener = await startLarkListener({
  cliPath: config.cliPath,
  profile: config.profile,
  onEvent: event => {
    const binding = bindingFromEvent(event);
    if (binding) resolveBinding(binding);
  },
  onError: () => rejectBinding(new Error("binding_listener_error"))
});
const timeout = setTimeout(() => rejectBinding(new Error("binding_timeout")), 15 * 60 * 1000);
try {
  const binding = await found;
  await listener.stop();
  await saveConfig(configFile, {...config, ...binding});
  process.stdout.write("bind_ok=true\nchat_type_ok=true\n");
} finally {
  clearTimeout(timeout);
}
