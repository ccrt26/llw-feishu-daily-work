import {execFile} from "node:child_process";
import {createHash} from "node:crypto";
import {lstat,readFile} from "node:fs/promises";
import {isAbsolute,extname} from "node:path";

const SERVICE="com.llw.assistant.volcengine.video-asr.api-key";
const ACCOUNT="llw-assistant";
const RESOURCE_ID="volc.bigasr.auc";
const SUBMIT_ENDPOINT=
  "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit";
const QUERY_ENDPOINT=
  "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query";
const REQUEST_PROFILE="recording_file_standard_base64_m4a_v1";
const MAX_AUDIO_BYTES=32*1024*1024;
const MAX_AUDIO_DURATION_MS=5*60*60*1_000-1;
const MAX_RESPONSE_BYTES=2*1024*1024;
const MAX_TRANSCRIPT_BYTES=512*1024;
const MAX_UTTERANCES=2_048;
const POLL_INTERVAL_MS=2_000;
const POLL_TIMEOUT_MS=180_000;
const SHA=/^[a-f0-9]{64}$/u;
const KEYCHAIN_NAME=/^[A-Za-z0-9._@-]{1,128}$/u;

export function createVolcengineVideoAsrAdapter({
  usageStore,
  keychainService,
  keychainAccount,
  fetchImpl=fetch,
  keyReader=readVolcengineVideoAsrApiKey,
  sleepImpl=abortableSleep,
  now=Date.now
}={}) {
  if (!usageStore||
      typeof usageStore.reserve!=="function"||
      typeof usageStore.complete!=="function"||
      keychainService!==SERVICE||keychainAccount!==ACCOUNT||
      !KEYCHAIN_NAME.test(keychainService||"")||
      !KEYCHAIN_NAME.test(keychainAccount||"")||
      typeof fetchImpl!=="function"||
      typeof keyReader!=="function"||
      typeof sleepImpl!=="function"||
      typeof now!=="function") {
    throw safeError("video_asr_configuration_invalid");
  }

  return Object.freeze({
    async transcribe(input) {
      const prepared=await prepareAudio(input);
      const signal=input?.signal;
      throwIfAborted(signal);

      let key;
      try {
        key=await keyReader({
          service:keychainService,
          account:keychainAccount
        });
      } catch {
        throw safeError("video_asr_key_unavailable");
      }
      if (typeof key!=="string"||!key.trim()||
          key!==key.trim()||key.includes("\n")||key.includes("\r")||
          Buffer.byteLength(key,"utf8")>4_096) {
        throw safeError("video_asr_key_unavailable");
      }
      throwIfAborted(signal);

      const reservation=await usageStore.reserve({
        audioSha256:prepared.audioSha256,
        durationMs:prepared.durationMs
      });
      if (!validReservation(reservation,prepared.durationMs)) {
        throw safeError("video_asr_usage_invalid");
      }
      if (reservation.state==="completed") {
        throw safeError("video_asr_result_reuse_required");
      }

      const startedAt=now();
      if (!Number.isSafeInteger(startedAt)||startedAt<0) {
        throw safeError("video_asr_configuration_invalid");
      }
      const headers={
        "X-Api-Key":key,
        "X-Api-Resource-Id":RESOURCE_ID,
        "X-Api-Request-Id":reservation.requestId,
        "X-Api-Sequence":"-1",
        "content-type":"application/json",
        "accept":"application/json"
      };

      if (reservation.created) {
        const body=JSON.stringify({
          user:{uid:"llw-video-asr"},
          audio:{
            format:"m4a",
            data:prepared.bytes.toString("base64")
          },
          request:{model_name:"bigmodel"}
        });
        const submitted=await callProvider({
          fetchImpl,url:SUBMIT_ENDPOINT,headers,body,signal
        });
        if (submitted.code!=="20000000") {
          await submitted.response.body?.cancel().catch(()=>{});
          throw safeError("video_asr_provider_rejected");
        }
        await submitted.response.body?.cancel().catch(()=>{});
      }

      while (true) {
        throwIfAborted(signal);
        if (expired(now,startedAt)) throw safeError("video_asr_timeout");
        const queried=await callProvider({
          fetchImpl,url:QUERY_ENDPOINT,headers,body:"{}",signal
        });
        if (queried.code==="20000000") {
          const raw=await readBoundedBody(queried.response,signal);
          const result=parseFinalResult({
            raw,
            audioSha256:prepared.audioSha256,
            durationMs:prepared.durationMs
          });
          await usageStore.complete({
            audioSha256:prepared.audioSha256,
            requestId:reservation.requestId,
            providerDurationMs:result.providerDurationMs
          });
          return result;
        }
        if (queried.code==="20000003") {
          await queried.response.body?.cancel().catch(()=>{});
          const result=noSpeechResult(prepared);
          await usageStore.complete({
            audioSha256:prepared.audioSha256,
            requestId:reservation.requestId,
            providerDurationMs:prepared.durationMs
          });
          return result;
        }
        if (!new Set(["20000001","20000002"]).has(queried.code)) {
          await queried.response.body?.cancel().catch(()=>{});
          throw safeError("video_asr_provider_rejected");
        }
        await queried.response.body?.cancel().catch(()=>{});
        if (expired(now,startedAt)) throw safeError("video_asr_timeout");
        try {
          await sleepImpl(POLL_INTERVAL_MS,signal);
        } catch {
          throwIfAborted(signal);
          throw safeError("video_asr_connection_failed");
        }
      }
    }
  });
}

