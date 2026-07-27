import {lstat,readFile} from "node:fs/promises";
import {loadConfig,saveConfig} from "./config.mjs";

try {
  const [file,expectedManifestSha256]=process.argv.slice(2);
  if (!file||!/^[a-f0-9]{64}$/u.test(expectedManifestSha256||"")) {
    throw new Error("migration_input_invalid");
  }
  const metadata=await lstat(file);
  if (!metadata.isFile()||metadata.isSymbolicLink()||
      metadata.uid!==process.getuid()||(metadata.mode&0o077)!==0) {
    throw new Error("unsafe_config_file");
  }
  const current=await loadConfig(file);
  if (current.version!==5) throw new Error("invalid_source_version");
  const before=await readFile(file);
  try {
    await saveConfig(file,{
      ...current,
      version:6,
      privateSkills:{
        ...current.privateSkills,expectedManifestSha256
      },
      personalAssistant:{
        enabled:true,
        skillName:"llw-personal-assistant",
        aiTimeoutMs:120_000,
        maxContextBytes:512*1024,
        personalRulesFile:null
      }
    });
  } catch (error) {
    if (!(await readFile(file)).equals(before)) {
      throw new Error("migration_changed_on_failure");
    }
    throw error;
  }
} catch {
  process.exitCode=1;
}
