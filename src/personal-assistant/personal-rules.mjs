import {randomUUID} from "node:crypto";
import {
  chmod,lstat,open,readFile,realpath,rename,rm
} from "node:fs/promises";
import {dirname,isAbsolute,resolve} from "node:path";
import {assertContentSafe} from "./content-safety.mjs";

const MAX_RULES=64;
const MAX_RULE_BYTES=1000;

export class PersonalRulesStore {
  constructor(file) {
    this.file=file;
  }

  static async open(file) {
    if (typeof file!=="string"||!isAbsolute(file)) invalid();
    const resolved=resolve(file);
    await requirePrivateDirectory(dirname(resolved));
    await requireOptionalPrivateFile(resolved);
    return new PersonalRulesStore(resolved);
  }

  async load() {
    await requirePrivateDirectory(dirname(this.file));
    try {
      const metadata=await requireOptionalPrivateFile(this.file);
      if (metadata===null) return [];
      const bytes=await readFile(this.file);
      if (!bytes.length||bytes.length>64*1024) invalid();
      const value=JSON.parse(bytes.toString("utf8"));
      return validateDocument(value);
    } catch (error) {
      if (error?.message==="personal_rules_invalid") throw error;
      invalid();
    }
  }

  async confirm(rule) {
    const normalized=validatePersonalRule(rule);
    const parent=dirname(this.file);
    await requirePrivateDirectory(parent);
    const lockPath=`${this.file}.lock`;
    const stagePath=`${this.file}.stage-${randomUUID()}`;
    let lock,stage;
    try {
      lock=await open(lockPath,"wx",0o600);
      const current=await this.load();
      if (current.includes(normalized)) {
        return {status:"existing",rules:current};
      }
      if (current.length>=MAX_RULES) rejected();
      const rules=[...current,normalized];
      const content=`${JSON.stringify({version:1,rules},null,2)}\n`;
      stage=await open(stagePath,"wx",0o600);
      await stage.writeFile(content,"utf8");
      await stage.sync();
      await stage.close();
      stage=null;
      await chmod(stagePath,0o600);
      await rename(stagePath,this.file);
      await syncDirectory(parent);
      return {status:"created",rules};
    } catch (error) {
      if (error?.message==="personal_rule_rejected"||
          error?.message==="personal_rules_invalid") {
        throw error;
      }
      invalid();
    } finally {
      await stage?.close().catch(()=>{});
      await rm(stagePath,{force:true}).catch(()=>{});
      await lock?.close().catch(()=>{});
      await rm(lockPath,{force:true}).catch(()=>{});
    }
  }
}

function validateDocument(value) {
  if (!value||typeof value!=="object"||Array.isArray(value)||
      Object.keys(value).length!==2||value.version!==1||
      !Array.isArray(value.rules)||value.rules.length>MAX_RULES||
      new Set(value.rules).size!==value.rules.length) {
    invalid();
  }
  return value.rules.map(validateRuleForLoad);
}

function validateRuleForLoad(rule) {
  try {
    return validatePersonalRule(rule);
  } catch {
    invalid();
  }
}

export function validatePersonalRule(rule) {
  try {
    if (typeof rule!=="string"||rule!==rule.normalize("NFC").trim()||
        !rule||Buffer.byteLength(rule,"utf8")>MAX_RULE_BYTES||
        /[\u0000-\u001f\u007f]/u.test(rule)||
        /(?:^|[\s（(])(?:\/|~\/|\.\.\/)/u.test(rule)) {
      rejected();
    }
    assertContentSafe({
      instructionText:rule,evidence:null,conversation:null,
      limits:{maxContextBytes:8*1024}
    });
    return rule;
  } catch (error) {
    if (error?.message==="personal_rule_rejected") throw error;
    rejected();
  }
}

async function requirePrivateDirectory(path) {
  try {
    const metadata=await lstat(path);
    if (!metadata.isDirectory()||metadata.isSymbolicLink()||
        metadata.uid!==process.getuid()||(metadata.mode&0o777)!==0o700) {
      invalid();
    }
    await realpath(path);
  } catch (error) {
    if (error?.message==="personal_rules_invalid") throw error;
    invalid();
  }
}

async function requireOptionalPrivateFile(path) {
  try {
    const metadata=await lstat(path);
    if (!metadata.isFile()||metadata.isSymbolicLink()||
        metadata.uid!==process.getuid()||(metadata.mode&0o777)!==0o600) {
      invalid();
    }
    return metadata;
  } catch (error) {
    if (error?.code==="ENOENT") return null;
    if (error?.message==="personal_rules_invalid") throw error;
    invalid();
  }
}

async function syncDirectory(path) {
  const handle=await open(path,"r");
  try { await handle.sync(); }
  finally { await handle.close(); }
}

function rejected() {
  throw new Error("personal_rule_rejected");
}
function invalid() {
  throw new Error("personal_rules_invalid");
}
