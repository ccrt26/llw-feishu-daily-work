import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindingFromEvent, loadConfig, saveConfig } from "../src/config.mjs";

function config(overrides = {}) {
  return {
    vaultRoot: "/Volumes/test/LLW", skillRoot: "/Volumes/test/LLW/.agents/skills/feishu-daily-work",
    stateFile: "/Users/test/state.json", heartbeatFile: "/Users/test/heartbeat.json",
    cliPath: "/Users/test/bin/lark-cli", codexPath: "/Applications/ChatGPT.app/codex",
    profile: "llw-private", senderId: "user-1", chatId: "chat-1", ...overrides
  };
}

test("saves mode-0600 config and validates required absolute paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llw-config-"));
  const file = join(dir, "config.json");
  await saveConfig(file, config());
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await loadConfig(file), config());
  await assert.rejects(async () => saveConfig(file, config({vaultRoot: "relative"})), /invalid_config_path/);
});

test("requires binding only for service startup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llw-config-unbound-"));
  const file = join(dir, "config.json");
  await saveConfig(file, config({senderId: null, chatId: null}), {requireBinding: false});
  await assert.rejects(() => loadConfig(file), /binding_missing/);
  assert.equal((await loadConfig(file, {requireBinding: false})).senderId, null);
});

test("binds only the exact phrase from a p2p text event", () => {
  const event = {sender_id: "user-1", chat_id: "chat-1", chat_type: "p2p", message_type: "text", content: "LLW-BIND-DAILY-WORK"};
  assert.deepEqual(bindingFromEvent(event), {senderId: "user-1", chatId: "chat-1"});
  assert.equal(bindingFromEvent({...event, chat_type: "group"}), null);
  assert.equal(bindingFromEvent({...event, message_type: "image"}), null);
  assert.equal(bindingFromEvent({...event, content: "other"}), null);
});
