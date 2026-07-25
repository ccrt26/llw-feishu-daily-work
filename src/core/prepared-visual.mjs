import {rm} from "node:fs/promises";

export function createPreparedVisualRunner({parse,download,inspect,preparePdf,cleanup=defaultCleanup}) {
  if (![parse,download,inspect,preparePdf,cleanup].every(value=>typeof value==="function")) throw new Error("invalid_prepared_visual_runner");
  return async (message,operation)=>{
    if (typeof operation!=="function") throw new Error("invalid_prepared_visual_operation");
    let downloaded;
    try {
      const resource=parse(message);
      if (!resource||!new Set(["image","file"]).has(resource.type)) throw coded("unsupported_resource_type");
      downloaded=await download({...resource,source:message.source,messageId:message.sourceMessageId});
      const inspected=await inspect(downloaded.file);
      let analysisInput;
      if (resource.type==="image"&&inspected?.kind==="supported_image") {
        analysisInput={
          originalFile:downloaded.file,
          detectedFormat:inspected.format,
          archiveExtension:inspected.extension,
          pageImages:[downloaded.file],
          extractedText:"",
          documentFacts:{pageCount:1,textAvailable:false}
        };
      } else if (resource.type==="file"&&inspected?.kind==="pdf") {
        analysisInput=await preparePdf({file:downloaded.file});
      } else throw coded("unsupported_resource_type");
      validatePreparedVisual({tempDir:downloaded.tempDir,resourceType:resource.type,analysisInput});
      return await operation({tempDir:downloaded.tempDir,resourceType:resource.type,analysisInput});
    } finally {
      if (downloaded?.tempDir) await cleanup(downloaded.tempDir).catch(()=>{});
    }
  };
}

export function validatePreparedVisual(value) {
  if (!value||typeof value!=="object"||Array.isArray(value)||
      typeof value.tempDir!=="string"||!value.tempDir||
      !new Set(["image","file"]).has(value.resourceType)) throw coded("invalid_prepared_visual");
  const input=value.analysisInput;
  if (!input||typeof input!=="object"||Array.isArray(input)||
      typeof input.originalFile!=="string"||!input.originalFile||
      !new Set(["jpeg","png","webp","pdf"]).has(input.detectedFormat)||
      !new Set(["jpg","jpeg","png","webp","pdf"]).has(input.archiveExtension)||
      !Array.isArray(input.pageImages)||input.pageImages.length<1||input.pageImages.length>10||
      input.pageImages.some(path=>typeof path!=="string"||!path)||
      typeof input.extractedText!=="string"||
      !input.documentFacts||typeof input.documentFacts!=="object"||
      !Number.isSafeInteger(input.documentFacts.pageCount)||
      input.documentFacts.pageCount!==input.pageImages.length||
      typeof input.documentFacts.textAvailable!=="boolean") throw coded("invalid_prepared_visual");
  if (value.resourceType==="image"&&(input.detectedFormat==="pdf"||input.pageImages.length!==1||input.extractedText!=="")) throw coded("invalid_prepared_visual");
  if (value.resourceType==="file"&&(input.detectedFormat!=="pdf"||input.archiveExtension!=="pdf")) throw coded("invalid_prepared_visual");
  return value;
}

function defaultCleanup(tempDir) { return rm(tempDir,{recursive:true,force:true}); }
function coded(code) { return Object.assign(new Error(code),{code}); }
