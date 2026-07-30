import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectIsoBmffMediaHeader
} from "../src/personal-assistant/iso-bmff-media-header.mjs";

test("accepts bounded ISO-BMFF audio and video headers",async()=>{
  const audio=await inspectIsoBmffMediaHeader({
    header:ftyp("M4A ",["isom","mp42"]),
    byteSize:2048,
    kind:"audio",
    durationMs:250_709
  });
  assert.deepEqual(audio,{
    detectedMime:"audio/mp4",
    format:"m4a",
    durationMs:250_709,
    limitations:["duration_from_verified_bilibili_control"]
  });

  const video=await inspectIsoBmffMediaHeader({
    header:ftyp("isom",["isom","avc1"]),
    byteSize:4096,
    kind:"video",
    durationMs:250_709
  });
  assert.deepEqual(video,{
    detectedMime:"video/mp4",
    format:"mp4",
    durationMs:250_709,
    limitations:["duration_from_verified_bilibili_control"]
  });
});

test("rejects malformed, wrong-kind and ambiguous ISO-BMFF headers",async()=>{
  for (const value of [
    {header:Buffer.from("not-media"),byteSize:2048,kind:"audio",durationMs:1},
    {header:ftyp("M4A ",["isom"]),byteSize:2048,kind:"video",durationMs:1},
    {header:ftyp("isom",["isom","avc1"]),byteSize:2048,kind:"audio",durationMs:1},
    {header:ftyp("isom",["isom"]),byteSize:2048,kind:"video",durationMs:1},
    {header:ftyp("M4A ",["isom"]),byteSize:11,kind:"audio",durationMs:1},
    {header:ftyp("M4A ",["isom"]),byteSize:2048,kind:"audio",durationMs:0}
  ]) {
    await assert.rejects(
      inspectIsoBmffMediaHeader(value),
      /iso_bmff_media_invalid/
    );
  }
});

function ftyp(major,compatible) {
  const size=16+compatible.length*4;
  const value=Buffer.alloc(size);
  value.writeUInt32BE(size,0);
  value.write("ftyp",4,"ascii");
  value.write(major,8,"ascii");
  value.writeUInt32BE(0,12);
  compatible.forEach((brand,index)=>
    value.write(brand,16+index*4,"ascii")
  );
  return value;
}
