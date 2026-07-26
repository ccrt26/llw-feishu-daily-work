#!/usr/bin/env node
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {installPdfiumRuntime} from "../src/capabilities/invoice/pdfium-runtime.mjs";

const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if (direct) {
  if (process.argv.length!==6) process.exitCode=2;
  else {
    try {
      await installPdfiumRuntime({
        sourceRoot:process.argv[2],
        licenseRoot:process.argv[3],
        processorSource:process.argv[4],
        destinationRoot:process.argv[5]
      });
    } catch {
      process.exitCode=1;
    }
  }
}
