const VIEWS=new Set([
  "probe_media",
  "read_existing_subtitles",
  "transcribe_audio",
  "build_navigation_overview",
  "inspect_time_range"
]);

export function validateSourceReadRequest({
  raw,availableSources,maxRequests=8,
  maxRangeMs=60_000,maxTotalRangeMs=180_000
}) {
  if (!Array.isArray(raw)||raw.length<1||
      !Number.isSafeInteger(maxRequests)||maxRequests<1||
      maxRequests>8||raw.length>maxRequests||
      !Number.isSafeInteger(maxRangeMs)||maxRangeMs<1||
      !Number.isSafeInteger(maxTotalRangeMs)||
      maxTotalRangeMs<maxRangeMs||
      !Array.isArray(availableSources)||
      availableSources.length<1||availableSources.length>8) {
    reject();
  }
  const sources=new Map();
  for (const binding of availableSources) {
    const source=binding?.handle??binding;
    if (!source||typeof source!=="object"||
        !/^source-00[1-8]$/u.test(source.sourceId||"")||
        !new Set(["audio","video"]).has(source.mediaClass)||
        sources.has(source.sourceId)||
        !(source.durationMs===undefined||
          Number.isSafeInteger(source.durationMs))) {
      reject();
    }
    sources.set(source.sourceId,source);
  }
  const usedSources=new Set();
  let totalRangeMs=0;
  const normalized=raw.map(request=>{
    if (!request||typeof request!=="object"||Array.isArray(request)||
        !/^source-00[1-8]$/u.test(request.sourceId||"")||
        !VIEWS.has(request.view)||!sources.has(request.sourceId)) {
      reject();
    }
    usedSources.add(request.sourceId);
    if (request.view==="inspect_time_range") {
      if (!exactKeys(request,[
        "sourceId","view","startMs","endMs"
      ])||
          !Number.isSafeInteger(request.startMs)||
          !Number.isSafeInteger(request.endMs)||
          request.startMs<0||request.endMs<=request.startMs||
          request.endMs-request.startMs>maxRangeMs||
          (
            Number.isSafeInteger(sources.get(request.sourceId).durationMs)&&
            request.endMs>sources.get(request.sourceId).durationMs
          )) {
        reject();
      }
      totalRangeMs+=request.endMs-request.startMs;
      return Object.freeze({
        sourceId:request.sourceId,view:request.view,
        startMs:request.startMs,endMs:request.endMs
      });
    }
    if (!exactKeys(request,["sourceId","view"])) reject();
    return Object.freeze({
      sourceId:request.sourceId,view:request.view
    });
  });
  if (usedSources.size!==1||totalRangeMs>maxTotalRangeMs) reject();
  return Object.freeze(normalized);
}

function exactKeys(value,keys) {
  const allowed=new Set(keys);
  return Object.keys(value).length===allowed.size&&
    Object.keys(value).every(key=>allowed.has(key));
}

function reject() {
  throw new Error("source_read_request_invalid");
}
