import {createHash} from "node:crypto";

const STAGES=new Set(["normalize","route","download","inspect","analyze","validate","archive","reply","listener","startup"]);
const NUMERIC=[
  "durationMs","sizeBytes","stderrBytes","retryCount",
  "fileCount","totalBytes"
];

export function safeLog(input={}) {
  const output={time:new Date().toISOString(),stage:STAGES.has(input.stage)?input.stage:"startup",code:safeCode(input.code),correlation:createHash("sha256").update(`log:${String(input.messageId || "")}`).digest("hex").slice(0,12)};
  for (const field of NUMERIC) if (Number.isFinite(input[field]) && input[field] >= 0) output[field]=input[field];
  if (/^[a-f0-9]{64}$/u.test(input.bundleSha256||"")) {
    output.bundleSha256=input.bundleSha256;
  }
  return JSON.stringify(output);
}

function safeCode(value) {
  return typeof value === "string" && /^[a-z0-9:_-]{1,80}$/.test(value) ? value : "unknown";
}
