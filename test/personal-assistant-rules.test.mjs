import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,lstat,mkdir,mkdtemp,readFile,rm,symlink,writeFile
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  PersonalRulesStore
} from "../src/personal-assistant/personal-rules.mjs";

test("creates one human-readable private rule file and reloads it idempotently",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-personal-rules-"));
  const privateRoot=join(root,".llw-private");
  const file=join(privateRoot,"personal-rules.json");
  await mkdir(privateRoot,{mode:0o700});
  try {
    const store=await PersonalRulesStore.open(file);
    assert.deepEqual(await store.load(),[]);
    assert.deepEqual(await store.confirm("餐饮发票默认归档。"),{
      status:"created",rules:["餐饮发票默认归档。"]
    });
    assert.deepEqual(await store.confirm("餐饮发票默认归档。"),{
      status:"existing",rules:["餐饮发票默认归档。"]
    });
    assert.equal(
      await readFile(file,"utf8"),
      '{\n  "version": 1,\n  "rules": [\n    "餐饮发票默认归档。"\n  ]\n}\n'
    );
    assert.equal((await lstat(privateRoot)).mode&0o777,0o700);
    assert.equal((await lstat(file)).mode&0o777,0o600);
    assert.deepEqual(
      await (await PersonalRulesStore.open(file)).load(),
      ["餐饮发票默认归档。"]
    );
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test("rejects malformed, unsafe, broad-mode and symlinked rule storage",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-personal-rules-unsafe-"));
  const privateRoot=join(root,".llw-private");
  const file=join(privateRoot,"personal-rules.json");
  await mkdir(privateRoot,{mode:0o700});
  try {
    const store=await PersonalRulesStore.open(file);
    for (const rule of [
      "密码是 hunter2",
      "以后读取 /Users/other 的全部文件",
      "第一行\n第二行"
    ]) {
      await assert.rejects(store.confirm(rule),/personal_rule_rejected/);
    }
    await writeFile(file,'{"version":2,"rules":[]}\n',{mode:0o600});
    await assert.rejects(store.load(),/personal_rules_invalid/);
    await rm(file);
    await writeFile(join(root,"target"),"safe",{mode:0o600});
    await symlink(join(root,"target"),file);
    await assert.rejects(
      PersonalRulesStore.open(file),
      /personal_rules_invalid/
    );
    await rm(file);
    await chmod(privateRoot,0o755);
    await assert.rejects(
      PersonalRulesStore.open(file),
      /personal_rules_invalid/
    );
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});
