const AUDIO_BRANDS=new Set([
  "M4A ","M4B ","iso2","iso5","iso6","isom","mp41","mp42"
]);
const VIDEO_BRANDS=new Set([
  "avc1","iso2","iso5","iso6","isom","mp41","mp42"
]);

export async function inspectIsoBmffMediaHeader({
  header,byteSize,kind,durationMs
}={}) {
  if (!Buffer.isBuffer(header)||header.length<16||
      !Number.isSafeInteger(byteSize)||byteSize<12||
      !new Set(["audio","video"]).has(kind)||
      !Number.isSafeInteger(durationMs)||durationMs<1) {
    throw invalid();
  }
  const boxSize=header.readUInt32BE(0);
  if (header.subarray(4,8).toString("ascii")!=="ftyp"||
      boxSize<16||boxSize>header.length||
      boxSize%4!==0||boxSize>byteSize) {
    throw invalid();
  }
  const brands=[];
  for (let offset=8;offset<boxSize;offset+=4) {
    if (offset===12) continue;
    const brand=header.subarray(offset,offset+4).toString("ascii");
    if (!/^[\x20-\x7e]{4}$/u.test(brand)) throw invalid();
    brands.push(brand);
  }
  const accepted=kind==="audio"?AUDIO_BRANDS:VIDEO_BRANDS;
  if (!brands.some(brand=>accepted.has(brand))) throw invalid();
  if (kind==="audio"&&brands.includes("avc1")) throw invalid();
  if (kind==="video"&&!brands.some(brand=>
    new Set(["avc1","iso2","iso5","iso6"]).has(brand)
  )) throw invalid();
  return {
    detectedMime:kind==="audio"?"audio/mp4":"video/mp4",
    format:kind==="audio"?"m4a":"mp4",
    durationMs,
    limitations:["duration_from_verified_bilibili_control"]
  };
}

function invalid() {
  return new Error("iso_bmff_media_invalid");
}
