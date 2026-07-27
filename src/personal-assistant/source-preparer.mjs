import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {prepareKnowledgeText} from "../capabilities/knowledge-ingest/source-preparer.mjs";
import {createSourceEvidence} from "./source-evidence.mjs";

const OFFICE=new Set(["docx","pptx","xlsx"]);
const PLAIN=new Set(["txt","md"]);

export function createAssistantSourcePreparer({
  download,inspect,preparePdf,prepareOffice,prepareTextFile,
  cleanup=async()=>{},maxSourceBytes=262_144,maxFileBytes=20*1024*1024
}) {
  if (![download,inspect,preparePdf,prepareOffice,prepareTextFile,cleanup]
      .every(value=>typeof value==="function")||
      maxSourceBytes!==262_144||maxFileBytes!==20*1024*1024) {
    throw new Error("assistant_source_preparer_invalid");
  }
  return async message=>{
    validateMessage(message);
    if (message.attachments.length===0) {
      const preparedSource={
        ...prepareKnowledgeText({
          text:message.instructionText,maxSourceBytes
        }),
        content:message.instructionText
      };
      return {
        preparedSource,evidence:createSourceEvidence(preparedSource),
        analysisInput:null,imageFiles:[],cleanup:async()=>{}
      };
    }
    let downloaded;
    try {
      const attachment=message.attachments[0];
      downloaded=await download({message,attachment});
      if (!downloaded||typeof downloaded.file!=="string"||
          typeof downloaded.tempDir!=="string") {
        throw new Error("assistant_source_invalid");
      }
      let preparedSource,analysisInput=null,imageFiles=[];
      if (PLAIN.has(attachment.extension)) {
        preparedSource=await prepareTextFile({
          file:downloaded.file,displayName:attachment.displayName,
          extension:attachment.extension,maxSourceBytes
        });
      } else if (OFFICE.has(attachment.extension)) {
        preparedSource=await prepareOffice({
          file:downloaded.file,displayName:attachment.displayName,
          extension:attachment.extension,maxSourceBytes:maxFileBytes,
          maxExtractedBytes:maxSourceBytes
        });
      } else {
        const inspected=await inspect(downloaded.file);
        if (inspected?.kind==="pdf"&&attachment.extension==="pdf") {
          analysisInput=await preparePdf({file:downloaded.file});
          imageFiles=[...analysisInput.pageImages];
          preparedSource=await visualSource({
            file:downloaded.file,attachment,format:"pdf",
            jobSourceName:"source.pdf",
            content:analysisInput.extractedText.trim()||
              "PDF 全页已渲染，未提取到可用文本层。",
            structure:analysisInput.pageImages.map((_,index)=>({
              page:index+1
            }))
          });
        } else if (inspected?.kind==="supported_image"&&
            attachment.type==="image") {
          analysisInput={
            originalFile:downloaded.file,
            detectedFormat:inspected.format,
            archiveExtension:inspected.extension,
            pageImages:[downloaded.file],
            extractedText:"",
            documentFacts:{pageCount:1,textAvailable:false}
          };
          imageFiles=[downloaded.file];
          preparedSource=await visualSource({
            file:downloaded.file,attachment,format:"image",
            jobSourceName:`source.${inspected.extension}`,
            content:"图片已由受支持的视觉模型读取；本地无文字提取层。",
            structure:[{page:1}]
          });
        } else {
          throw new Error("assistant_source_unsupported");
        }
      }
      const tempDir=downloaded.tempDir;
      const result={
        preparedSource,
        evidence:createSourceEvidence(preparedSource),
        analysisInput,
        imageFiles,
        cleanup:once(()=>cleanup(tempDir))
      };
      downloaded=null;
      return result;
    } catch (error) {
      if (downloaded?.tempDir) await cleanup(downloaded.tempDir).catch(()=>{});
      if (error?.message?.startsWith("assistant_source_")) throw error;
      throw new Error("assistant_source_invalid");
    }
  };
}

async function visualSource({
  file,attachment,format,jobSourceName,content,structure
}) {
  const sourceBytes=await readFile(file);
  if (!sourceBytes.length||sourceBytes.length>20*1024*1024) {
    throw new Error("assistant_source_invalid");
  }
  return {
    version:1,sourceKind:"file",detectedFormat:format,
    displayName:attachment.displayName,sizeBytes:sourceBytes.length,
    sha256:createHash("sha256").update(sourceBytes).digest("hex"),
    jobSourceName,safeSourceReference:"",
    extractionIntegrity:"complete",extractionLimitations:[],
    content,structure,sourceBytes
  };
}

function validateMessage(message) {
  if (!message||typeof message!=="object"||Array.isArray(message)||
      typeof message.instructionText!=="string"||
      !Array.isArray(message.attachments)||message.attachments.length>1||
      (!message.instructionText.trim()&&!message.attachments.length)) {
    throw new Error("assistant_source_invalid");
  }
  if (message.attachments.length===1) {
    const value=message.attachments[0];
    if (!value||typeof value!=="object"||Array.isArray(value)||
        !new Set(["image","file"]).has(value.type)||
        typeof value.displayName!=="string"||!value.displayName||
        typeof value.extension!=="string") {
      throw new Error("assistant_source_invalid");
    }
  }
}

function once(operation) {
  let promise;
  return ()=>promise||=Promise.resolve().then(operation);
}
