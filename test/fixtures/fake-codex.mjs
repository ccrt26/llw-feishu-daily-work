#!/usr/bin/env node
import { readFile, readdir, writeFile } from "node:fs/promises";
import {join} from "node:path";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
if (process.env.FAKE_CODEX_ATTEMPTS) {
  let attempts = 0;
  try { attempts = Number(await readFile(process.env.FAKE_CODEX_ATTEMPTS,"utf8")); } catch {}
  await writeFile(process.env.FAKE_CODEX_ATTEMPTS,String(attempts+1));
}
if (process.env.FAKE_CODEX_MODE === "transient") {
  const attempts=Number(await readFile(process.env.FAKE_CODEX_ATTEMPTS,"utf8"));
  if (attempts === 1) process.exit(9);
}
if (process.env.FAKE_CODEX_MODE === "process-failure") {
  process.stderr.write("synthetic private stderr /Users/owner/secret");
  process.exit(9);
}
if (process.env.FAKE_CODEX_MODE === "timeout") {
  await new Promise(resolve=>setTimeout(resolve,10_000));
}
if (process.env.FAKE_ARGS_FILE) await writeFile(process.env.FAKE_ARGS_FILE, JSON.stringify(args));
if (process.env.FAKE_CWD_ONLY_FILE) {
  await writeFile(process.env.FAKE_CWD_ONLY_FILE,process.cwd());
}
if (process.env.FAKE_CWD_FILE) {
  const skills=await readdir(join(process.cwd(),".agents","skills"));
  await writeFile(process.env.FAKE_CWD_FILE,JSON.stringify({cwd:process.cwd(),skills}));
}
let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;
if (process.env.FAKE_STDIN_FILE) await writeFile(process.env.FAKE_STDIN_FILE, stdin);
if (process.env.FAKE_CODEX_MODE === "artifact") process.exit(0);
if (process.env.FAKE_CODEX_MODE === "no-output") process.exit(0);
if (process.env.FAKE_CODEX_MODE === "raw") {
  await writeFile(args[outputIndex + 1],process.env.FAKE_RESPONSE);
} else {
  const response = JSON.parse(process.env.FAKE_RESPONSE);
  await writeFile(args[outputIndex + 1], JSON.stringify(response));
}
