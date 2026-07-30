import {lstat,readFile} from "node:fs/promises";
import {loadConfig,saveConfig} from "./config.mjs";

const MEDIA_INPUT_GATES=Object.freeze({
  nativeVoiceEnabled:false,
  audioFileEnabled:false,
  localVideoEnabled:false,
  webPageEnabled:false,
  bilibiliEnabled:false,
  douyinEnabled:false
});

try {
  const [file]=process.argv.slice(2);
  if (!file||process.argv.slice(2).length!==1) invalid();
  const metadata=await lstat(file);
  if (!metadata.isFile()||metadata.isSymbolicLink()||
      metadata.uid!==process.getuid()||(metadata.mode&0o077)!==0) {
    invalid();
  }
  const before=await readFile(file);
  const current=await loadConfig(file);
  if (current.version!==6) invalid();
  const updated={
    ...current,
    version:7,
    mediaInputGates:{...MEDIA_INPUT_GATES}
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
