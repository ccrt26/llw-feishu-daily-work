import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, open, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {inspectInvoiceFile} from "../src/capabilities/invoice/file-inspector.mjs";

const signatures = {
  jpeg:Buffer.from([0xff,0xd8,0xff,0x01]),
  png:Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00]),
  webp:Buffer.from("RIFF0000WEBPxxxx"),
  pdf:Buffer.from("%PDF-1.7"),
  zip:Buffer.from([0x50,0x4b,0x03,0x04,0x00])
};

async function fixture(name,content) {
  const dir = await mkdtemp(join(tmpdir(),"llw-inspect-"));
  const file = join(dir,name);
  await writeFile(file,content);
  return {dir,file};
}

test("accepts supported image headers only with matching extensions", async () => {
  for (const [name,header,format,extension] of [["票.JPG",signatures.jpeg,"jpeg","jpg"],["票.jpeg",signatures.jpeg,"jpeg","jpeg"],["票.png",signatures.png,"png","png"],["票.webp",signatures.webp,"webp","webp"]]) {
    const f = await fixture(name,header);
    try { assert.deepEqual(await inspectInvoiceFile(f.file),{kind:"supported_image",format,extension,sizeBytes:header.length}); }
    finally { await rm(f.dir,{recursive:true,force:true}); }
  }
});

test("classifies PDF and OFD without sending them to image analysis", async () => {
  for (const [name,header,kind,format,extension] of [["票.pdf",signatures.pdf,"pdf","pdf","pdf"],["票.ofd",signatures.zip,"ofd","ofd","ofd"]]) {
    const f = await fixture(name,header);
    try { assert.deepEqual(await inspectInvoiceFile(f.file),{kind,format,extension,sizeBytes:header.length}); }
    finally { await rm(f.dir,{recursive:true,force:true}); }
  }
});

test("rejects mismatches, missing suffixes, ZIPs and executable double suffixes", async () => {
  for (const [name,header] of [["票.jpg",signatures.png],["票",signatures.jpeg],["票.zip",signatures.zip],["invoice.exe.jpg",signatures.jpeg],["invoice.sh.png",signatures.png],["票.jp1g",signatures.jpeg]]) {
    const f = await fixture(name,header);
    try { assert.equal((await inspectInvoiceFile(f.file)).kind,"unsupported"); }
    finally { await rm(f.dir,{recursive:true,force:true}); }
  }
});

test("rejects empty, oversized and symbolic-link inputs", async () => {
  const empty = await fixture("票.jpg",Buffer.alloc(0));
  try { assert.equal((await inspectInvoiceFile(empty.file)).kind,"unsupported"); }
  finally { await rm(empty.dir,{recursive:true,force:true}); }

  const large = await fixture("票.jpg",signatures.jpeg);
  const handle = await open(large.file,"r+");
  await handle.truncate(20 * 1024 * 1024 + 1); await handle.close();
  try { assert.equal((await inspectInvoiceFile(large.file)).kind,"unsupported"); }
  finally { await rm(large.dir,{recursive:true,force:true}); }

  const linked = await fixture("real.jpg",signatures.jpeg);
  const {symlink} = await import("node:fs/promises");
  await symlink(linked.file,join(linked.dir,"link.jpg"));
  try { assert.equal((await inspectInvoiceFile(join(linked.dir,"link.jpg"))).kind,"unsupported"); }
  finally { await rm(linked.dir,{recursive:true,force:true}); }
});
