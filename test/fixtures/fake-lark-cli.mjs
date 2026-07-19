#!/usr/bin/env node
import { readFile, writeFile, symlink } from "node:fs/promises";

const args = process.argv.slice(2);
if (process.env.FAKE_LARK_ARGS) await writeFile(process.env.FAKE_LARK_ARGS, JSON.stringify(args));
if (args.includes("consume")) {
  process.stderr.write("[event] ready event_key=im.message.receive_v1\n");
  for (const event of JSON.parse(process.env.FAKE_EVENTS || "[]")) process.stdout.write(`${JSON.stringify(event)}\n`);
  setTimeout(() => process.exit(0), 20);
} else if (args.includes("+messages-send") || args.includes("+messages-reply")) {
  process.stdout.write('{"ok":true}\n');
} else if (args.includes("+messages-resources-download")) {
  const mode = process.env.FAKE_LARK_DOWNLOAD_MODE || "one";
  if (process.env.FAKE_LARK_ENV) {
    await writeFile(process.env.FAKE_LARK_ENV, JSON.stringify({
      noProxy: process.env.LARK_CLI_NO_PROXY ?? null,
      noUpdateNotifier: process.env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER ?? null,
      noSkillsNotifier: process.env.LARKSUITE_CLI_NO_SKILLS_NOTIFIER ?? null,
      path: process.env.PATH ?? null,
    }));
  }
  if (mode === "transient") {
    const attemptsFile = process.env.FAKE_LARK_ATTEMPTS;
    let attempts = 0;
    try { attempts = Number(await readFile(attemptsFile, "utf8")); } catch {}
    attempts += 1;
    await writeFile(attemptsFile, String(attempts));
    if (attempts === 1) {
      await writeFile("partial.tmp", "incomplete");
      process.exit(7);
    }
    await writeFile("attachment.pdf", Buffer.from("%PDF-1.7\n"));
  }
  if (mode === "exit") process.exit(7);
  if (mode === "hang") setTimeout(() => process.exit(0), 60_000);
  else if (mode === "one") await writeFile("attachment.png", Buffer.from([0x89,0x50,0x4e,0x47]));
  else if (mode === "two") {
    await writeFile("attachment.png", Buffer.from([1]));
    await writeFile("extra.png", Buffer.from([2]));
  } else if (mode === "symlink") await symlink("/etc/hosts", "attachment.png");
} else {
  process.exit(2);
}
