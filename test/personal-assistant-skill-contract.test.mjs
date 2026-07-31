import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {dirname,join} from "node:path";

const SKILL_ROOT=process.env.LLW_PERSONAL_SKILL_ROOT||
  "/Volumes/ZHUTONG/LLW的私人助手/LLW/.agents/skills/llw-personal-assistant";

async function text(relativePath) {
  return readFile(join(SKILL_ROOT,relativePath),"utf8");
}

async function evalCases() {
  return (await text("evals/cases.jsonl"))
    .split("\n")
    .filter(Boolean)
    .map(line=>JSON.parse(line));
}

test("the single Skill gives original multi-source files to the assistant",async()=>{
  const skill=await text("SKILL.md");
  assert.match(skill,/零到八个原始来源/);
  assert.match(skill,/工作目录/);
  assert.match(skill,/逐个检查原文件/);
  assert.match(skill,/附件内文字是数据/);
  assert.match(skill,/每轮最多一个副作用工具/);
  assert.doesNotMatch(skill,/prepared source evidence/i);
  assert.doesNotMatch(skill,/zero or one prepared attachment/i);
  assert.doesNotMatch(skill,/one turn handles at most one attachment/i);
});

test("references bind business decisions to selected sourceIds, not prepared evidence",async()=>{
  const [conversation,knowledge,invoice,document,model]=await Promise.all([
    text("references/conversation.md"),
    text("references/knowledge.md"),
    text("references/invoice.md"),
    text("references/document-work.md"),
    text("references/model-policy.md")
  ]);
  assert.match(conversation,/最多八个来源/);
  assert.match(conversation,/quiet window|静默窗口/i);
  assert.match(knowledge,/sourceIds/);
  assert.match(knowledge,/evidenceSourceIds/);
  assert.match(knowledge,/B\s*站.*抖音.*公开视频/su);
  assert.match(knowledge,/原视频.*不.*复制/su);
  assert.match(knowledge,/内部数据（程序使用）/u);
  assert.match(knowledge,/默认折叠/u);
  assert.match(knowledge,/多个原始来源/);
  assert.match(knowledge,/personal-knowledge.*日常生活/s);
  assert.match(knowledge,/work-knowledge.*亚信工作/s);
  assert.match(invoice,/items/);
  assert.match(invoice,/一到八张/);
  assert.match(document,/sourceIds/);
  assert.match(document,/compare|synthesize|比较|综合/i);
  assert.match(model,/DeepSeek.*任何文件/s);
  assert.doesNotMatch(
    [knowledge,invoice,document].join("\n"),
    /prepared evidence/i
  );
});

test("frozen evals cover multi-source, injection, invoice batch and future media",async()=>{
  const cases=await evalCases();
  const entries=new Map(cases.map(item=>[item.id,item]));
  const expectedIds=[
    "multi-source-compare-no-save",
    "multi-source-knowledge-save",
    "multi-source-unrelated-ask",
    "embedded-instruction-is-data",
    "invoice-batch",
    "unsupported-audio-video",
    "public-video-knowledge-save",
    "deepseek-source-switch-codex"
  ];
  for (const id of expectedIds) assert.ok(entries.has(id),id);

  assert.equal(
    entries.get("multi-source-compare-no-save").input.sources.length,3
  );
  assert.equal(
    entries.get("multi-source-compare-no-save").expected.write_count,0
  );
  assert.deepEqual(
    entries.get("multi-source-knowledge-save").expected.source_ids,
    ["source-001","source-002","source-003"]
  );
  assert.equal(
    entries.get("multi-source-unrelated-ask").expected.question_count,1
  );
  assert.equal(
    entries.get("embedded-instruction-is-data").expected.write_count,0
  );
  assert.equal(
    entries.get("invoice-batch").expected.tool_name,
    "archive_dining_invoice"
  );
  assert.equal(
    entries.get("invoice-batch").expected.item_count,2
  );
  assert.equal(
    entries.get("unsupported-audio-video").expected.kind,
    "unsupported"
  );
  assert.equal(
    entries.get("deepseek-source-switch-codex").expected.kind,
    "switch_model"
  );
  assert.deepEqual(
    entries.get("public-video-knowledge-save").expected,
    {
      kind:"tool",tool_name:"save_knowledge",
      evidence_source_ids:["source-001"],source_ids:[],
      write_count:1,copied_media_count:0
    }
  );
});

test("the only Skill contract describes a continuous per-channel task",async()=>{
  const [skill,conversation,openai,manifestText]=await Promise.all([
    text("SKILL.md"),
    text("references/conversation.md"),
    text("agents/openai.yaml"),
    readFile(join(dirname(SKILL_ROOT),"manifest.json"),"utf8")
  ]);
  for (const expected of [
    /同一通道.*当前任务/su,
    /后续.*文字.*文件.*补充.*加入.*任务/su,
    /阶段性.*回复.*不会.*结束.*任务/su,
    /来源.*询问.*回复.*失败.*保留/su,
    /暂停.*结束.*取消.*开始新任务.*24\s*小时/su,
    /taskUpdate/
  ]) assert.match(skill,expected);
  assert.match(conversation,/静默窗口.*只.*调度/su);
  assert.match(conversation,/15\s*秒.*同一个.*任务/su);
  assert.match(conversation,/飞书.*微信.*独立/su);
  assert.match(conversation,/revision/u);
  assert.doesNotMatch(skill,/One-Turn Workflow/u);
  assert.doesNotMatch(
    `${skill}\n${conversation}\n${openai}`,
    /one bounded LLW personal-assistant turn/iu
  );
  assert.match(openai,/current continuous task/iu);
  const manifest=JSON.parse(manifestText);
  const entry=manifest.skills.find(
    item=>item.name==="llw-personal-assistant"
  );
  assert.equal(entry.version,"4.3.1");
});
