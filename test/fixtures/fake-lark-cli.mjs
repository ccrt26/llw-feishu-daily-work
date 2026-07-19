#!/usr/bin/env node
import { writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
if (process.env.FAKE_LARK_ARGS) await writeFile(process.env.FAKE_LARK_ARGS, JSON.stringify(args));
if (args.includes("consume")) {
  process.stderr.write("[event] ready event_key=im.message.receive_v1\n");
  for (const event of JSON.parse(process.env.FAKE_EVENTS || "[]")) process.stdout.write(`${JSON.stringify(event)}\n`);
  setTimeout(() => process.exit(0), 20);
} else if (args.includes("+messages-send")) {
  process.stdout.write('{"ok":true}\n');
} else {
  process.exit(2);
}
