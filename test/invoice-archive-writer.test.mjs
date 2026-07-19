import test from "node:test";
import assert from "node:assert/strict";
import {copyFile,mkdtemp,mkdir,readFile,rm,symlink,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {StateStore} from "../src/state-store.mjs";
import {InvoiceArchiveWriter,sha256File} from "../src/capabilities/invoice/archive-writer.mjs";

const invoice={invoice_number:"INV123",issue_date:"2026-07-18",total_with_tax:"290.00"};

async function harness(options={}) {
  const root=await mkdtemp(join(tmpdir(),"llw-archive-"));
  const vault=join(root,"vault");
  await mkdir(join(vault,".obsidian"),{recursive:true});
  await mkdir(join(vault,".llw-system"),{recursive:true});
  await writeFile(join(vault,".llw-system","SYSTEM_MAP.md"),"map");
  await mkdir(join(vault,"亚信工作","日常发票","餐饮发票"),{recursive:true});
  const source=join(root,"source.png"); await writeFile(source,Buffer.from("invoice-A"));
  const state=await StateStore.open(join(root,"state","state.json"));
  const writer=new InvoiceArchiveWriter({vaultRoot:vault,state,...options});
  return {root,vault,source,state,writer,month:join(vault,"亚信工作","日常发票","餐饮发票","2026年07月")};
}

test("commits a new primary target and verifies its bytes",async () => {
  const h=await harness();
  try {
    const result=await h.writer.archive({transactionId:"m1",source:h.source,invoice,extension:"png"});
    assert.deepEqual(result,{status:"committed",relativePath:"亚信工作/日常发票/餐饮发票/2026年07月/290.00.png"});
    assert.deepEqual(await readFile(join(h.month,"290.00.png")),Buffer.from("invoice-A"));
    assert.equal(h.state.listInvoiceTransactions().at(-1).status,"published");
  } finally { await rm(h.root,{recursive:true,force:true}); }
});

test("uses SHA-256 idempotency and exactly one fallback name",async () => {
  const h=await harness();
  try {
    await mkdir(h.month,{recursive:true});
    await writeFile(join(h.month,"290.00.png"),Buffer.from("other-primary"));
    let result=await h.writer.archive({transactionId:"m2",source:h.source,invoice,extension:"png"});
    assert.equal(result.relativePath.endsWith("290.00_INV123.png"),true); assert.equal(result.status,"committed");
    result=await h.writer.archive({transactionId:"m3",source:h.source,invoice,extension:"png"});
    assert.equal(result.status,"existing"); assert.equal(result.relativePath.endsWith("290.00_INV123.png"),true);
    await writeFile(join(h.month,"290.00_INV123.png"),Buffer.from("other-fallback"));
    result=await h.writer.archive({transactionId:"m4",source:h.source,invoice,extension:"png"});
    assert.deepEqual(result,{status:"awaiting_clarification",reason:"conflicting_invoice_files"});
  } finally { await rm(h.root,{recursive:true,force:true}); }
});

test("same-hash primary returns existing without copying",async () => {
  const h=await harness();
  try { await mkdir(h.month,{recursive:true}); await writeFile(join(h.month,"290.00.png"),Buffer.from("invoice-A"));
    assert.equal((await h.writer.archive({transactionId:"same",source:h.source,invoice,extension:"png"})).status,"existing");
    assert.equal(h.state.listInvoiceTransactions().length,0);
  } finally { await rm(h.root,{recursive:true,force:true}); }
});

test("archives the original PDF with identical idempotency and conflict rules",async () => {
  const h=await harness();
  const pdf=join(h.root,"source.pdf");
  await writeFile(pdf,Buffer.from("%PDF-1.7\noriginal-invoice"));
  try {
    let result=await h.writer.archive({transactionId:"pdf-1",source:pdf,invoice,extension:"pdf"});
    assert.deepEqual(result,{status:"committed",relativePath:"亚信工作/日常发票/餐饮发票/2026年07月/290.00.pdf"});
    assert.equal(await sha256File(join(h.month,"290.00.pdf")),await sha256File(pdf));
    result=await h.writer.archive({transactionId:"pdf-2",source:pdf,invoice,extension:"pdf"});
    assert.equal(result.status,"existing");
    await writeFile(join(h.month,"290.00.pdf"),Buffer.from("different-primary"));
    result=await h.writer.archive({transactionId:"pdf-3",source:pdf,invoice,extension:"pdf"});
    assert.equal(result.status,"committed"); assert.equal(result.relativePath.endsWith("290.00_INV123.pdf"),true);
    await writeFile(join(h.month,"290.00_INV123.pdf"),Buffer.from("different-fallback"));
    result=await h.writer.archive({transactionId:"pdf-4",source:pdf,invoice,extension:"pdf"});
    assert.deepEqual(result,{status:"awaiting_clarification",reason:"conflicting_invoice_files"});
  } finally { await rm(h.root,{recursive:true,force:true}); }
});

test("rejects unsafe Vaults, symlink roots and path components",async () => {
  const h=await harness();
  try {
    await rm(join(h.vault,".llw-system","SYSTEM_MAP.md"));
    await assert.rejects(h.writer.archive({transactionId:"bad",source:h.source,invoice,extension:"png"}),/vault_unavailable/);
    await writeFile(join(h.vault,".llw-system","SYSTEM_MAP.md"),"map");
    await assert.rejects(h.writer.archive({transactionId:"bad2",source:h.source,invoice:{...invoice,invoice_number:"../X"},extension:"png"}),/invalid_archive_input/);
    await assert.rejects(h.writer.archive({transactionId:"bad3",source:h.source,invoice:{...invoice,issue_date:"2026-13-01"},extension:"png"}),/invalid_archive_input/);
    await rm(join(h.vault,"亚信工作","日常发票","餐饮发票"),{recursive:true,force:true});
    await symlink(h.root,join(h.vault,"亚信工作","日常发票","餐饮发票"));
    await assert.rejects(h.writer.archive({transactionId:"bad4",source:h.source,invoice,extension:"png"}),/vault_unavailable/);
  } finally { await rm(h.root,{recursive:true,force:true}); }
});

test("a final hash mismatch is never committed or deleted",async () => {
  const real=await harness();
  real.writer=new InvoiceArchiveWriter({vaultRoot:real.vault,state:real.state,hashFileFn:async file => file === real.source ? await sha256File(file) : "f".repeat(64)});
  try {
    await assert.rejects(real.writer.archive({transactionId:"mismatch",source:real.source,invoice,extension:"png"}),/copy_verification_failed/);
    assert.equal((await readFile(join(real.month,"290.00.png"))).toString(),"invoice-A");
    assert.equal(real.state.listInvoiceTransactions().at(-1).status,"needs_inspection");
  } finally { await rm(real.root,{recursive:true,force:true}); }
});

test("COPYFILE_EXCL race re-evaluates collisions and never overwrites",async () => {
  const h=await harness(); let first=true;
  h.writer=new InvoiceArchiveWriter({vaultRoot:h.vault,state:h.state,copyFileFn:async (source,target,flags) => {
    if (first) { first=false; await writeFile(target,Buffer.from("racing-other")); throw Object.assign(new Error("exists"),{code:"EEXIST"}); }
    return copyFile(source,target,flags);
  }});
  try {
    const result=await h.writer.archive({transactionId:"race",source:h.source,invoice,extension:"png"});
    assert.equal(result.status,"committed"); assert.equal(result.relativePath.endsWith("290.00_INV123.png"),true);
    assert.equal((await readFile(join(h.month,"290.00.png"))).toString(),"racing-other");
    assert.equal(h.state.listInvoiceTransactions()[0].status,"aborted");
  } finally { await rm(h.root,{recursive:true,force:true}); }
});

test("recovers prepared transactions with missing, same and different targets",async () => {
  const h=await harness();
  try {
    await mkdir(h.month,{recursive:true});
    const same=join(h.month,"same.png"),different=join(h.month,"different.png");
    await writeFile(same,Buffer.from("invoice-A")); await writeFile(different,Buffer.from("other"));
    const sourceHash=await sha256File(h.source);
    for (const [id,name] of [["missing","missing.png"],["same","same.png"],["different","different.png"]]) await h.state.prepareInvoiceTransaction(id,{targetRelativePath:`亚信工作/日常发票/餐饮发票/2026年07月/${name}`,sourceHash});
    await h.writer.recoverTransactions();
    const statuses=Object.fromEntries(h.state.listInvoiceTransactions().map(tx=>[tx.transactionId,tx.status]));
    assert.deepEqual(statuses,{missing:"aborted",same:"published",different:"needs_inspection"});
  } finally { await rm(h.root,{recursive:true,force:true}); }
});
