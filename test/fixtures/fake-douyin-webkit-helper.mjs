#!/usr/bin/env node
import {createHash} from "node:crypto";
import {writeFileSync} from "node:fs";
import {chmod,mkdir,writeFile} from "node:fs/promises";
import {join} from "node:path";

const args=parseArgs(process.argv.slice(2));
const mode=process.env.LLW_FAKE_DOUYIN_MODE||"ok";

if (mode==="sleep") {
  await new Promise(resolve=>setTimeout(resolve,5_000));
}
if (mode==="oversized_stdout") {
  writeFileSync(1,Buffer.alloc(70_000,0x78));
  process.exit(0);
}
if (mode==="malformed") {
  process.stdout.write("{not-json");
  process.exit(0);
}

await mkdir(args.outputDir,{recursive:true});
const audio=Buffer.from("synthetic-douyin-audio");
const video=Buffer.from("synthetic-douyin-video");
const audioName="douyin-audio.m4a";
const videoName="douyin-video.mp4";
const durationMs=mode==="long_prefix"
  ?3_304_600
  :mode==="complete_short"
    ?300_000
    :64_689;
const limitations=mode==="long_prefix"
  ?["bounded_audio_prefix","bounded_video_prefix"]
  :mode==="complete_short"
    ?["bounded_video_prefix"]
    :[];
await writePrivate(join(args.outputDir,audioName),audio);
if (mode!=="missing_video") {
  await writePrivate(join(args.outputDir,videoName),video);
}

const result={
  version:1,
  status:"ok",
  mediaId:new URL(args.url).pathname.split("/").at(-1),
  canonicalUrl:args.url,
  durationMs,
  audio:{
    relativePath:
      mode==="path_escape"?"../escaped.m4a":audioName,
    byteSize:audio.length,
    sha256:
      mode==="hash_mismatch"?"0".repeat(64):sha256(audio),
    detectedMime:"audio/mp4",
    format:"m4a",
    durationMs
  },
  video:{
    relativePath:videoName,
    byteSize:video.length,
    sha256:sha256(video),
    detectedMime:"video/mp4",
    format:"mp4",
    durationMs,
    width:1280,
    height:720
  },
  limitations
};
process.stdout.write(`${JSON.stringify(result)}\n`);

function parseArgs(values) {
  const result={};
  for (let index=0;index<values.length;index+=2) {
    const name=values[index];
    const value=values[index+1];
    if (name==="--url") result.url=value;
    else if (name==="--output-dir") result.outputDir=value;
    else if (
      name==="--audio-max-bytes"||
      name==="--video-max-bytes"||
      name==="--deadline-ms"
    ) {
      continue;
    } else {
      process.exit(64);
    }
  }
  if (!result.url||!result.outputDir) process.exit(64);
  return result;
}

async function writePrivate(file,bytes) {
  await writeFile(file,bytes,{flag:"wx",mode:0o600});
  await chmod(file,0o600);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
