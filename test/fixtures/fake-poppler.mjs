#!/usr/bin/env node
import {mkdir,symlink,writeFile} from "node:fs/promises";
import {dirname} from "node:path";

const args=process.argv.slice(2);
const mode=process.env.FAKE_POPPLER_MODE || "ok";
const sleep=() => new Promise(resolve => setTimeout(resolve,10_000));

if (args.includes("-layout")) await textTool();
else if (args.includes("-png")) await renderTool();
else await infoTool();

async function infoTool() {
  if (mode === "sleep_info") await sleep();
  if (mode === "info_fail") process.exit(7);
  if (mode === "big_info") { process.stdout.write("x".repeat(70 * 1024)); return; }
  if (mode === "missing_pages") { process.stdout.write("Encrypted: no\n"); return; }
  if (mode === "duplicate_pages") { process.stdout.write("Pages: 1\nPages: 1\nEncrypted: no\n"); return; }
  const pages=mode === "page0" ? 0 : mode === "page11" ? 11 : Number(process.env.FAKE_PAGES || 2);
  process.stdout.write(`Pages: ${pages}\nEncrypted: ${mode === "encrypted" ? "yes (print:yes copy:no)" : "no"}\n`);
}

async function textTool() {
  if (mode === "sleep_text") await sleep();
  if (mode === "text_fail") process.exit(8);
  const target=args.at(-1);
  if (mode === "text_missing") return;
  if (mode === "text_directory") { await mkdir(target); return; }
  if (mode === "text_link") {
    const outside=`${target}.outside`;
    await writeFile(outside,"secret");
    await symlink(outside,target);
    return;
  }
  if (mode === "text_nonutf8") { await writeFile(target,Buffer.from([0xff,0xfe,0xfd])); return; }
  if (mode === "text_oversize") { await writeFile(target,Buffer.alloc(1025,0x61)); return; }
  await writeFile(target,process.env.FAKE_TEXT ?? "invoice text","utf8");
}

async function renderTool() {
  if (mode === "sleep_render") await sleep();
  if (mode === "render_fail") process.exit(9);
  const prefix=args.at(-1);
  const lastPage=Number(args[args.indexOf("-l")+1]);
  const count=mode === "extra_page" ? lastPage+1 : lastPage;
  const png=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.from("safe")]);
  for (let page=1;page<=count;page++) {
    if (mode === "missing_page" && page === lastPage) continue;
    const target=`${prefix}-${page}.png`;
    if (mode === "render_directory" && page === 1) { await mkdir(target); continue; }
    if (mode === "render_link" && page === 1) {
      const outside=`${target}.outside`;
      await writeFile(outside,png);
      await symlink(outside,target);
      continue;
    }
    if (mode === "empty_png" && page === 1) { await writeFile(target,Buffer.alloc(0)); continue; }
    if (mode === "bad_png" && page === 1) { await writeFile(target,"not-png"); continue; }
    if (mode === "render_oversize" && page === 1) { await writeFile(target,Buffer.concat([png,Buffer.alloc(1024)])); continue; }
    await writeFile(target,png);
  }
  if (mode === "unexpected_directory") await mkdir(`${dirname(prefix)}/unexpected`);
}
