const MAX_SOURCE_BYTES=20*1024*1024;
const FORMAT_MEDIA_CLASS=new Map([
  ["txt","document"],["md","document"],["docx","document"],
  ["pptx","document"],["xlsx","document"],["pdf","document"],
  ["png","image"],["jpg","image"],["jpeg","image"],["webp","image"]
]);
const SAFE_FIELDS=[
  "sourceId","displayName","mediaClass","format","relativePath",
  "byteSize","sha256","availability"
];

export function createSourceHandle(binding) {
  if (!binding||typeof binding!=="object"||Array.isArray(binding)) {
    throw new Error("invalid_source_handle");
  }
  const handle=Object.fromEntries(SAFE_FIELDS.map(field=>[field,binding[field]]));
  const expectedClass=FORMAT_MEDIA_CLASS.get(handle.format);
  if (!/^source-00[1-8]$/.test(handle.sourceId)||
      !boundedDisplayName(handle.displayName)||
      !expectedClass||
      handle.mediaClass!==expectedClass||
      handle.relativePath!==`${handle.sourceId}.${handle.format}`||
      !Number.isSafeInteger(handle.byteSize)||
      handle.byteSize<1||
      handle.byteSize>MAX_SOURCE_BYTES||
      typeof handle.sha256!=="string"||
      !/^[0-9a-f]{64}$/.test(handle.sha256)||
      handle.availability!=="ready") {
    throw new Error("invalid_source_handle");
  }
  return Object.freeze(handle);
}

export function projectSourceForModel(binding) {
  return {...createSourceHandle(binding)};
}

function boundedDisplayName(value) {
  return typeof value==="string"&&
    Buffer.byteLength(value,"utf8")>0&&
    Buffer.byteLength(value,"utf8")<=255&&
    !/[\\/\u0000-\u001f\u007f]/.test(value);
}