export function readVolcengineVideoAsrApiKey({service,account}) {
  if (service!==SERVICE||account!==ACCOUNT) {
    return Promise.reject(safeError("video_asr_key_unavailable"));
  }
  return new Promise((resolve,reject)=>{
    execFile(
      "/usr/bin/security",
      ["find-generic-password","-w","-s",service,"-a",account],
      {encoding:"utf8",maxBuffer:8_192},
      (error,stdout)=>{
        if (error) {
          reject(safeError("video_asr_key_unavailable"));
          return;
        }
        resolve(stdout.trim());
      }
    );
  });
}

async function prepareAudio(input) {
  const {
    audioFile,audioSha256,durationMs,signal
  }=input||{};
  if (typeof audioFile!=="string"||!isAbsolute(audioFile)||
      extname(audioFile).toLowerCase()!==".m4a"||
      !SHA.test(audioSha256||"")||
      !Number.isSafeInteger(durationMs)||
      durationMs<1||durationMs>MAX_AUDIO_DURATION_MS||
      !(signal===undefined||signal instanceof AbortSignal)) {
    throw safeError("video_asr_input_invalid");
  }
  throwIfAborted(signal);
  let info;
  try {
    info=await lstat(audioFile);
  } catch {
    throw safeError("video_asr_input_invalid");
  }
  if (!info.isFile()||info.isSymbolicLink()||
      info.uid!==process.getuid()||(info.mode&0o077)!==0||
      info.size<12||info.size>MAX_AUDIO_BYTES) {
    throw safeError("video_asr_input_invalid");
  }
  let bytes;
  try {
    bytes=await readFile(audioFile);
  } catch {
    throw safeError("video_asr_input_invalid");
  }
  throwIfAborted(signal);
  if (bytes.length!==info.size||
      bytes.subarray(4,8).toString("ascii")!=="ftyp"||
      createHash("sha256").update(bytes).digest("hex")!==audioSha256) {
    throw safeError("video_asr_input_invalid");
  }
  return Object.freeze({
    audioFile,audioSha256,durationMs,bytes
  });
}

async function callProvider({
  fetchImpl,url,headers,body,signal
}) {
  let response;
  try {
    response=await fetchImpl(url,{
      method:"POST",
      headers,
      body,
      signal,
      redirect:"error"
    });
  } catch {
    throwIfAborted(signal);
    throw safeError("video_asr_connection_failed");
  }
  if (!response||typeof response.ok!=="boolean"||
      !response.headers||typeof response.headers.get!=="function") {
    throw safeError("video_asr_response_invalid");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(()=>{});
    throw safeError("video_asr_http_error");
  }
  const code=response.headers.get("x-api-status-code");
  if (typeof code!=="string"||!/^[0-9]{8}$/u.test(code)) {
    await response.body?.cancel().catch(()=>{});
    throw safeError("video_asr_response_invalid");
  }
  return {response,code};
}

async function readBoundedBody(response,signal) {
  if (!response.body||typeof response.body.getReader!=="function") {
    throw safeError("video_asr_response_invalid");
  }
  const reader=response.body.getReader();
  const chunks=[];
  let total=0;
  while (true) {
    throwIfAborted(signal);
    let part;
    try {
      part=await reader.read();
    } catch {
      throwIfAborted(signal);
      throw safeError("video_asr_response_invalid");
    }
    if (part.done) break;
    total+=part.value.byteLength;
    if (total>MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(()=>{});
      throw safeError("video_asr_response_too_large");
    }
    chunks.push(Buffer.from(part.value));
  }
  try {
    return new TextDecoder("utf-8",{fatal:true}).decode(
      Buffer.concat(chunks)
    );
  } catch {
    throw safeError("video_asr_response_invalid");
  }
}

