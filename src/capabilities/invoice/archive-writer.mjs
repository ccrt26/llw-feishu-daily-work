import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {constants as fsConstants} from "node:fs";
import {copyFile,lstat,mkdir,readdir,realpath} from "node:fs/promises";
import {join,relative,resolve,sep} from "node:path";

const ARCHIVE_PARTS=["亚信工作","日常发票","餐饮发票"];
const ARCHIVE_EXTENSIONS=new Set(["jpg","jpeg","png","webp","pdf"]);

export class InvoiceArchiveWriter {
  constructor({vaultRoot,state,hashFileFn=sha256File,copyFileFn=copyFile}) {
    this.vaultRoot=vaultRoot;
    this.state=state;
    this.hashFile=hashFileFn;
    this.copyFile=copyFileFn;
  }

  async archive({transactionId,source,invoice,extension}) {
    validateInput(transactionId,invoice,extension);
    const {vault,archiveRoot}=await this.validateVault();
    await requireRegularFile(source,"unsafe_source");
    const sourceHash=await this.hashFile(source);
    if (!/^[a-f0-9]{64}$/.test(sourceHash)) throw new Error("invalid_source_hash");
    const monthName=`${invoice.issue_date.slice(0,4)}年${invoice.issue_date.slice(5,7)}月`;
    const month=join(archiveRoot,monthName);
    await mkdir(month,{recursive:true,mode:0o700});
    const monthInfo=await lstat(month);
    const actualMonth=await realpath(month);
    if (!monthInfo.isDirectory() || monthInfo.isSymbolicLink() || actualMonth !== join(archiveRoot,monthName)) throw new Error("vault_unavailable");
    for (let attempt=1;attempt<=3;attempt++) {
      const selected=await this.selectTarget(month,invoice.total_with_tax,extension,sourceHash);
      if (selected.status !== "selected") return selected;
      const target=join(month,selected.fileName);
      const relativePath=relative(vault,target).split(sep).join("/");
      const id=attempt === 1 ? transactionId : `${transactionId}:${attempt}`;
      await this.state.prepareInvoiceTransaction(id,{targetRelativePath:relativePath,sourceHash});
      try {
        await this.copyFile(source,target,fsConstants.COPYFILE_EXCL);
      } catch (error) {
        if (error?.code === "EEXIST") {
          await this.state.updateInvoiceTransaction(id,"aborted");
          continue;
        }
        const finalState=await targetState(target,this.hashFile,sourceHash);
        if (finalState === "missing") await this.state.updateInvoiceTransaction(id,"aborted");
        else if (finalState === "same") {
          await this.state.updateInvoiceTransaction(id,"published");
          return {status:"existing",relativePath};
        } else await this.state.updateInvoiceTransaction(id,"needs_inspection");
        throw new Error(finalState === "different" ? "copy_verification_failed" : "archive_copy_failed");
      }
      const finalHash=await this.hashFile(target);
      if (finalHash !== sourceHash) {
        await this.state.updateInvoiceTransaction(id,"needs_inspection");
        throw new Error("copy_verification_failed");
      }
      await this.state.updateInvoiceTransaction(id,"published");
      return {status:"committed",relativePath};
    }
    throw new Error("archive_race_exhausted");
  }

  async recoverTransactions() {
    const {vault}=await this.validateVault();
    for (const transaction of this.state.listInvoiceTransactions().filter(item => item.status === "prepared")) {
      const target=resolve(vault,transaction.targetRelativePath);
      if (target !== vault && !target.startsWith(`${vault}${sep}`)) {
        await this.state.updateInvoiceTransaction(transaction.transactionId,"needs_inspection");
        continue;
      }
      const state=await targetState(target,this.hashFile,transaction.sourceHash);
      await this.state.updateInvoiceTransaction(transaction.transactionId,state === "missing" ? "aborted" : state === "same" ? "published" : "needs_inspection");
    }
  }

  async selectTarget(month,amount,extension,sourceHash) {
    const occupied=new Set();
    for (const entry of await readdir(month,{withFileTypes:true})) {
      const candidate=parseAmountCandidate(entry.name,amount);
      if (!candidate) continue;
      const state=await targetState(join(month,entry.name),this.hashFile,sourceHash);
      if (state === "same") return {status:"existing",relativePath:this.relativeArchivePath(month,entry.name)};
      occupied.add(candidate.sequence);
    }
    let sequence=1;
    while (occupied.has(sequence)) sequence++;
    const fileName=sequence === 1 ? `${amount}.${extension}` : `${amount}-${sequence}.${extension}`;
    return {status:"selected",fileName};
  }

  relativeArchivePath(month,fileName) {
    return relative(resolve(this.vaultRoot),join(month,fileName)).split(sep).join("/");
  }

  async validateVault() {
    let vault,archiveRoot;
    try {
      vault=await realpath(this.vaultRoot);
      const obsidian=await lstat(join(vault,".obsidian"));
      const map=await lstat(join(vault,".llw-system","SYSTEM_MAP.md"));
      const configuredArchive=join(vault,...ARCHIVE_PARTS);
      const archiveInfo=await lstat(configuredArchive);
      archiveRoot=await realpath(configuredArchive);
      if (!obsidian.isDirectory() || obsidian.isSymbolicLink() || !map.isFile() || map.isSymbolicLink() || !archiveInfo.isDirectory() || archiveInfo.isSymbolicLink() || archiveRoot !== configuredArchive) throw new Error("unsafe");
    } catch {
      throw new Error("vault_unavailable");
    }
    return {vault,archiveRoot};
  }
}

export function sha256File(file) {
  return new Promise((resolveHash,reject) => {
    const hash=createHash("sha256");
    const stream=createReadStream(file);
    stream.on("error",reject);
    stream.on("data",chunk => hash.update(chunk));
    stream.on("end",() => resolveHash(hash.digest("hex")));
  });
}

async function targetState(target,hashFile,sourceHash) {
  try {
    await requireRegularFile(target,"unsafe_archive_target");
    return await hashFile(target) === sourceHash ? "same" : "different";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

async function requireRegularFile(file,code) {
  const info=await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(code);
}

function validateInput(transactionId,invoice,extension) {
  const validDate=/^(\d{4})-(\d{2})-(\d{2})$/.exec(invoice?.issue_date || "");
  const date=validDate && new Date(Date.UTC(Number(validDate[1]),Number(validDate[2])-1,Number(validDate[3])));
  const calendarOk=date && date.getUTCFullYear()===Number(validDate[1]) && date.getUTCMonth()===Number(validDate[2])-1 && date.getUTCDate()===Number(validDate[3]);
  if (typeof transactionId !== "string" || !transactionId || !calendarOk || !/^(0|[1-9][0-9]*)\.[0-9]{2}$/.test(invoice?.total_with_tax || "") || !ARCHIVE_EXTENSIONS.has(extension)) throw new Error("invalid_archive_input");
}

function parseAmountCandidate(fileName,amount) {
  for (const extension of ARCHIVE_EXTENSIONS) {
    const suffix=`.${extension}`;
    if (!fileName.endsWith(suffix)) continue;
    const stem=fileName.slice(0,-suffix.length);
    if (stem === amount) return {sequence:1};
    const prefix=`${amount}-`;
    if (!stem.startsWith(prefix)) continue;
    const rawSequence=stem.slice(prefix.length);
    if (!/^[2-9][0-9]*$/.test(rawSequence)) continue;
    const sequence=Number(rawSequence);
    if (Number.isSafeInteger(sequence)) return {sequence};
  }
  return null;
}
