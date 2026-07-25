import {createHash} from "node:crypto";
import {rm} from "node:fs/promises";
import {parseInvoiceResource} from "./resource-marker.mjs";
import {failure,formatArchive,formatNonArchive,formatUnsupported} from "./receipt.mjs";
import {validatePreparedVisual} from "../../core/prepared-visual.mjs";

export function createInvoiceCapability({download,inspect,preparePdf,decide,validate,derive,writer,cleanup=defaultCleanup,parse=parseInvoiceResource}) {
  return {
    name:"invoice",
    async handle(event,{preparedVisual}={}) {
      let resource;
      try { resource=parse(event); }
      catch { return {status:"failed",reply:"附件标识无法安全解析，本文件未下载、未识别、未归档；请重新发送原文件。",artifacts:[]}; }
      const transactionId=createHash("sha256").update(`invoice:${event.sourceMessageId}:${resource.fileKey||resource.resourceId}`).digest("hex").slice(0,32);
      let downloaded;
      let stage="download";
      try {
        let analysisInput;
        if (preparedVisual!==undefined) {
          stage="inspect";
          validatePreparedVisual(preparedVisual);
          if (resource.type!==preparedVisual.resourceType) throw coded("invalid_prepared_visual");
          analysisInput=preparedVisual.analysisInput;
        } else {
          downloaded=await download({...resource,source:event.source,messageId:event.sourceMessageId});
          stage="inspect";
          const inspected=await inspect(downloaded.file);
          if (inspected.kind === "supported_image") {
            analysisInput={
              originalFile:downloaded.file,detectedFormat:inspected.format,archiveExtension:inspected.extension,
              pageImages:[downloaded.file],extractedText:"",documentFacts:{pageCount:1,textAvailable:false}
            };
          } else if (inspected.kind === "pdf") {
            stage="prepare_pdf";
            analysisInput=await preparePdf({file:downloaded.file});
          } else return formatUnsupported(inspected.kind);
        }
        stage="analyze";
        const raw=await decide({analysisInput});
        const extraction=validate(raw);
        const decision=derive(extraction);
        if (decision.action !== "archive_dining") return formatNonArchive(decision);
        stage="archive";
        const archived=await writer.archive({transactionId,source:analysisInput.originalFile,invoice:decision.invoice,extension:analysisInput.archiveExtension});
        return formatArchive(decision,archived);
      } catch (error) {
        return failure(stage,error?.code);
      } finally {
        if (downloaded?.tempDir) {
          try { await cleanup(downloaded.tempDir); } catch { /* startup scavenger retries cleanup */ }
        }
      }
    }
  };
}

function defaultCleanup(tempDir) { return rm(tempDir,{recursive:true,force:true}); }

function coded(code) { return Object.assign(new Error(code),{code}); }
