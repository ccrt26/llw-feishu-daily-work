import {randomUUID} from "node:crypto";
import {constants as fsConstants} from "node:fs";
import {access,lstat,mkdir,open,readFile,rename} from "node:fs/promises";
import {dirname,isAbsolute,join} from "node:path";

const TOP_FIELDS=new Set(["version","vaultRoot","stateFile","heartbeatFile","cliPath","codexPath","profile","senderId","chatId","capabilities"]);
const DAILY_FIELDS=new Set(["enabled","skillRoot"]);
const INVOICE_FIELDS=new Set([
  "enabled","skillRoot","tempRoot","archiveRoot","maxFileBytes","aiTimeoutMs",
  "pdfInfoPath","pdfToTextPath","pdfToPpmPath","maxPdfPages","maxPdfTextBytes","maxPdfRenderBytes","pdfPrepareTimeoutMs"
]);

export async function loadConfig(file,{requireBinding=true}={}) {
  const info=await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw new Error("unsafe_config_file");
  const config=JSON.parse(await readFile(file,"utf8"));
  validateConfig(config,requireBinding);
  return config;
}

export async function saveConfig(file,config,{requireBinding=true}={}) {
  validateConfig(config,requireBinding);
  await mkdir(dirname(file),{recursive:true,mode:0o700});
  const temporary=`${file}.${randomUUID()}.tmp`;
  const handle=await open(temporary,"wx",0o600);
  try { await handle.writeFile(`${JSON.stringify(config,null,2)}\n`,"utf8"); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary,file);
}

export function bindingFromEvent(event) {
  if (event?.chat_type !== "p2p" || event?.message_type !== "text" || event?.content !== "LLW-BIND-DAILY-WORK") return null;
  if (typeof event.sender_id !== "string" || !event.sender_id || typeof event.chat_id !== "string" || !event.chat_id) return null;
  return {senderId:event.sender_id,chatId:event.chat_id};
}

export async function validatePdfTools(invoice) {
  for (const field of ["pdfInfoPath","pdfToTextPath","pdfToPpmPath"]) {
    try {
      const info=await lstat(invoice[field]);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("unsafe");
      await access(invoice[field],fsConstants.X_OK);
    } catch {
      throw new Error(`unsafe_pdf_tool:${field}`);
    }
  }
}

function validateConfig(config,requireBinding) {
  exact(config,TOP_FIELDS,"config");
  if (config.version !== 4) throw new Error("invalid_config_version");
  for (const field of ["vaultRoot","stateFile","heartbeatFile","cliPath","codexPath"]) absolute(config[field],field);
  if (typeof config.profile !== "string" || !config.profile) throw new Error("invalid_profile");
  for (const field of ["senderId","chatId"]) {
    if (config[field] !== null && (typeof config[field] !== "string" || !config[field])) throw new Error(`invalid_binding:${field}`);
  }
  if (requireBinding && (!config.senderId || !config.chatId)) throw new Error("binding_missing");
  exact(config.capabilities,new Set(["daily-work","invoice"]),"capabilities");
  const daily=config.capabilities["daily-work"],invoice=config.capabilities.invoice;
  exact(daily,DAILY_FIELDS,"capability"); exact(invoice,INVOICE_FIELDS,"capability");
  if (typeof daily.enabled !== "boolean" || typeof invoice.enabled !== "boolean") throw new Error("invalid_capability_enabled");
  absolute(daily.skillRoot,"daily-work.skillRoot");
  for (const field of ["skillRoot","tempRoot","archiveRoot"]) absolute(invoice[field],`invoice.${field}`);
  for (const field of ["pdfInfoPath","pdfToTextPath","pdfToPpmPath"]) absolute(invoice[field],`invoice.${field}`);
  if (invoice.archiveRoot !== join(config.vaultRoot,"亚信工作","日常发票","餐饮发票")) throw new Error("invalid_invoice_archive_root");
  if (invoice.maxFileBytes !== 20 * 1024 * 1024) throw new Error("invalid_max_file_bytes");
  if (invoice.aiTimeoutMs !== 120_000) throw new Error("invalid_ai_timeout");
  if (invoice.maxPdfPages !== 10) throw new Error("invalid_max_pdf_pages");
  if (invoice.maxPdfTextBytes !== 262_144) throw new Error("invalid_max_pdf_text_bytes");
  if (invoice.maxPdfRenderBytes !== 100 * 1024 * 1024) throw new Error("invalid_max_pdf_render_bytes");
  if (invoice.pdfPrepareTimeoutMs !== 60_000) throw new Error("invalid_pdf_prepare_timeout");
}

function exact(value,fields,label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid_${label}`);
  for (const key of Object.keys(value)) if (!fields.has(key)) throw new Error(label === "capability" ? "unknown_capability_field" : `unknown_${label}_field`);
  for (const key of fields) if (!Object.hasOwn(value,key)) throw new Error(`missing_${label}_field`);
}
function absolute(value,field) { if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`invalid_config_path:${field}`); }
