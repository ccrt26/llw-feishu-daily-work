import {createHash,randomUUID} from "node:crypto";
import {createWriteStream} from "node:fs";
import {chmod,link,rm} from "node:fs/promises";
import {isAbsolute} from "node:path";
import {Transform} from "node:stream";
import {pipeline} from "node:stream/promises";

const MAX_HEADER_BYTES=64*1024;

export async function streamSourceToWorkspace({
  input,destination,maxBytes,signal,inspectHeader
}) {
  if (!input||typeof input.pipe!=="function"||
      typeof destination!=="string"||!isAbsolute(destination)||
      !Number.isSafeInteger(maxBytes)||maxBytes<1||
      !(signal===undefined||signal instanceof AbortSignal)||
      typeof inspectHeader!=="function") {
    throw new Error("source_stream_invalid");
  }
  const partial=`${destination}.partial-${randomUUID()}`;
  let byteSize=0;
  let published=false;
  const hash=createHash("sha256");
  const headerChunks=[];
  let headerBytes=0;
  const meter=new Transform({
    transform(chunk,encoding,callback) {
      const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk,encoding);
      byteSize+=bytes.length;
      if (byteSize>maxBytes) {
        callback(new Error("source_limit_exceeded"));
        return;
      }
      hash.update(bytes);
      if (headerBytes<MAX_HEADER_BYTES) {
        const remaining=MAX_HEADER_BYTES-headerBytes;
        const slice=bytes.subarray(0,remaining);
        headerChunks.push(Buffer.from(slice));
        headerBytes+=slice.length;
      }
      callback(null,bytes);
    }
  });
  try {
    await pipeline(
      input,
      meter,
      createWriteStream(partial,{flags:"wx",mode:0o600}),
      {signal}
    );
    if (byteSize<1) throw new Error("source_stream_empty");
    const inspected=await inspectHeader({
      header:Buffer.concat(headerChunks,headerBytes),
      byteSize
    });
    validateInspection(inspected);
    await chmod(partial,0o600);
    try {
      await link(partial,destination);
      published=true;
    } catch (error) {
      if (error?.code==="EEXIST") {
        throw new Error("source_destination_exists");
      }
      throw error;
    }
    await rm(partial,{force:true});
    return Object.freeze({
      byteSize,
      sha256:hash.digest("hex"),
      detectedMime:inspected.detectedMime,
      format:inspected.format,
      durationMs:inspected.durationMs,
      limitations:Object.freeze([...inspected.limitations])
    });
  } catch (error) {
    await rm(partial,{force:true}).catch(()=>{});
    if (published) await rm(destination,{force:true}).catch(()=>{});
    throw error;
  }
}

function validateInspection(value) {
  if (!value||typeof value!=="object"||Array.isArray(value)||
      typeof value.detectedMime!=="string"||
      !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u.test(value.detectedMime)||
      typeof value.format!=="string"||
      !/^[a-z0-9]{1,16}$/u.test(value.format)||
      !Number.isSafeInteger(value.durationMs)||value.durationMs<1||
      !Array.isArray(value.limitations)||value.limitations.length>8||
      value.limitations.some(item=>
        typeof item!=="string"||
        Buffer.byteLength(item,"utf8")>1_000
      )) {
    throw new Error("source_header_invalid");
  }
}
