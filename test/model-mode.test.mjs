import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,rm,stat,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ModelMode} from "../src/core/model-mode.mjs";

test("model mode persists only the selected two-state value with private permissions",async () => {
  const root=await mkdtemp(join(tmpdir(),"llw-model-mode-"));
  const file=join(root,"private","model");
  try {
    const mode=new ModelMode(file);
    await mode.write("deepseek");
    assert.equal(await readFile(file,"utf8"),"deepseek\n");
    assert.equal(await mode.read(),"deepseek");
    assert.equal(((await stat(join(root,"private"))).mode&0o777),0o700);
    assert.equal((await stat(file)).mode&0o777,0o600);
    assert.equal(await new ModelMode(file).read(),"deepseek");
    await assert.rejects(()=>mode.write("auto"),/invalid_model_mode/);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("missing or corrupt model mode recovers to Codex",async () => {
  const root=await mkdtemp(join(tmpdir(),"llw-model-mode-recovery-"));
  const file=join(root,"model");
  try {
    const mode=new ModelMode(file);
    assert.equal(await mode.read(),"codex");
    await writeFile(file,"hybrid\n",{mode:0o600});
    assert.equal(await mode.read(),"codex");
  } finally { await rm(root,{recursive:true,force:true}); }
});
