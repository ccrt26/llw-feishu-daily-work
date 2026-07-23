import {lstat,readFile} from "node:fs/promises";
import {dirname,join} from "node:path";
import {saveConfig} from "./config.mjs";

const TOP_FIELDS=new Set(["version","vaultRoot","stateFile","heartbeatFile","cliPath","codexPath","profile","senderId","chatId","capabilities"]);
const CAPABILITY_FIELDS=new Set(["daily-work","invoice"]);
const DAILY_FIELDS=new Set(["enabled","skillRoot"]);
const INVOICE_V3_FIELDS=new Set(["enabled","skillRoot","tempRoot","archiveRoot","maxFileBytes","aiTimeoutMs"]);

try {
  const file=process.argv[2];
  if (typeof file !== "string" || !file) throw new Error("migration_input_invalid");
  const info=await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw new Error("unsafe_config_file");
  const current=JSON.parse(await readFile(file,"utf8"));
  exact(current,TOP_FIELDS);
  if (current.version !== 3) throw new Error("invalid_source_version");
  exact(current.capabilities,CAPABILITY_FIELDS);
  exact(current.capabilities["daily-work"],DAILY_FIELDS);
  exact(current.capabilities.invoice,INVOICE_V3_FIELDS);
  const migrated={
    ...current,
    version:4,
    modelStateFile:join(dirname(current.stateFile),"model-state"),
    deepseekEnabled:false,
    deepseekModel:"deepseek-v4-pro",
    deepseekKeychainService:"com.llw.deepseek-api",
    deepseekKeychainAccount:"llw-assistant",
    capabilities:{
      ...current.capabilities,
      invoice:{
        ...current.capabilities.invoice,
        pdfInfoPath:process.env.LLW_PDFINFO_PATH,
        pdfToTextPath:process.env.LLW_PDFTOTEXT_PATH,
        pdfToPpmPath:process.env.LLW_PDFTOPPM_PATH,
        maxPdfPages:10,
        maxPdfTextBytes:262_144,
        maxPdfRenderBytes:100 * 1024 * 1024,
        pdfPrepareTimeoutMs:60_000
      }
    }
  };
  await saveConfig(file,migrated);
} catch {
  process.exitCode=1;
}

function exact(value,fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_config_shape");
  const keys=Object.keys(value);
  if (keys.length !== fields.size || keys.some(key => !fields.has(key))) throw new Error("invalid_config_shape");
}
