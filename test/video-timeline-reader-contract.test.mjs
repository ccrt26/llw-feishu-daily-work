import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {
  chmod,copyFile,mkdtemp,mkdir,readFile,readdir,rm,stat
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

const execFileAsync=promisify(execFile);
const source=fileURLToPath(
  new URL("../native/video-timeline-reader/main.m",import.meta.url)
);
const fixtureScript=fileURLToPath(
  new URL("../scripts/create-v410-media-fixtures.mjs",import.meta.url)
);

test("samples a private video from start through end into bounded sheets",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-video-timeline-native-"));
  const helper=join(root,"video-timeline-reader");
  const fixtureRoot=join(root,"fixture");
  const outputDir=join(root,"output");
  const rangeOutputDir=join(root,"range-output");
  const input=join(root,"input.mp4");
  try {
    await chmod(root,0o700);
    await Promise.all([
      mkdir(outputDir,{mode:0o700}),
      mkdir(rangeOutputDir,{mode:0o700})
    ]);
    await Promise.all([
      chmod(outputDir,0o700),
      chmod(rangeOutputDir,0o700)
    ]);
    await execFileAsync("/usr/bin/xcrun",[
      "clang",
      "-fobjc-arc",
      "-Wall",
      "-Wextra",
      "-framework","Foundation",
      "-framework","AppKit",
      "-framework","AVFoundation",
      "-framework","CoreMedia",
      "-framework","CoreText",
      "-framework","ImageIO",
      source,
      "-o",helper
    ],{
      cwd:dirname(source),
      timeout:30_000,
      maxBuffer:1024*1024
    });
    await chmod(helper,0o700);
    await execFileAsync(process.execPath,[fixtureScript,fixtureRoot],{
      cwd:root,
      timeout:120_000,
      maxBuffer:1024*1024
    });
    await copyFile(join(fixtureRoot,"visual-facts.mov"),input);
    await chmod(input,0o600);

    const {stdout,stderr}=await execFileAsync(helper,[
      "--video",input,
      "--output-dir",outputDir,
      "--expected-duration-ms","12000"
    ],{
      cwd:root,
      env:{
        PATH:"/usr/bin:/bin",
        LANG:"en_US.UTF-8",
        LC_ALL:"en_US.UTF-8",
        TMPDIR:root
      },
      timeout:30_000,
      maxBuffer:1024*1024
    });
    assert.equal(stderr,"");
    const result=JSON.parse(stdout);
    assert.equal(result.status,"ok");
    assert.equal(result.contract,"video_timeline_reader_v1");
    assert.equal(result.durationMs,12_000);
    assert.equal(result.sampleCount,3);
    assert.equal(result.maxGapMs,4_000);
    assert.deepEqual(result.samples,[
      {startMs:0,endMs:4_000,sampleMs:2_000},
      {startMs:4_000,endMs:8_000,sampleMs:6_000},
      {startMs:8_000,endMs:12_000,sampleMs:10_000}
    ]);
    assert.equal(result.sheets.length,1);
    assert.equal(result.sheets[0].startMs,0);
    assert.equal(result.sheets[0].endMs,12_000);
    assert.equal(result.sheets[0].firstSampleIndex,0);
    assert.equal(result.sheets[0].lastSampleIndex,2);
    assert.ok(result.sheets[0].width<=3508);
    assert.ok(result.sheets[0].height<=3508);
    const sheet=join(outputDir,result.sheets[0].relativePath);
    assert.equal((await stat(sheet)).mode&0o777,0o600);
    const bytes=await readFile(sheet);
    assert.deepEqual(
      [...bytes.subarray(0,8)],
      [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]
    );
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      result.sheets[0].sha256
    );
    assert.deepEqual(await readdir(outputDir),["timeline-001.png"]);

    const rangeRun=await execFileAsync(helper,[
      "--video",input,
      "--output-dir",rangeOutputDir,
      "--expected-duration-ms","12000",
      "--start-ms","5000",
      "--end-ms","7000"
    ],{
      cwd:root,
      env:{
        PATH:"/usr/bin:/bin",
        LANG:"en_US.UTF-8",
        LC_ALL:"en_US.UTF-8",
        TMPDIR:root
      },
      timeout:30_000,
      maxBuffer:1024*1024
    });
    assert.equal(rangeRun.stderr,"");
    const range=JSON.parse(rangeRun.stdout);
    assert.equal(range.status,"ok");
    assert.equal(range.contract,"video_time_range_reader_v1");
    assert.equal(range.durationMs,12_000);
    assert.equal(range.startMs,5_000);
    assert.equal(range.endMs,7_000);
    assert.equal(range.sampleCount,1);
    assert.equal(range.maxGapMs,2_000);
    assert.deepEqual(range.samples,[
      {startMs:5_000,endMs:7_000,sampleMs:6_000}
    ]);
    assert.equal(range.sheets.length,1);
    assert.equal(range.sheets[0].startMs,5_000);
    assert.equal(range.sheets[0].endMs,7_000);
    assert.deepEqual(
      range.limitations,
      ["uniform_range_sampling","not_frame_by_frame"]
    );
    assert.deepEqual(await readdir(rangeOutputDir),[
      "timeline-001.png"
    ]);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});
