import {lstat,readFile} from "node:fs/promises";
import {isAbsolute} from "node:path";
import {saveConfig} from "./config.mjs";

const LEGACY_FIELDS=new Set([
  "enabled","skillName","aiTimeoutMs","maxContextBytes",
  "personalRulesFile"
]);

try {
  const [file,expectedManifestSha256]=process.argv.slice(2);
  if (process.argv.slice(2).length!==2||
      !file||
      !/^[a-f0-9]{64}$/u.test(expectedManifestSha256||"")) {
    invalid();
  }
  const metadata=await lstat(file);
  if (!metadata.isFile()||metadata.isSymbolicLink()||
      metadata.uid!==process.getuid()||(metadata.mode&0o077)!==0) {
    invalid();
  }
  const before=await readFile(file);
  const current=JSON.parse(before.toString("utf8"));
  const assistant=current?.personalAssistant;
  if (current?.version!==6||
      !assistant||typeof assistant!=="object"||Array.isArray(assistant)||
      Object.keys(assistant).length!==LEGACY_FIELDS.size||
      Object.keys(assistant).some(field=>!LEGACY_FIELDS.has(field))||
      assistant.enabled!==true||
      assistant.skillName!=="llw-personal-assistant"||
      assistant.aiTimeoutMs!==120_000||
      assistant.maxContextBytes!==512*1024||
      !(
        assistant.personalRulesFile===null||
        (
          typeof assistant.personalRulesFile==="string"&&
          isAbsolute(assistant.personalRulesFile)
        )
      )) {
    invalid();
  }
  const updated={
    ...current,
    privateSkills:{
      ...current.privateSkills,expectedManifestSha256
    },
    personalAssistant:{
      ...assistant,
      maxSourcesPerTurn:8,
      maxSourceFileBytes:20*1024*1024,
      maxTurnSourceBytes:80*1024*1024,
      sourceBurstQuietMs:3_000,
      sourceBurstMaxMs:15_000
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
  throw new Error("config_migration_invalid");
}
