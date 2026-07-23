import test from "node:test";
import assert from "node:assert/strict";
import {access,chmod,mkdtemp,mkdir,readFile,rm,stat,symlink,writeFile} from "node:fs/promises";
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

test("unsafe state parents recover to Codex and failed replacement removes its temporary file",async () => {
  const root=await mkdtemp(join(tmpdir(),"llw-model-mode-safe-"));
  const parent=join(root,"private"); const file=join(parent,"model");
  try {
    await mkdir(parent,{mode:0o700}); await writeFile(file,"deepseek\n",{mode:0o600}); await chmod(parent,0o755);
    assert.equal(await new ModelMode(file).read(),"codex");
    await chmod(parent,0o700);
    let temporary;
    const mode=new ModelMode(file,{renameFile:async source=>{temporary=source;throw new Error("rename_failed");}});
    await assert.rejects(()=>mode.write("codex"),/rename_failed/);
    await assert.rejects(()=>access(temporary));
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("refuses symlinked ancestors instead of replacing their target files",async () => {
  const root=await mkdtemp(join(tmpdir(),"llw-model-mode-link-")); const target=join(root,"target"),alias=join(root,"alias");
  try {
    await mkdir(target,{mode:0o700}); await symlink(target,alias);
    const file=join(alias,"model-state");
    await assert.rejects(()=>new ModelMode(file).write("deepseek"),/unsafe_model_state_path/);
    await assert.rejects(()=>access(join(target,"model-state")));
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("refuses a nested symlink ancestor without changing the protected target",async () => {
  const root=await mkdtemp(join(tmpdir(),"llw-model-mode-nested-link-")); const target=join(root,"target"),nested=join(target,"nested"),alias=join(root,"alias");
  try {
    await mkdir(nested,{recursive:true,mode:0o700}); await symlink(target,alias);
    const protectedFile=join(nested,"model-state"); await writeFile(protectedFile,"deepseek\n",{mode:0o600});
    const mode=new ModelMode(join(alias,"nested","model-state"));
    assert.equal(await mode.read(),"codex");
    await assert.rejects(()=>mode.write("codex"),/unsafe_model_state_path/);
    assert.equal(await readFile(protectedFile,"utf8"),"deepseek\n");
  } finally { await rm(root,{recursive:true,force:true}); }
});
