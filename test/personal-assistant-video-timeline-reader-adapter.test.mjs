import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {
  chmod,copyFile,mkdtemp,mkdir,readFile,readdir,rm,stat,writeFile
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";

const fakeSource=fileURLToPath(
  new URL("./fixtures/fake-video-timeline-helper.mjs",import.meta.url)
);

test("publishes verified contact sheets covering the complete timeline",async()=>{
  const fixture=await readerFixture();
  try {
    const reader=await fixture.reader();
    const result=await reader.read({
      sourceId:"source-001",
      videoFile:fixture.videoFile,
      videoSha256:fixture.videoSha256,
      durationMs:12_000,
      workspaceDir:fixture.workspaceDir
    });

    assert.equal(result.durationMs,12_000);
    assert.equal(result.sampleCount,3);
    assert.equal(result.maxGapMs,4_000);
    assert.deepEqual(result.samples,[
      {startMs:0,endMs:4_000,sampleMs:2_000},
      {startMs:4_000,endMs:8_000,sampleMs:6_000},
      {startMs:8_000,endMs:12_000,sampleMs:10_000}
    ]);
    assert.deepEqual(result.images,[{
      sourceId:"source-001",
      relativePath:"source-001.timeline-001.png",
      sha256:result.images[0].sha256,
      startMs:0,
      endMs:12_000
    }]);
    assert.equal((await stat(
      join(fixture.workspaceDir,result.images[0].relativePath)
    )).mode&0o777,0o600);
    assert.deepEqual(await readdir(fixture.tempRoot),[]);
    assert.deepEqual(
      result.limitations,
      ["uniform_timeline_sampling","not_frame_by_frame"]
    );
  } finally {
    await fixture.cleanup();
  }
});

for (const [mode,code,limits] of [
  ["missing_tail","video_timeline_helper_invalid",{}],
  ["out_of_order","video_timeline_helper_invalid",{}],
  ["path_escape","video_timeline_helper_invalid",{}],
  ["wrong_hash","video_timeline_media_invalid",{}],
  ["too_many_images","video_timeline_limit_exceeded",{}],
  ["wide_image","video_timeline_limit_exceeded",{maxDimension:2}],
  ["too_many_bytes","video_timeline_limit_exceeded",{maxTotalBytes:64}]
]) {
  test(`fails closed and cleans helper artifacts for ${mode}`,async()=>{
    const fixture=await readerFixture({mode});
    try {
      const reader=await fixture.reader(limits);
      await assert.rejects(
        reader.read({
          sourceId:"source-001",
          videoFile:fixture.videoFile,
          videoSha256:fixture.videoSha256,
          durationMs:12_000,
          workspaceDir:fixture.workspaceDir
        }),
        error=>error?.message===code
      );
      assert.deepEqual(await readdir(fixture.tempRoot),[]);
      assert.deepEqual(
        await readdir(fixture.workspaceDir),
        ["source-video.mp4"]
      );
    } finally {
      await fixture.cleanup();
    }
  });
}

test("rejects a wrong source hash before spawning the helper",async()=>{
  const fixture=await readerFixture();
  try {
    const reader=await fixture.reader();
    await assert.rejects(
      reader.read({
        sourceId:"source-001",
        videoFile:fixture.videoFile,
        videoSha256:"f".repeat(64),
        durationMs:12_000,
        workspaceDir:fixture.workspaceDir
      }),
      error=>error?.message==="video_timeline_input_invalid"
    );
    assert.deepEqual(await readdir(fixture.tempRoot),[]);
  } finally {
    await fixture.cleanup();
  }
});

async function readerFixture({mode="ok"}={}) {
  const root=await mkdtemp(join(tmpdir(),"llw-video-timeline-adapter-"));
  const workspaceDir=join(root,"workspace");
  const tempRoot=join(root,"jobs");
  const jobCwd=join(root,"cwd");
  const helperPath=join(root,"video-timeline-helper");
  const videoFile=join(workspaceDir,"source-video.mp4");
  await Promise.all([
    mkdir(workspaceDir,{mode:0o700}),
    mkdir(tempRoot,{mode:0o700}),
    mkdir(jobCwd,{mode:0o700})
  ]);
  await Promise.all([
    chmod(root,0o700),
    chmod(workspaceDir,0o700),
    chmod(tempRoot,0o700),
    chmod(jobCwd,0o700)
  ]);
  await copyFile(fakeSource,helperPath);
  await chmod(helperPath,0o700);
  await writeFile(videoFile,Buffer.from("synthetic-private-video"),{
    mode:0o600
  });
  const helperSha256=sha256(await readFile(helperPath));
  const videoSha256=sha256(await readFile(videoFile));
  return {
    root,workspaceDir,tempRoot,jobCwd,helperPath,
    videoFile,videoSha256,
    async reader(overrides={}) {
      const {createVideoTimelineReaderAdapter}=await import(
        "../src/personal-assistant/video-timeline-reader-adapter.mjs"
      );
      return createVideoTimelineReaderAdapter({
        helperPath,
        helperSha256,
        tempRoot,
        jobCwd,
        timeoutMs:2_000,
        helperEnvironment:{
          LLW_FAKE_TIMELINE_MODE:mode,
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
