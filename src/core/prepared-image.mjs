import {rm} from "node:fs/promises";

export function createPreparedImageRunner({parse,download,inspect,cleanup=defaultCleanup}) {
  if (typeof parse!=="function"||typeof download!=="function"||typeof inspect!=="function"||typeof cleanup!=="function") {
    throw new Error("invalid_prepared_image_runner");
  }
  return async (message,operation)=>{
    if (typeof operation!=="function") throw new Error("invalid_prepared_image_operation");
    let downloaded;
    try {
      const resource=parse(message);
      if (resource?.type!=="image") throw coded("unsupported_image");
      downloaded=await download({...resource,source:message.source,messageId:message.sourceMessageId});
      const inspected=await inspect(downloaded.file);
      if (inspected?.kind!=="supported_image") throw coded("unsupported_image");
      const preparedImage={
        tempDir:downloaded.tempDir,
        file:downloaded.file,
        detectedFormat:inspected.format,
        archiveExtension:inspected.extension,
        sizeBytes:inspected.sizeBytes
      };
      validatePreparedImage(preparedImage);
      return await operation(preparedImage);
    } finally {
      if (downloaded?.tempDir) await cleanup(downloaded.tempDir).catch(()=>{});
    }
  };
}

function validatePreparedImage(value) {
  if (!value||typeof value!=="object"||
      typeof value.tempDir!=="string"||!value.tempDir||
      typeof value.file!=="string"||!value.file||
      !new Set(["jpeg","png","webp"]).has(value.detectedFormat)||
      !new Set(["jpg","jpeg","png","webp"]).has(value.archiveExtension)||
      !Number.isSafeInteger(value.sizeBytes)||value.sizeBytes<=0) {
    throw coded("invalid_prepared_image");
  }
}

function defaultCleanup(tempDir) { return rm(tempDir,{recursive:true,force:true}); }
function coded(code) { return Object.assign(new Error(code),{code}); }
