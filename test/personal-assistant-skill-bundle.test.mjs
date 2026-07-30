import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {
  mkdir,mkdtemp,rm,writeFile
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

const SKILL=Buffer.from(
  "---\nname: llw-personal-assistant\n---\n# Canonical Skill\n"
);
const REFERENCE=Buffer.from("# Canonical conversation reference\n");
const APPLE_DOUBLE=Buffer.from("AppleDouble fixture marker\n");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("loads only manifest-authorized Skill files and ignores AppleDouble metadata",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-pa-skill-bundle-"));
  const skillRoot=join(root,"llw-personal-assistant");
  const references=join(skillRoot,"references");
  try {
    await mkdir(references,{recursive:true,mode:0o700});
    await writeFile(join(skillRoot,"SKILL.md"),SKILL,{mode:0o600});
    await writeFile(
      join(skillRoot,"._SKILL.md"),APPLE_DOUBLE,{mode:0o600}
    );
    await writeFile(
      join(references,"conversation.md"),REFERENCE,{mode:0o600}
    );
    await writeFile(
      join(references,"._conversation.md"),APPLE_DOUBLE,{mode:0o600}
    );
    let module;
    try {
      module=await import(
        "../src/personal-assistant/skill-bundle.mjs"
      );
    } catch {}
    assert.equal(
      typeof module?.loadPersonalAssistantSkillBundle,
      "function"
    );
    const result=await module.loadPersonalAssistantSkillBundle({
      skillRoot,
      runtimeFiles:[
        {path:"SKILL.md",sha256:sha256(SKILL)},
        {
          path:"references/conversation.md",
          sha256:sha256(REFERENCE)
        }
      ]
    });
    assert.equal(result.fileCount,2);
    assert.equal(
      result.totalBytes,
      SKILL.length+REFERENCE.length
    );
    assert.match(result.content,/Canonical Skill/u);
    assert.match(result.content,/Canonical conversation reference/u);
    assert.doesNotMatch(result.content,/AppleDouble fixture marker/u);
    assert.match(result.sha256,/^[a-f0-9]{64}$/u);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});
