import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { invokeCodex, validateDecision } from "../src/codex-client.mjs";

const fixture = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));

function decision(text) {
  return {
    intent: "daily_work", confidence: "high", evidence: "明确工作事实", question: "", source_text: text,
    records: [{occurred_date: "2026-07-19", occurred_time: "10:00", title: "评审", people: [], location: "", summary: "完成评审。", follow_ups: [], original_text: text}]
  };
}

test("invokes Codex read-only with schema and sends user text only on stdin", async () => {
  const root = await mkdtemp(join(tmpdir(), "llw-codex-"));
  const skillRoot = join(root, ".agents", "skills", "feishu-daily-work");
  await mkdir(join(skillRoot, "references"), {recursive: true});
  await writeFile(join(skillRoot, "references", "output-schema.json"), "{}");
  await chmod(fixture, 0o755);
  const argsFile = join(root, "args.json");
  const stdinFile = join(root, "stdin.txt");
  const text = "今天完成了方案评审";
  const result = await invokeCodex({
    codexPath: fixture, workspaceRoot: root, skillRoot, text, createTime: 1784426400000,
    environment: {...process.env, FAKE_ARGS_FILE: argsFile, FAKE_STDIN_FILE: stdinFile, FAKE_RESPONSE: JSON.stringify(decision(text))}
  });
  assert.equal(result.intent, "daily_work");
  const args = JSON.parse(await readFile(argsFile, "utf8"));
  assert.deepEqual(args.slice(0, 5), ["exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check"]);
  assert.ok(args.includes("--output-schema"));
  assert.ok(args.includes("--output-last-message"));
  assert.equal(args.at(-1), "-");
  assert.equal(args.some(value => value.includes(text)), false);
  const prompt = await readFile(stdinFile, "utf8");
  assert.match(prompt, /\$feishu-daily-work/);
  assert.match(prompt, /北京时间/);
  assert.match(prompt, new RegExp(text));
});

test("rejects rewritten source or fabricated original", () => {
  const text = "原始文字";
  assert.throws(() => validateDecision({...decision(text), source_text: "改写文字"}, text), /source_text_mismatch/);
  const bad = decision(text);
  bad.records[0].original_text = "不存在的内容";
  assert.throws(() => validateDecision(bad, text), /original_text_mismatch/);
});

test("normalizes an empty uncertain question and forbids records for other", () => {
  const uncertain = validateDecision({intent: "uncertain", confidence: "low", evidence: "不足", question: "", source_text: "不清楚", records: []}, "不清楚");
  assert.equal(uncertain.question, "这段内容是否需要作为工作记录入库？");
  assert.throws(() => validateDecision({...decision("谢谢"), intent: "other"}, "谢谢"), /unexpected_records/);
});
