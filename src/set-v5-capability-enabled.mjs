import {loadConfig,saveConfig} from "./config.mjs";

const APPROVED_CAPABILITIES=new Set([
  "knowledge-ingest","assistant-work"
]);

try {
  const [file,capability,rawEnabled,...extra]=process.argv.slice(2);
  if (!file||extra.length!==0||
      !APPROVED_CAPABILITIES.has(capability)||
      (rawEnabled!=="true"&&rawEnabled!=="false")) {
    throw new Error("invalid_toggle_input");
  }
  const config=await loadConfig(file);
  if (config.version!==5) throw new Error("invalid_config_version");
  await saveConfig(file,{
    ...config,
    capabilities:{
      ...config.capabilities,
      [capability]:{
        ...config.capabilities[capability],
        enabled:rawEnabled==="true"
      }
    }
  });
} catch {
  process.exitCode=1;
}
