import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, mkdir, readFile, rm, stat, symlink, utimes, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {downloadLarkResource,scavengeInvoiceTempRoot} from "../src/adapters/lark-resource-downloader.mjs";

const cliPath = resolve("test/fixtures/fake-lark-cli.mjs");

async function run(mode = "one", overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "llw-download-test-"));
  const argsFile = join(root, "args.json");
  const {environment: extraEnvironment = {}, ...otherOverrides} = overrides;
  try {
    const result = await downloadLarkResource({
      cliPath, profile:"llw", messageId:"om_abc", fileKey:"img_xyz", type:"image",
      tempRoot:join(root,"jobs"), timeoutMs:2_000,
      environment:{...process.env, FAKE_LARK_DOWNLOAD_MODE:mode, FAKE_LARK_ARGS:argsFile, ...extraEnvironment}, ...otherOverrides
    });
    return {root, argsFile, result};
  } catch (error) {
    await rm(root,{recursive:true,force:true});
    throw error;
  }
}

test("downloads through exact bot argv into a private relative cwd", async () => {
  const envFile = join(tmpdir(), `llw-download-env-${process.pid}-${Date.now()}.json`);
  const launchAgentPath = "/usr/bin:/bin:/usr/sbin:/sbin";
  const {root,argsFile,result} = await run("one", {environment:{...process.env,PATH:launchAgentPath,FAKE_LARK_DOWNLOAD_MODE:"one",FAKE_LARK_ENV:envFile}});
  try {
    const args = JSON.parse(await readFile(argsFile,"utf8"));
    assert.deepEqual(args,["--profile","llw","im","+messages-resources-download","--as","bot","--message-id","om_abc","--file-key","img_xyz","--type","image","--output","attachment"]);
    assert.equal(args.includes(result.file),false);
    assert.equal((await stat(result.tempDir)).mode & 0o777,0o700);
    assert.equal((await stat(result.file)).isFile(),true);
    assert.deepEqual(JSON.parse(await readFile(envFile,"utf8")),{
      noProxy:"1", noUpdateNotifier:"1", noSkillsNotifier:"1",
      path:`/usr/local/bin:${launchAgentPath}`
    });
  } finally {
    await rm(root,{recursive:true,force:true});
    await rm(envFile,{force:true});
  }
});

test("retries one transient lark-cli download failure and then succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(),"llw-download-retry-"));
  const attemptsFile = join(root,"attempts.txt");
  try {
    const result = await downloadLarkResource({
      cliPath,profile:"llw",messageId:"om_abc",fileKey:"file_xyz",type:"file",
      tempRoot:join(root,"jobs"),timeoutMs:2_000,maxAttempts:3,retryDelayMs:1,
      environment:{...process.env,FAKE_LARK_DOWNLOAD_MODE:"transient",FAKE_LARK_ATTEMPTS:attemptsFile}
    });
    assert.equal(await readFile(attemptsFile,"utf8"),"2");
    assert.equal((await stat(result.file)).isFile(),true);
    await rm(result.tempDir,{recursive:true,force:true});
  } finally { await rm(root,{recursive:true,force:true}); }
});

for (const [mode,code] of [["zero","download_output_count"],["two","download_output_count"],["symlink","download_output_unsafe"],["exit","download_failed"],["hang","download_timeout"]]) {
  test(`cleans temporary directory on ${mode}`, async () => {
    const root = await mkdtemp(join(tmpdir(),"llw-download-fail-"));
    const tempRoot = join(root,"jobs");
    await assert.rejects(downloadLarkResource({cliPath,profile:"llw",messageId:"om_abc",fileKey:"file_xyz",type:"file",tempRoot,timeoutMs:mode === "hang" ? 100 : 2_000,environment:{...process.env,FAKE_LARK_DOWNLOAD_MODE:mode}}), error => error.code === code);
    const entries = await import("node:fs/promises").then(fs => fs.readdir(tempRoot));
    assert.deepEqual(entries,[]);
    await rm(root,{recursive:true,force:true});
  });
}

test("startup scavenger removes only old safe job directories",async () => {
  const root=await mkdtemp(join(tmpdir(),"llw-scavenge-"));
  const old=join(root,"job-old"),fresh=join(root,"job-fresh"),unrelated=join(root,"other-old"),outside=join(root,"outside");
  await mkdir(old); await mkdir(fresh); await mkdir(unrelated); await mkdir(outside); await writeFile(join(outside,"keep"),"x");
  const past=new Date(Date.now()-25*60*60*1000); await utimes(old,past,past); await utimes(unrelated,past,past);
  await symlink(outside,join(root,"job-link"));
  await scavengeInvoiceTempRoot(root,{nowMs:Date.now()});
  const {readdir}=await import("node:fs/promises");
  assert.deepEqual((await readdir(root)).sort(),["job-fresh","job-link","other-old","outside"]);
  assert.equal(await readFile(join(outside,"keep"),"utf8"),"x");
  await rm(root,{recursive:true,force:true});
});
