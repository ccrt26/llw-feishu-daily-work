import {lstat,readFile} from "node:fs/promises";
import {isAbsolute,join} from "node:path";
import {saveConfig} from "./config.mjs";

const V4_FIELDS=new Set([
  "version","vaultRoot","stateFile","heartbeatFile","modelStateFile",
  "deepseekEnabled","deepseekModel","deepseekKeychainService","deepseekKeychainAccount",
  "wechatEnabled","wechatStateFile","wechatKeychainService","wechatKeychainAccount",
  "cliPath","codexPath","profile","senderId","chatId","capabilities"
]);
const CAPABILITY_FIELDS=new Set(["daily-work","invoice"]);
const DAILY_FIELDS=new Set(["enabled","skillRoot"]);
const INVOICE_FIELDS=new Set([
  "enabled","skillRoot","tempRoot","archiveRoot","maxFileBytes","aiTimeoutMs",
  "pdfProcessorPath","maxPdfPages","maxPdfTextBytes","maxPdfRenderBytes","pdfPrepareTimeoutMs"
]);

try {
  const [
    file,root,manifestPath,expectedManifestSha256,
    knowledgeConfigFile,assistantConfigFile
  ]=process.argv.slice(2);
  if (!file||!isAbsolute(root)||!isAbsolute(manifestPath)||
      manifestPath!==join(root,"manifest.json")||
      !/^[0-9a-f]{64}$/.test(expectedManifestSha256||"")||
      !isAbsolute(knowledgeConfigFile||"")||
      !isAbsolute(assistantConfigFile||"")) {
    throw new Error("migration_input_invalid");
  }
  const metadata=await lstat(file);
  if (!metadata.isFile()||metadata.isSymbolicLink()||metadata.uid!==process.getuid()||(metadata.mode&0o077)!==0) {
    throw new Error("unsafe_config_file");
  }
  const current=JSON.parse(await readFile(file,"utf8"));
  exact(current,V4_FIELDS);
  if (current.version!==4) throw new Error("invalid_source_version");
  exact(current.capabilities,CAPABILITY_FIELDS);
  exact(current.capabilities["daily-work"],DAILY_FIELDS);
  exact(current.capabilities.invoice,INVOICE_FIELDS);
  const knowledgeMetadata=await lstat(knowledgeConfigFile);
  if (!knowledgeMetadata.isFile()||knowledgeMetadata.isSymbolicLink()||
      knowledgeMetadata.uid!==process.getuid()||(knowledgeMetadata.mode&0o077)!==0) {
    throw new Error("unsafe_knowledge_config");
  }
  const knowledge=JSON.parse(await readFile(knowledgeConfigFile,"utf8"));
  const assistantMetadata=await lstat(assistantConfigFile);
  if (!assistantMetadata.isFile()||assistantMetadata.isSymbolicLink()||
      assistantMetadata.uid!==process.getuid()||
      (assistantMetadata.mode&0o077)!==0) {
    throw new Error("unsafe_assistant_config");
  }
  const assistant=JSON.parse(await readFile(assistantConfigFile,"utf8"));
  await saveConfig(file,{
    ...current,
    version:5,
    capabilities:{
      ...current.capabilities,
      "knowledge-ingest":{enabled:false,...knowledge},
      "assistant-work":{enabled:false,...assistant}
    },
    privateSkills:{root,manifestPath,expectedManifestSha256}
  });
} catch {
  process.exitCode=1;
}

function exact(value,fields) {
  if (!value||typeof value!=="object"||Array.isArray(value)) throw new Error("invalid_config_shape");
  const keys=Object.keys(value);
  if (keys.length!==fields.size||keys.some(key=>!fields.has(key))) throw new Error("invalid_config_shape");
}
