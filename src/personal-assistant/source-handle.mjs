const MAX_SOURCE_BYTES=20*1024*1024;
const FORMAT_MEDIA_CLASS=new Map([
  ["txt","document"],["md","document"],["docx","document"],
  ["pptx","document"],["xlsx","document"],["pdf","document"],
  ["png","image"],["jpg","image"],["jpeg","image"],["webp","image"],
  ["aiff","audio"],["wav","audio"],["m4a","audio"],["mp3","audio"],
  ["mov","video"],["mp4","video"]
]);
const REQUIRED_FIELDS=[
  "sourceId","displayName","mediaClass","format","relativePath",
  "byteSize","sha256","availability"
];
const OPTIONAL_FIELDS=[
  "durationMs","instructionRole","representationIndexPath","limitations"
];

export function createSourceHandle(binding) {
  if (!binding||typeof binding!=="object"||Array.isArray(binding)) {
    throw new Error("invalid_source_handle");
  }
  const handle=Object.fromEntries(
    REQUIRED_FIELDS.map(field=>[field,binding[field]])
  );
  for (const field of OPTIONAL_FIELDS) {
    if (binding[field]!==undefined) handle[field]=binding[field];
  }
  const expectedClass=FORMAT_MEDIA_CLASS.get(handle.format);
  const isHeavy=expectedClass==="audio"||expectedClass==="video";
  if (!/^source-00[1-8]$/.test(handle.sourceId)||
      !boundedDisplayName(handle.displayName)||
      !expectedClass||
      handle.mediaClass!==expectedClass||
      handle.relativePath!==`${handle.sourceId}.${handle.format}`||
      !Number.isSafeInteger(handle.byteSize)||
      handle.byteSize<1||
      (!isHeavy&&handle.byteSize>MAX_SOURCE_BYTES)||
      typeof handle.sha256!=="string"||
      !/^[0-9a-f]{64}$/.test(handle.sha256)||
      handle.availability!=="ready"||
      !validOptionalFields(handle)) {
    throw new Error("invalid_source_handle");
  }
  if (Array.isArray(handle.limitations)) {
    handle.limitations=Object.freeze([...handle.limitations]);
  }
  return Object.freeze(handle);
}

export function projectSourceForModel(binding) {
  return {...createSourceHandle(binding?.handle??binding)};
}

function boundedDisplayName(value) {
  return typeof value==="string"&&
    Buffer.byteLength(value,"utf8")>0&&
    Buffer.byteLength(value,"utf8")<=255&&
    !/[\\/\u0000-\u001f\u007f]/.test(value);
}

function validOptionalFields(handle) {
  if (handle.durationMs!==undefined&&(
    !Number.isSafeInteger(handle.durationMs)||
    handle.durationMs<1||handle.durationMs>7*24*60*60*1000
  )) return false;
  if (handle.instructionRole!==undefined&&
      !new Set(["user_instruction","source_content"])
        .has(handle.instructionRole)) {
    return false;
  }
  if (handle.representationIndexPath!==undefined&&
      handle.representationIndexPath!==
        `${handle.sourceId}.manifest.json`) {
    return false;
  }
  if (handle.limitations!==undefined&&(
    !Array.isArray(handle.limitations)||
    handle.limitations.length>8||
    handle.limitations.some(value=>
      typeof value!=="string"||!value||
      Buffer.byteLength(value,"utf8")>1_000
    )
  )) return false;
  return true;
}
