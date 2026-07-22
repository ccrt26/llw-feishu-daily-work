import {randomUUID} from "node:crypto";
import {chmod,lstat,mkdir,open,readFile,rename} from "node:fs/promises";
import {dirname} from "node:path";

const MODES=new Set(["codex","deepseek"]);

export class ModelMode {
  constructor(file) { this.file=file; }

  async read() {
    try {
      const info=await lstat(this.file);
      if (!info.isFile() || info.isSymbolicLink() || info.uid!==process.getuid() || (info.mode&0o077)!==0) return "codex";
      const value=(await readFile(this.file,"utf8")).trim();
      return MODES.has(value)?value:"codex";
    } catch { return "codex"; }
  }

  async write(mode) {
    if (!MODES.has(mode)) throw new Error("invalid_model_mode");
    const directory=dirname(this.file);
    await mkdir(directory,{recursive:true,mode:0o700});
    const directoryInfo=await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || directoryInfo.uid!==process.getuid()) throw new Error("unsafe_model_state_directory");
    await chmod(directory,0o700);
    const temporary=`${this.file}.${randomUUID()}.tmp`;
    const handle=await open(temporary,"wx",0o600);
    try { await handle.writeFile(`${mode}\n`,"utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary,this.file);
    await chmod(this.file,0o600);
  }
}
