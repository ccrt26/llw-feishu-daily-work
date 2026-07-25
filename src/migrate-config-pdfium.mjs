import {lstat,readFile} from "node:fs/promises";
import {isAbsolute} from "node:path";
import {saveConfig} from "./config.mjs";

const TOP_FIELDS=new Set([
  "version","vaultRoot","stateFile","heartbeatFile","modelStateFile",
  "deepseekEnabled","deepseekModel","deepseekKeychainService","deepseekKeychainAccount",
  "wechatEnabled","wechatStateFile","wechatKeychainService","wechatKeychainAccount",
  "cliPath","codexPath","profile","senderId","chatId","capabilities"
]);
const CAPABILITY_FIELDS=new Set(["daily-work","invoice"]);
const DAILY_FIELDS=new Set(["enabled","skillRoot"]);
const OLD_INVOICE_FIELDS=new Set([
  "enabled","skillRoot","tempRoot","archiveRoot","maxFileBytes","aiTimeoutMs",
  "pdfInfoPath","pdfToTextPath","pdfToPpmPath",
  "maxPdfPages","maxPdfTextBytes","maxPdfRenderBytes","pdfPrepareTimeoutMs"
]);

try {
  const file=process.argv[2],pdfProcessorPath=process.argv[3];
  if (typeof file!=="string"||!file||typeof pdfProcessorPath!=="string"||!isAbsolute(pdfProcessorPath)) throw new Error("migration_input_invalid");
  const info=await lstat(file);
  if (!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid()||(info.mode&0o077)!==0) throw new Error("unsafe_config_file");
  const current=JSON.parse(await readFile(file,"utf8"));
  exact(current,TOP_FIELDS);
  if (current.version!==4) throw new Error("invalid_source_version");
  exact(current.capabilities,CAPABILITY_FIELDS);
  exact(current.capabilities["daily-work"],DAILY_FIELDS);
  exact(current.capabilities.invoice,OLD_INVOICE_FIELDS);
  const invoice={...current.capabilities.invoice};
  delete invoice.pdfInfoPath;
  delete invoice.pdfToTextPath;
  delete invoice.pdfToPpmPath;
  invoice.pdfProcessorPath=pdfProcessorPath;
  await saveConfig(file,{...current,capabilities:{...current.capabilities,invoice}});
} catch {
  process.exitCode=1;
}

function exact(value,fields) {
  if (!value||typeof value!=="object"||Array.isArray(value)) throw new Error("invalid_config_shape");
  const keys=Object.keys(value);
  if (keys.length!==fields.size||keys.some(key=>!fields.has(key))) throw new Error("invalid_config_shape");
}
