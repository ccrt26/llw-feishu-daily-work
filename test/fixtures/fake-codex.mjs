#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
if (process.env.FAKE_CODEX_MODE === "transient") {
  let attempts = 0;
  try { attempts = Number(await readFile(process.env.FAKE_CODEX_ATTEMPTS,"utf8")); } catch {}
  attempts += 1;
  await writeFile(process.env.FAKE_CODEX_ATTEMPTS,String(attempts));
  if (attempts === 1) process.exit(9);
}
if (process.env.FAKE_ARGS_FILE) await writeFile(process.env.FAKE_ARGS_FILE, JSON.stringify(args));
let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;
if (process.env.FAKE_STDIN_FILE) await writeFile(process.env.FAKE_STDIN_FILE, stdin);
const response = JSON.parse(process.env.FAKE_RESPONSE);
await writeFile(args[outputIndex + 1], JSON.stringify(response));