function parseFinalResult({raw,audioSha256,durationMs}) {
  let value;
  try {
    value=JSON.parse(raw);
  } catch {
    throw safeError("video_asr_response_invalid");
  }
  if (!exact(value,new Set(["audio_info","result"]))||
      !exact(value.audio_info,new Set(["duration"]))||
      !Number.isSafeInteger(value.audio_info.duration)||
      value.audio_info.duration<1||
      value.audio_info.duration>MAX_AUDIO_DURATION_MS+5_000||
      Math.abs(value.audio_info.duration-durationMs)>5_000||
      !exact(value.result,new Set([
        "additions","text","utterances"
      ]))||
      !plain(value.result.additions)||
      typeof value.result.text!=="string"||
      Buffer.byteLength(value.result.text,"utf8")>MAX_TRANSCRIPT_BYTES||
      !Array.isArray(value.result.utterances)||
      value.result.utterances.length>MAX_UTTERANCES) {
    throw safeError("video_asr_response_invalid");
  }
  const segments=[];
  let previousEnd=0;
  let transcriptBytes=0;
  for (const utterance of value.result.utterances) {
    if (!exact(utterance,new Set([
      "start_time","end_time","text","words"
    ]))||
        !Number.isSafeInteger(utterance.start_time)||
        !Number.isSafeInteger(utterance.end_time)||
        utterance.start_time<previousEnd||
        utterance.end_time<=utterance.start_time||
        utterance.end_time>value.audio_info.duration||
        typeof utterance.text!=="string"||
        !utterance.text.trim()||
        !Array.isArray(utterance.words)) {
      throw safeError("video_asr_response_invalid");
    }
    transcriptBytes+=Buffer.byteLength(utterance.text,"utf8");
    if (!Number.isSafeInteger(transcriptBytes)||
        transcriptBytes>MAX_TRANSCRIPT_BYTES) {
      throw safeError("video_asr_response_invalid");
    }
    segments.push({
      startMs:utterance.start_time,
      endMs:utterance.end_time,
      text:utterance.text,
      alternatives:[],
      isFinal:true,
      status:"recognized"
    });
    previousEnd=utterance.end_time;
  }
  if (segments.map(item=>item.text).join("")!==value.result.text) {
    throw safeError("video_asr_response_invalid");
  }
  return Object.freeze({
    providerId:"volcengine",
    apiVersion:"v3",
    resourceId:RESOURCE_ID,
    requestProfile:REQUEST_PROFILE,
    audioSha256,
    originalDurationMs:durationMs,
    providerDurationMs:value.audio_info.duration,
    segments,
    coveredRanges:[{
      startMs:0,endMs:value.audio_info.duration
    }],
    uncoveredRanges:[],
    coverageStatus:"complete",
    limitations:["provider_utterance_timestamps_not_word_exact"]
  });
}

function noSpeechResult({audioSha256,durationMs}) {
  return Object.freeze({
    providerId:"volcengine",
    apiVersion:"v3",
    resourceId:RESOURCE_ID,
    requestProfile:REQUEST_PROFILE,
    audioSha256,
    originalDurationMs:durationMs,
    providerDurationMs:durationMs,
    segments:[],
    coveredRanges:[{startMs:0,endMs:durationMs}],
    uncoveredRanges:[],
    coverageStatus:"complete",
    limitations:["no_speech_detected"]
  });
}

function validReservation(value,durationMs) {
  return plain(value)&&
    typeof value.requestId==="string"&&
    /^[0-9a-f-]{36}$/u.test(value.requestId)&&
    value.durationMs===durationMs&&
    typeof value.created==="boolean"&&
    new Set(["reserved","completed"]).has(value.state)&&
    (value.state!=="completed"||
      Number.isSafeInteger(value.providerDurationMs));
}

function expired(now,startedAt) {
  const current=now();
  if (!Number.isSafeInteger(current)||current<startedAt) {
    throw safeError("video_asr_configuration_invalid");
  }
  return current-startedAt>=POLL_TIMEOUT_MS;
}

function abortableSleep(milliseconds,signal) {
  return new Promise((resolve,reject)=>{
    if (signal?.aborted) {
      reject(safeError("video_asr_aborted"));
      return;
    }
    const timer=setTimeout(done,milliseconds);
    signal?.addEventListener("abort",abort,{once:true});
    function done() {
      signal?.removeEventListener("abort",abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      reject(safeError("video_asr_aborted"));
    }
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw safeError("video_asr_aborted");
}

function plain(value) {
  return value!==null&&typeof value==="object"&&!Array.isArray(value);
}

function exact(value,fields) {
  return plain(value)&&
    Object.keys(value).length===fields.size&&
    Object.keys(value).every(key=>fields.has(key));
}

function safeError(code) {
  return new Error(code);
}
