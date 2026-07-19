import { writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { loadConfig } from "./config.mjs";
import { StateStore } from "./state-store.mjs";
import { VaultWriter } from "./vault-writer.mjs";
import { invokeCodex } from "./codex-client.mjs";
import { DailyWorkService } from "./service.mjs";
import { sendLarkText, startLarkListener } from "./lark-runtime.mjs";

process.umask(0o077);

const configFile = process.argv[2] || "/Users/ccrt/Library/Application Support/LLW Assistant/state/feishu-daily-work/config.json";
const config = await loadConfig(configFile);
const state = await StateStore.open(config.stateFile);
const writer = new VaultWriter(config.vaultRoot);
const classify = input => invokeCodex({
  codexPath: config.codexPath,
  workspaceRoot: config.vaultRoot,
  skillRoot: config.skillRoot,
  ...input
});
const send = message => sendLarkText({cliPath: config.cliPath, profile: config.profile, ...message});
const service = new DailyWorkService({binding: {senderId: config.senderId, chatId: config.chatId}, state, classify, writer, send});

await service.resumeReplies();
await heartbeat(config.heartbeatFile);
const heartbeatTimer = setInterval(() => heartbeat(config.heartbeatFile).catch(() => {}), 30000);
const listener = await startLarkListener({
  cliPath: config.cliPath,
  profile: config.profile,
  onEvent: event => service.handleEvent(event),
  onError: error => process.stderr.write(`event_handler_error=${safeCode(error.message)}\n`)
});

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(heartbeatTimer);
  try { await listener.stop(); } finally { process.exit(0); }
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

try {
  await listener.done;
  if (!stopping) throw new Error("listener_exited");
} finally {
  clearInterval(heartbeatTimer);
}

async function heartbeat(file) {
  await mkdir(dirname(file), {recursive: true, mode: 0o700});
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify({updatedAt: new Date().toISOString()})}\n`, {mode: 0o600});
  await rename(temporary, file);
}

function safeCode(message) {
  return String(message || "unknown").replace(/[^a-zA-Z0-9:_-]/g, "_").slice(0, 120);
}
