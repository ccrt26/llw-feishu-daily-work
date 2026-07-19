import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { invokeCodex, validateAction } from "../src/codex-client.mjs";

const fixture = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
const sourceText = "今天完成了方案评审";

function record(originalText = sourceText) {
  return {
    occurred_date: "2026-07-19",
    occurred_time: "10:00",
    occurred_end_time: "11:00",
    title: "方案评审",
    people: [],
    location: "",
    summary: "完成方案评审。",
    follow_ups: [],
    original_text: originalText
  };
}

function createDecision(text = sourceText) {
  return {action: "create_record", confidence: "high", reason: "明确新工作", question: "", source_text: text, target_record_id: "", records: [record(text)]};
}

test("validates all four contextual operations", () => {
  assert.equal(validateAction(createDecision(), {sourceText, candidateIds: [], allowedOriginalTexts: [sourceText]}).action, "create_record");

  const prior = "我补充一下，参会人员包括江苏区销售。";
  const clarification = "补充昨天那场会议";
  const supplement = {
    action: "supplement_record", confidence: "high", reason: "唯一候选", question: "",
    source_text: clarification, target_record_id: "90f29b02eb9ec9bb", records: [record(prior)]
  };
  assert.equal(validateAction(supplement, {
    sourceText: clarification, candidateIds: ["90f29b02eb9ec9bb"], allowedOriginalTexts: [prior, clarification]
  }).action, "supplement_record");

  const ask = {action: "ask_user", confidence: "low", reason: "目标不唯一", question: "补充哪场会议？", source_text: sourceText, target_record_id: "", records: []};
  assert.equal(validateAction(ask, {sourceText, candidateIds: [], allowedOriginalTexts: [sourceText]}).question, "补充哪场会议？");

  const ignore = {action: "ignore", confidence: "high", reason: "普通对话", question: "", source_text: sourceText, target_record_id: "", records: []};
  assert.equal(validateAction(ignore, {sourceText, candidateIds: [], allowedOriginalTexts: [sourceText]}).action, "ignore");
});

test("rejects unsafe action shapes and fabricated original text", () => {
  assert.throws(() => validateAction({...createDecision(), intent: "daily_work"}, {sourceText, candidateIds: [], allowedOriginalTexts: [sourceText]}), /unknown_decision_field/);
  assert.throws(() => validateAction({...createDecision(), confidence: "medium"}, {sourceText, candidateIds: [], allowedOriginalTexts: [sourceText]}), /unsafe_write_confidence/);
  assert.throws(() => validateAction({...createDecision(), target_record_id: "90f29b02eb9ec9bb"}, {sourceText, candidateIds: ["90f29b02eb9ec9bb"], allowedOriginalTexts: [sourceText]}), /unexpected_target/);
  assert.throws(() => validateAction({
    action: "supplement_record", confidence: "high", reason: "猜测", question: "", source_text: sourceText,
    target_record_id: "ffffffffffffffff", records: [record()]
  }, {sourceText, candidateIds: ["90f29b02eb9ec9bb"], allowedOriginalTexts: [sourceText]}), /target_not_in_candidates/);
  assert.throws(() => validateAction({...createDecision(), source_text: "改写"}, {sourceText, candidateIds: [], allowedOriginalTexts: [sourceText]}), /source_text_mismatch/);
  const fabricated = createDecision();
  fabricated.records[0].original_text = "不存在的原文";
  assert.throws(() => validateAction(fabricated, {sourceText, candidateIds: [], allowedOriginalTexts: [sourceText]}), /original_text_mismatch/);
  assert.throws(() => validateAction({action: "ask_user", confidence: "low", reason: "不足", question: "", source_text: sourceText, target_record_id: "", records: []}, {sourceText, candidateIds: [], allowedOriginalTexts: [sourceText]}), /question_required/);
});

test("invokes Codex read-only and sends only sanitized context on stdin", async () => {
  const root = await mkdtemp(join(tmpdir(), "llw-codex-"));
  const skillRoot = join(root, ".agents", "skills", "feishu-daily-work");
  await mkdir(join(skillRoot, "references"), {recursive: true});
  await writeFile(join(skillRoot, "references", "output-schema.json"), "{}");
  await chmod(fixture, 0o755);
  const argsFile = join(root, "args.json");
  const stdinFile = join(root, "stdin.txt");
  const message = {text: sourceText, createTime: 1784426400000, messageId: "m-secret"};
  const conversation = {id: "c-secret", status: "open", candidateIds: ["90f29b02eb9ec9bb"], turns: [
    {role: "user", text: "上一条用户原文", createTime: 1784426300000, messageId: "m-prior"},
    {role: "assistant", text: "请补充说明"}
  ]};
  const candidates = [{record_id: "90f29b02eb9ec9bb", date: "2026-07-18", occurred_time: "", occurred_end_time: "", title: "会议", people: [], location: "线上", summary: "召开会议。", follow_ups: []}];
  const result = await invokeCodex({
    codexPath: fixture, workspaceRoot: root, skillRoot, message, conversation, candidates,
    environment: {...process.env, FAKE_ARGS_FILE: argsFile, FAKE_STDIN_FILE: stdinFile, FAKE_RESPONSE: JSON.stringify(createDecision())}
  });
  assert.equal(result.action, "create_record");
  const args = JSON.parse(await readFile(argsFile, "utf8"));
  assert.deepEqual(args.slice(0, 5), ["exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check"]);
  assert.ok(args.includes("--output-schema"));
  assert.ok(args.includes("--output-last-message"));
  assert.equal(args.at(-1), "-");
  assert.equal(args.some(value => value.includes(sourceText)), false);
  const prompt = await readFile(stdinFile, "utf8");
  assert.match(prompt, /\$feishu-daily-work/);
  assert.match(prompt, /CONTEXT_JSON/);
  assert.match(prompt, new RegExp(sourceText));
  assert.match(prompt, /上一条用户原文/);
  assert.match(prompt, /90f29b02eb9ec9bb/);
  assert.equal(prompt.includes("m-secret"), false);
  assert.equal(prompt.includes("m-prior"), false);
  assert.equal(prompt.includes("c-secret"), false);
});
