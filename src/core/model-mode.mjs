import {randomUUID} from "node:crypto";
import {chmod,lstat,mkdir,open,readFile,rename,rm} from "node:fs/promises";
import {dirname,join,parse,resolve} from "node:path";

const MODES=new Set(["codex","deepseek"]);

export class ModelMode {
  constructor(file,{renameFile=rename}={}) { this.file=file; this.renameFile=renameFile; }

  async read() {
    try {
      if (await hasSymlinkIdentity(this.file)) return "codex";
      const directoryInfo=await lstat(dirname(this.file));
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || directoryInfo.uid!==process.getuid() || (directoryInfo.mode&0o077)!==0) return "codex";
      const info=await lstat(this.file);
      if (!info.isFile() || info.isSymbolicLink() || info.uid!==process.getuid() || (info.mode&0o077)!==0) return "codex";
      const value=(await readFile(this.file,"utf8")).trim();
      return MODES.has(value)?value:"codex";
    } catch { return "codex"; }
  }

  async write(mode) {
    if (!MODES.has(mode)) throw new Error("invalid_model_mode");
    const directory=dirname(this.file);
    if (await hasSymlinkIdentity(this.file)) throw new Error("unsafe_model_state_path");
    await mkdir(directory,{recursive:true,mode:0o700});
    if (await hasSymlinkIdentity(this.file)) throw new Error("unsafe_model_state_path");
    const directoryInfo=await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || directoryInfo.uid!==process.getuid()) throw new Error("unsafe_model_state_directory");
    try { if ((await lstat(this.file)).isSymbolicLink()) throw new Error("unsafe_model_state_path"); }
    catch (error) { if (error.code!=="ENOENT") throw error; }
    await chmod(directory,0o700);
    const temporary=`${this.file}.${randomUUID()}.tmp`;
    let replaced=false;
    try {
      const handle=await open(temporary,"wx",0o600);
      try { await handle.writeFile(`${mode}\n`,"utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await this.renameFile(temporary,this.file);
      replaced=true;
      await chmod(this.file,0o600);
    } finally {
      if (!replaced) await rm(temporary,{force:true}).catch(()=>{});
    }
  }
}

async function hasSymlinkIdentity(file) {
  const absolute=resolve(file),root=parse(absolute).root;
  let current=root;
  for (const part of absolute.slice(root.length).split("/").filter(Boolean)) {
    current=join(current,part);
    try {
      const info=await lstat(current);
      if (info.isSymbolicLink() && !(process.platform==="darwin"&&current==="/var")) return true;
    } catch (error) { if (error.code==="ENOENT") return false; throw error; }
  }
  return false;
}
