#!/usr/bin/env node
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import {join} from "node:path";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
const schemaIndex = args.indexOf("--output-schema");
if (process.env.FAKE_SCHEMA_FILE_COPY) {
  if (schemaIndex<0) throw new Error("missing --output-schema");
  const schemaPath=args[schemaIndex+1];
  const info=await stat(schemaPath);
  await writeFile(
    process.env.FAKE_SCHEMA_FILE_COPY,
    JSON.stringify({
      path:schemaPath,
      mode:info.mode&0o777,
      content:JSON.parse(await readFile(schemaPath,"utf8"))
    })
  );
}
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
