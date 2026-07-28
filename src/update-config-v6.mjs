import {lstat,readFile} from "node:fs/promises";
import {loadConfig,saveConfig} from "./config.mjs";

try {
  const [file,field,value]=process.argv.slice(2);
  if (!file||process.argv.slice(2).length!==3) invalid();
  if (field==="manifest-sha") {
    if (!/^[a-f0-9]{64}$/u.test(value||"")) invalid();
  } else if (field==="personal-rules-file") {
    if (typeof value!=="string"||!value) invalid();
  } else {
    invalid();
  }
  const metadata=await lstat(file);
  if (!metadata.isFile()||metadata.isSymbolicLink()||
      metadata.uid!==process.getuid()||(metadata.mode&0o077)!==0) {
    invalid();
  }
  const before=await readFile(file);
  const current=await loadConfig(file);
  if (current.version!==6) invalid();
  const updated=field==="manifest-sha"
    ?{
      ...current,
      privateSkills:{
        ...current.privateSkills,expectedManifestSha256:value
      }
    }
    :{
      ...current,
      personalAssistant:{
        ...current.personalAssistant,personalRulesFile:value
      }
    };
  try {
    await saveConfig(file,updated);
  } catch (error) {
    if (!(await readFile(file)).equals(before)) {
      throw new Error("config_changed_on_failure");
    }
    throw error;
  }
} catch {
  process.exitCode=1;
}

function invalid() {
  throw new Error("config_update_invalid");
}
