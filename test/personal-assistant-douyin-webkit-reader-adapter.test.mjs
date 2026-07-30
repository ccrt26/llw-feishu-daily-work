import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {
  chmod,copyFile,mkdtemp,mkdir,readFile,readdir,rm,stat,writeFile
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import {
  createDouyinWebKitReaderAdapter
} from "../src/personal-assistant/douyin-webkit-reader-adapter.mjs";

const fake=fileURLToPath(
  new URL("./fixtures/fake-douyin-webkit-helper.mjs",import.meta.url)
);
const PAGE_URL=
  "https://www.douyin.com/video/7645139256003906842";
const MEDIA_ID="7645139256003906842";

test("runs the fixed helper without a shell and publishes verified private media",async()=>{
  const fixture=await readerFixture();
  const spawns=[];
  const reader=fixture.reader({
    spawnImpl(file,args,options) {
      spawns.push({file,args,options});
      return spawn(file,args,options);
    }
  });
  try {
    const result=await reader.read({
      url:PAGE_URL,workspaceDir:fixture.workspaceDir
    });

    assert.equal(result.mediaId,MEDIA_ID);
    assert.equal(result.canonicalUrl,PAGE_URL);
    assert.equal(result.durationMs,64_689);
    assert.equal(result.audio.detectedMime,"audio/mp4");
    assert.equal(result.audio.format,"m4a");
    assert.equal(result.video.detectedMime,"video/mp4");
    assert.equal(result.video.format,"mp4");
    assert.equal(result.video.width,1280);
    assert.equal(result.video.height,720);
    assert.equal((await stat(result.audio.file)).mode&0o777,0o600);
    assert.equal((await stat(result.video.file)).mode&0o777,0o600);
    assert.deepEqual(await readdir(fixture.tempRoot),[]);
    assert.equal(spawns.length,1);
    assert.equal(spawns[0].file,fake);
    assert.equal(spawns[0].options.shell,false);
    assert.equal(spawns[0].options.cwd,fixture.jobCwd);
    assert.deepEqual(spawns[0].options.stdio,["ignore","pipe","pipe"]);
    assert.equal(spawns[0].options.env.HOME,undefined);
    assert.ok(!JSON.stringify(result).includes("?"));
  } finally {
    await fixture.cleanup();
  }
});

for (const [mode,durationMs,limitations] of [
  ["complete_short",300_000,["bounded_video_prefix"]],
  ["over_two_hours_complete",7_200_001,[]],
  [
    "long_prefix",
    3_304_600,
    ["bounded_audio_prefix","bounded_video_prefix"]
  ]
]) {
  test(`preserves the exact ${mode} coverage limitations`,async()=>{
    const fixture=await readerFixture({mode});
    try {
      const result=await fixture.reader().read({
        url:PAGE_URL,workspaceDir:fixture.workspaceDir
      });
      assert.equal(result.durationMs,durationMs);
      assert.deepEqual(result.limitations,limitations);
      assert.equal(Object.isFrozen(result.limitations),true);
      assert.deepEqual(await readdir(fixture.tempRoot),[]);
    } finally {
      await fixture.cleanup();
    }
  });
}

test("rejects malformed Douyin URLs before inspecting or spawning the helper",async()=>{
  const invalid=[
    "http://www.douyin.com/video/7645139256003906842",
    "https://user@www.douyin.com/video/7645139256003906842",
    "https://www.douyin.com:444/video/7645139256003906842",
    "https://www.douyin.com/video/not-a-number",
    "https://www.douyin.com/video/7645139256003906842?from=copy",
    "https://www.douyin.com/video/7645139256003906842#fragment",
    "https://www.douyin.com/note/7645139256003906842",
    "https://v.douyin.com/abc/",
    "https://example.com/video/7645139256003906842"
  ];
  const fixture=await readerFixture();
  let spawnCalls=0;
  const reader=fixture.reader({
    spawnImpl() {
      spawnCalls++;
      throw new Error("must_not_spawn");
    }
  });
  try {
    for (const url of invalid) {
      await assert.rejects(
        reader.read({url,workspaceDir:fixture.workspaceDir}),
        error=>safe(error,"douyin_url_invalid"),
        url
      );
    }
    assert.equal(spawnCalls,0);
    assert.deepEqual(await readdir(fixture.tempRoot),[]);
  } finally {
    await fixture.cleanup();
  }
});

test("requires an owner-controlled executable with the exact configured hash",async()=>{
  const fixture=await readerFixture();
  try {
    const wrongHash=fixture.reader({helperSha256:"f".repeat(64)});
    await assert.rejects(
      wrongHash.read({url:PAGE_URL,workspaceDir:fixture.workspaceDir}),
      error=>safe(error,"douyin_helper_unavailable")
    );

    const unsafe=join(fixture.root,"unsafe-helper");
    await copyFile(fake,unsafe);
    await chmod(unsafe,0o777);
    const unsafeHash=await sha256File(unsafe);
    const unsafeReader=fixture.reader({
      helperPath:unsafe,helperSha256:unsafeHash
    });
    await assert.rejects(
      unsafeReader.read({url:PAGE_URL,workspaceDir:fixture.workspaceDir}),
      error=>safe(error,"douyin_helper_unavailable")
    );
    assert.deepEqual(await readdir(fixture.tempRoot),[]);
  } finally {
    await fixture.cleanup();
  }
});

for (const [mode,code] of [
  ["malformed","douyin_helper_invalid"],
  ["oversized_stdout","douyin_limit_exceeded"],
  ["path_escape","douyin_helper_invalid"],
  ["hash_mismatch","douyin_media_invalid"],
  ["missing_video","douyin_media_invalid"]
]) {
  test(`fails closed and cleans every helper artifact for ${mode}`,async()=>{
    const fixture=await readerFixture({mode});
    try {
      await assert.rejects(
        fixture.reader().read({
          url:PAGE_URL,workspaceDir:fixture.workspaceDir
        }),
        error=>safe(error,code)
      );
      assert.deepEqual(await readdir(fixture.tempRoot),[]);
      assert.deepEqual(await readdir(fixture.workspaceDir),[]);
    } finally {
      await fixture.cleanup();
    }
  });
}

test("terminates a timed-out helper and removes its private job",async()=>{
  const fixture=await readerFixture({mode:"sleep",timeoutMs:50});
  try {
    await assert.rejects(
      fixture.reader().read({
        url:PAGE_URL,workspaceDir:fixture.workspaceDir
      }),
      error=>safe(error,"douyin_media_unavailable")
    );
    assert.deepEqual(await readdir(fixture.tempRoot),[]);
    assert.deepEqual(await readdir(fixture.workspaceDir),[]);
  } finally {
    await fixture.cleanup();
  }
});

test("preserves a pre-existing destination and removes a newly published peer",async()=>{
  const fixture=await readerFixture();
  const existing=join(
    fixture.workspaceDir,`douyin-${MEDIA_ID}-video.mp4`
  );
  await writeFile(existing,"existing",{mode:0o600});
  try {
    await assert.rejects(
      fixture.reader().read({
        url:PAGE_URL,workspaceDir:fixture.workspaceDir
      }),
      error=>safe(error,"douyin_media_invalid")
    );
    assert.equal(await readFile(existing,"utf8"),"existing");
    assert.deepEqual(
      await readdir(fixture.workspaceDir),
      [`douyin-${MEDIA_ID}-video.mp4`]
    );
    assert.deepEqual(await readdir(fixture.tempRoot),[]);
  } finally {
    await fixture.cleanup();
  }
});

async function readerFixture({
  mode="ok",timeoutMs=2_000
}={}) {
  const root=await mkdtemp(join(tmpdir(),"llw-douyin-reader-"));
  const workspaceDir=join(root,"workspace");
  const tempRoot=join(root,"jobs");
  const jobCwd=join(root,"cwd");
  await mkdir(workspaceDir,{mode:0o700});
  await mkdir(tempRoot,{mode:0o700});
  await mkdir(jobCwd,{mode:0o700});
  await chmod(workspaceDir,0o700);
  await chmod(tempRoot,0o700);
  await chmod(jobCwd,0o700);
  await chmod(fake,0o700);
  const helperSha256=await sha256File(fake);
  return {
    root,workspaceDir,tempRoot,jobCwd,
    reader(overrides={}) {
      return createDouyinWebKitReaderAdapter({
        helperPath:fake,
        helperSha256,
        tempRoot,
        jobCwd,
        timeoutMs,
        helperEnvironment:{
          LLW_FAKE_DOUYIN_MODE:mode,
          PATH:`${dirname(process.execPath)}:/usr/bin:/bin`
        },
        ...overrides
      });
    },
    async cleanup() {
      await rm(root,{recursive:true,force:true});
    }
  };
}

async function sha256File(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

function safe(error,code) {
  return error?.message===code&&Object.keys(error).length===0;
}
