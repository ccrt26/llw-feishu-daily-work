import {randomUUID} from "node:crypto";
import {
  lstat,mkdir,open,readFile,rename,rm
} from "node:fs/promises";
import {dirname,isAbsolute,join} from "node:path";

export const VIDEO_ASR_TRIAL_HARD_LIMIT_MS=19*60*60*1_000;
export const VIDEO_ASR_INITIAL_CONSUMED_MS=288_250;

const MAX_AUDIO_DURATION_MS=30*60*1_000;
const MAX_ENTRIES=4_096;
const MAX_STATE_BYTES=2*1024*1024;
const SHA=/^[a-f0-9]{64}$/u;
const REQUEST_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const STATE_FIELDS=new Set([
  "version","hardLimitMs","initialConsumedMs","entries"
]);
const ENTRY_FIELDS=new Set([
  "requestId","durationMs","providerDurationMs","state"
]);

export class ExternalVideoAsrUsageStore {
  constructor({
    file,
    hardLimitMs=VIDEO_ASR_TRIAL_HARD_LIMIT_MS,
    initialConsumedMs=VIDEO_ASR_INITIAL_CONSUMED_MS,
    renameFile=rename
  }) {
    if (typeof file!=="string"||!isAbsolute(file)||
        hardLimitMs!==VIDEO_ASR_TRIAL_HARD_LIMIT_MS||
        initialConsumedMs!==VIDEO_ASR_INITIAL_CONSUMED_MS||
        typeof renameFile!=="function") {
      throw invalid();
    }
    this.file=file;
    this.hardLimitMs=hardLimitMs;
    this.initialConsumedMs=initialConsumedMs;
    this.renameFile=renameFile;
    this.pending=Promise.resolve();
  }

  reserve({audioSha256,durationMs}={}) {
    if (!SHA.test(audioSha256||"")||
        !Number.isSafeInteger(durationMs)||
        durationMs<1||durationMs>MAX_AUDIO_DURATION_MS) {
      return Promise.reject(invalid());
    }
    return this.serial(async()=>{
      const state=await this.load();
      const existing=state.entries[audioSha256];
      if (existing) {
        if (existing.durationMs!==durationMs) throw invalid();
        return publicEntry(existing,{created:false});
      }
      if (Object.keys(state.entries).length>=MAX_ENTRIES) {
        throw unavailable();
      }
      const consumed=totalReserved(state);
      if (!Number.isSafeInteger(consumed)||
          consumed+durationMs>this.hardLimitMs) {
        throw safeError("video_asr_trial_exhausted");
      }
      const entry={
        requestId:randomUUID(),
        durationMs,
        providerDurationMs:null,
        state:"reserved"
      };
      state.entries[audioSha256]=entry;
      await this.write(state);
      return publicEntry(entry,{created:true});
    });
  }

  complete({
    audioSha256,requestId,providerDurationMs
  }={}) {
    if (!SHA.test(audioSha256||"")||
        !REQUEST_ID.test(requestId||"")||
        !Number.isSafeInteger(providerDurationMs)||
        providerDurationMs<1||
        providerDurationMs>MAX_AUDIO_DURATION_MS+5_000) {
      return Promise.reject(invalid());
    }
    return this.serial(async()=>{
      const state=await this.load();
      const entry=state.entries[audioSha256];
      if (!entry||entry.requestId!==requestId) throw invalid();
      if (entry.state==="completed") {
        if (entry.providerDurationMs!==providerDurationMs) throw invalid();
        return publicEntry(entry);
      }
      entry.state="completed";
      entry.providerDurationMs=providerDurationMs;
      await this.write(state);
      return publicEntry(entry);
    });
  }

  serial(operation) {
    const result=this.pending.then(operation,operation);
    this.pending=result.then(()=>undefined,()=>undefined);
    return result;
  }

