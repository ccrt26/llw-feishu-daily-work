import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

const PATH_FIELDS = ["vaultRoot", "skillRoot", "stateFile", "heartbeatFile", "cliPath", "codexPath"];

export async function loadConfig(file, {requireBinding = true} = {}) {
  const config = JSON.parse(await readFile(file, "utf8"));
  validateConfig(config, requireBinding);
  return config;
}

export async function saveConfig(file, config, {requireBinding = true} = {}) {
  validateConfig(config, requireBinding);
  await mkdir(dirname(file), {recursive: true, mode: 0o700});
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}

export function bindingFromEvent(event) {
  if (event?.chat_type !== "p2p" || event?.message_type !== "text" || event?.content !== "LLW-BIND-DAILY-WORK") return null;
  if (typeof event.sender_id !== "string" || !event.sender_id || typeof event.chat_id !== "string" || !event.chat_id) return null;
  return {senderId: event.sender_id, chatId: event.chat_id};
}

function validateConfig(config, requireBinding) {
  if (!config || typeof config !== "object") throw new Error("invalid_config");
  for (const field of PATH_FIELDS) {
    if (typeof config[field] !== "string" || !isAbsolute(config[field])) throw new Error(`invalid_config_path:${field}`);
  }
  if (typeof config.profile !== "string" || !config.profile) throw new Error("invalid_profile");
  for (const field of ["senderId", "chatId"]) {
    if (config[field] !== null && (typeof config[field] !== "string" || !config[field])) throw new Error(`invalid_binding:${field}`);
  }
  if (requireBinding && (!config.senderId || !config.chatId)) throw new Error("binding_missing");
}
