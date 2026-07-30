#!/usr/bin/env node
import {createHash} from "node:crypto";
import {writeFile} from "node:fs/promises";
import {join} from "node:path";

const values=parseArgs(process.argv.slice(2));
const mode=process.env.LLW_FAKE_TIMELINE_MODE||"ok";
const durationMs=mode==="rounding_ms"?11_999:12_000;
const baseSamples=[
  {startMs:0,endMs:4_000,sampleMs:2_000},
  {startMs:4_000,endMs:8_000,sampleMs:6_000},
  {startMs:8_000,endMs:12_000,sampleMs:10_000}
];
const samples=structuredClone(baseSamples);
if (mode==="missing_tail") samples[2].endMs=11_000;
if (mode==="rounding_ms") samples[2].endMs=11_999;
if (mode==="out_of_order") [samples[1],samples[2]]=[samples[2],samples[1]];

const count=mode==="too_many_images"?17:1;
const sheets=[];
for (let index=0;index<count;index++) {
  const bytes=png(
    mode==="wide_image"?4:2,
    2,
    mode==="too_many_bytes"?96:33,
    index
  );
  const safeName=`timeline-${String(index+1).padStart(3,"0")}.png`;
  await writeFile(join(values.outputDir,safeName),bytes,{mode:0o600});
  sheets.push({
    relativePath:mode==="path_escape"&&index===0
      ?"../timeline-001.png"
      :safeName,
    sha256:mode==="wrong_hash"&&index===0
      ?"f".repeat(64)
      :createHash("sha256").update(bytes).digest("hex"),
    width:mode==="wide_image"?4:2,
    height:2,
    startMs:0,
    endMs:new Set(["missing_tail","rounding_ms"]).has(mode)
      ?samples[2].endMs
      :12_000,
    firstSampleIndex:0,
    lastSampleIndex:2
  });
}

process.stdout.write(`${JSON.stringify({
  version:1,
  status:"ok",
  contract:"video_timeline_reader_v1",
  durationMs,
  sampleCount:samples.length,
  maxGapMs:4_000,
  samples,
  sheets,
  limitations:["uniform_timeline_sampling","not_frame_by_frame"]
})}\n`);

function parseArgs(args) {
  const result={};
  for (let index=0;index<args.length;index+=2) {
    const key=args[index];
    const value=args[index+1];
    if (!key?.startsWith("--")||value===undefined) process.exit(64);
    result[key.slice(2).replaceAll("-","")]=value;
  }
  if (!result.video||!result.outputdir||!result.expecteddurationms) {
    process.exit(64);
  }
  return {
    video:result.video,
    outputDir:result.outputdir,
    expectedDurationMs:Number(result.expecteddurationms)
  };
}

function png(width,height,totalBytes,marker) {
  const value=Buffer.alloc(Math.max(33,totalBytes),0);
  Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])
    .copy(value,0);
  value.writeUInt32BE(13,8);
  value.write("IHDR",12,"ascii");
  value.writeUInt32BE(width,16);
  value.writeUInt32BE(height,20);
  value[24]=8;
  value[25]=6;
  value[32]=marker;
  return value;
}