  async load() {
    const parent=dirname(this.file);
    await ensurePrivateParent(parent);
    let info;
    try {
      info=await lstat(this.file);
    } catch (error) {
      if (error?.code==="ENOENT") {
        return {
          version:1,
          hardLimitMs:this.hardLimitMs,
          initialConsumedMs:this.initialConsumedMs,
          entries:{}
        };
      }
      throw unavailable();
    }
    if (!privateFile(info)||info.size<2||info.size>MAX_STATE_BYTES) {
      throw unavailable();
    }
    let state;
    try {
      state=JSON.parse(await readFile(this.file,"utf8"));
    } catch {
      throw invalid();
    }
    validateState(state,this.hardLimitMs,this.initialConsumedMs);
    return state;
  }

  async write(state) {
    validateState(state,this.hardLimitMs,this.initialConsumedMs);
    const parent=dirname(this.file);
    await ensurePrivateParent(parent);
    const temporary=join(parent,`.video-asr-usage-${randomUUID()}.tmp`);
    let handle;
    try {
      handle=await open(temporary,"wx",0o600);
      await handle.writeFile(`${JSON.stringify(state)}\n`,"utf8");
      await handle.sync();
      await handle.close();
      handle=null;
      await this.renameFile(temporary,this.file);
      const info=await lstat(this.file);
      if (!privateFile(info)) throw unavailable();
    } catch (error) {
      try { await handle?.close(); } catch {}
      await rm(temporary,{force:true}).catch(()=>{});
      if (error?.message?.startsWith("video_asr_")) throw error;
      throw unavailable();
    }
  }
}

async function ensurePrivateParent(parent) {
  let info;
  try {
    info=await lstat(parent);
  } catch (error) {
    if (error?.code!=="ENOENT") throw unavailable();
    try {
      await mkdir(parent,{recursive:true,mode:0o700});
      info=await lstat(parent);
    } catch {
      throw unavailable();
    }
  }
  if (!info.isDirectory()||info.isSymbolicLink()||
      info.uid!==process.getuid()||(info.mode&0o077)!==0) {
    throw unavailable();
  }
}

function validateState(state,hardLimitMs,initialConsumedMs) {
  if (!exact(state,STATE_FIELDS)||
      state.version!==1||
      state.hardLimitMs!==hardLimitMs||
      state.initialConsumedMs!==initialConsumedMs||
      !plain(state.entries)||
      Object.keys(state.entries).length>MAX_ENTRIES) {
    throw invalid();
  }
  for (const [sha,entry] of Object.entries(state.entries)) {
    if (!SHA.test(sha)||!exact(entry,ENTRY_FIELDS)||
        !REQUEST_ID.test(entry.requestId||"")||
        !Number.isSafeInteger(entry.durationMs)||
        entry.durationMs<1||entry.durationMs>MAX_AUDIO_DURATION_MS||
        !new Set(["reserved","completed"]).has(entry.state)||
        !(
          entry.state==="reserved"&&entry.providerDurationMs===null||
          entry.state==="completed"&&
          Number.isSafeInteger(entry.providerDurationMs)&&
          entry.providerDurationMs>=1&&
          entry.providerDurationMs<=MAX_AUDIO_DURATION_MS+5_000
        )) {
      throw invalid();
    }
  }
  const consumed=totalReserved(state);
  if (!Number.isSafeInteger(consumed)||consumed>hardLimitMs) {
    throw invalid();
  }
}

function totalReserved(state) {
  let total=state.initialConsumedMs;
  for (const entry of Object.values(state.entries)) {
    total+=entry.durationMs;
  }
  return total;
}

function privateFile(info) {
  return info.isFile()&&!info.isSymbolicLink()&&
    info.uid===process.getuid()&&(info.mode&0o077)===0;
}

function publicEntry(entry,{created}={}) {
  return Object.freeze({
    requestId:entry.requestId,
    state:entry.state,
    durationMs:entry.durationMs,
    ...(created===undefined?{}:{created}),
    ...(entry.state==="completed"
      ?{providerDurationMs:entry.providerDurationMs}
      :{})
  });
}

function plain(value) {
  return value!==null&&typeof value==="object"&&!Array.isArray(value);
}

function exact(value,fields) {
  return plain(value)&&
    Object.keys(value).length===fields.size&&
    Object.keys(value).every(key=>fields.has(key));
}

function invalid() {
  return safeError("video_asr_usage_invalid");
}

function unavailable() {
  return safeError("video_asr_usage_unavailable");
}

function safeError(code) {
  return new Error(code);
}
