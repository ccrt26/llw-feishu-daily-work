import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function invokeCodex({codexPath, workspaceRoot, skillRoot, text, createTime, forceDaily = false, environment = process.env, timeoutMs = 120000}) {
  const schema = join(skillRoot, "references", "output-schema.json");
  const outputDir = await mkdtemp(join(tmpdir(), "llw-codex-output-"));
  const output = join(outputDir, "decision.json");
  const args = [
    "exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check",
    "--color", "never", "-c", "model_reasoning_effort=\"low\"",
    "--output-schema", schema, "--output-last-message", output, "-"
  ];
  const prompt = [
    "使用 $feishu-daily-work。",
    `消息发送时间（北京时间）：${beijingTimestamp(createTime)}。`,
    forceDaily ? "用户已经明确确认这是一条工作记录；仍不得虚构原文没有的事实。" : "",
    `待判断原文：${text}`
  ].filter(Boolean).join("\n");
  try {
    await runChild(codexPath, args, {cwd: workspaceRoot, environment, stdin: prompt, timeoutMs});
    const parsed = JSON.parse(await readFile(output, "utf8"));
    return validateDecision(parsed, text);
  } finally {
    await rm(outputDir, {recursive: true, force: true});
  }
}

export function validateDecision(decision, text) {
  if (!decision || typeof decision !== "object") throw new Error("invalid_decision");
  if (!["daily_work", "other", "uncertain"].includes(decision.intent)) throw new Error("invalid_intent");
  if (!["high", "medium", "low"].includes(decision.confidence)) throw new Error("invalid_confidence");
  if (decision.source_text !== text) throw new Error("source_text_mismatch");
  if (!Array.isArray(decision.records)) throw new Error("invalid_records");
  if (decision.intent !== "daily_work" && decision.records.length) throw new Error("unexpected_records");
  if (decision.intent === "daily_work") {
    if (decision.confidence !== "high" || decision.records.length === 0) throw new Error("unsafe_daily_work_decision");
    for (const record of decision.records) validateRecord(record, text);
  }
  const normalized = structuredClone(decision);
  if (normalized.intent === "uncertain" && !String(normalized.question || "").trim()) {
    normalized.question = "这段内容是否需要作为工作记录入库？";
  }
  if (normalized.intent !== "uncertain") normalized.question = "";
  return normalized;
}

function validateRecord(record, text) {
  if (!record || !/^\d{4}-\d{2}-\d{2}$/.test(record.occurred_date)) throw new Error("invalid_record_date");
  if (record.occurred_time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(record.occurred_time)) throw new Error("invalid_record_time");
  if (typeof record.title !== "string" || !record.title || typeof record.summary !== "string" || !record.summary) throw new Error("invalid_record_text");
  if (!Array.isArray(record.people) || !Array.isArray(record.follow_ups) || typeof record.location !== "string") throw new Error("invalid_record_fields");
  if (typeof record.original_text !== "string" || !record.original_text || !text.includes(record.original_text)) {
    throw new Error("original_text_mismatch");
  }
}

function runChild(command, args, {cwd, environment, stdin, timeoutMs}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd, env: environment, stdio: ["pipe", "ignore", "pipe"]});
    let stderrBytes = 0;
    child.stderr.on("data", chunk => { stderrBytes += chunk.length; });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", error => { clearTimeout(timer); reject(new Error(`codex_spawn_failed:${error.code || "unknown"}`)); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`codex_failed:${code ?? signal}:${stderrBytes}`));
    });
    child.stdin.end(stdin, "utf8");
  });
}

function beijingTimestamp(milliseconds) {
  const parts = new Intl.DateTimeFormat("sv-SE", {timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"}).format(new Date(milliseconds));
  return parts;
}
