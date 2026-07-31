import test from "node:test";
import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {
  chmod,mkdtemp,mkdir,readFile,rm
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

const execFileAsync=promisify(execFile);
const source=fileURLToPath(
  new URL("../native/douyin-webkit-reader/main.m",import.meta.url)
);
const coverageSource=fileURLToPath(
  new URL(
    "../native/douyin-webkit-reader/media-coverage.c",
    import.meta.url
  )
);
const coverageHarnessSource=fileURLToPath(
  new URL(
    "./fixtures/douyin-media-coverage-harness.c",
    import.meta.url
  )
);
const PAGE_URL=
  "https://www.douyin.com/video/7645139256003906842";
let root;
let helper;
let coverageHarness;
let privateOutput;

test.before(async()=>{
  root=await mkdtemp(join(tmpdir(),"llw-douyin-native-contract-"));
  helper=join(root,"douyin-webkit-reader");
  coverageHarness=join(root,"douyin-media-coverage");
  privateOutput=join(root,"private-output");
  await mkdir(privateOutput,{mode:0o700});
  await chmod(root,0o700);
  await chmod(privateOutput,0o700);
  await execFileAsync("/usr/bin/xcrun",[
    "clang",
    "-fobjc-arc",
    "-Wall",
    "-Wextra",
    "-framework","Foundation",
    "-framework","AppKit",
    "-framework","WebKit",
    "-framework","AVFoundation",
    "-framework","CoreMedia",
    source,
    coverageSource,
    "-o",helper
  ],{
    cwd:dirname(source),
    timeout:30_000,
    maxBuffer:1024*1024
  });
  await chmod(helper,0o700);
  await execFileAsync("/usr/bin/xcrun",[
    "clang",
    "-std=c17",
    "-Wall",
    "-Wextra",
    coverageHarnessSource,
    coverageSource,
    "-o",coverageHarness
  ],{
    cwd:dirname(source),
    timeout:30_000,
    maxBuffer:1024*1024
  });
  await chmod(coverageHarness,0o700);
});

test.after(async()=>{
  if (root) await rm(root,{recursive:true,force:true});
});

test("--help returns one safe bounded JSON contract without network work",async()=>{
  const result=await run(["--help"]);
  assert.equal(result.code,0);
  assert.deepEqual(JSON.parse(result.stdout),{
    version:1,
    status:"help",
    contract:"douyin_webkit_reader_v1"
  });
  assert.equal(result.stderr,"");
  assert.ok(Buffer.byteLength(result.stdout,"utf8")<1024);
});

test("requires complete bytes and matching duration before audio is complete",async()=>{
  const {stdout,stderr}=await execFileAsync(coverageHarness,[],{
    cwd:root,
    timeout:2_000,
    maxBuffer:1024
  });
  assert.equal(stderr,"");
  assert.equal(stdout,"0,0,1,2,0\n1,1,0,0,0\n");
});

test("fetches a complete bounded video object before publishing visual evidence",async()=>{
  const native=await readFile(source,"utf8");
  assert.match(
    native,
    /LLWAudioObjectCoverageDecision\(\s*downloader\.sourceTotalBytes,\s*downloader\.receivedBytes,\s*kVideoMaxBytes\s*\)/
  );
  assert.match(native,/CompleteVideoFileCoversPlayer/);
  assert.match(
    native,
    /maxBytes:downloader\.sourceTotalBytes[\s\S]*?videoComplete=YES/
  );
});

test("starts player polling and media acquisition at most once",async()=>{
  const native=await readFile(source,"utf8");
  assert.match(native,/@property\(nonatomic\) BOOL pollingStarted;/);
  assert.match(
    native,
    /didFinishNavigation:[\s\S]*?if \(self\.finished\|\|self\.pollingStarted\) return;[\s\S]*?self\.pollingStarted=YES;[\s\S]*?\[self pollPlayer\];/
  );
  assert.match(
    native,
    /if \(selfRef==nil\|\|selfRef\.finished\|\|\s*selfRef\.acquisitionStarted\) return;/
  );
});

test("rejects unknown or incomplete arguments before starting WebKit",async()=>{
  for (const args of [
    [],
    ["--unknown","value"],
    ["--url",PAGE_URL],
    validArgs().slice(0,-2)
  ]) {
    const result=await run(args);
    assert.equal(result.code,64);
    assert.deepEqual(JSON.parse(result.stdout),{
      version:1,status:"error",code:"invalid_arguments"
    });
    assert.equal(result.stderr,"");
  }
});

test("rejects every non-canonical or credential-bearing page URL",async()=>{
  for (const url of [
    "http://www.douyin.com/video/7645139256003906842",
    "https://user@www.douyin.com/video/7645139256003906842",
    "https://www.douyin.com:444/video/7645139256003906842",
    "https://www.douyin.com/video/not-numeric",
    "https://www.douyin.com/video/7645139256003906842?share=1",
    "https://www.douyin.com/video/7645139256003906842#fragment",
    "https://example.com/video/7645139256003906842"
  ]) {
    const result=await run(validArgs({url}));
    assert.equal(result.code,64,url);
    assert.deepEqual(JSON.parse(result.stdout),{
      version:1,status:"error",code:"invalid_url"
    });
    assert.equal(result.stderr,"");
  }
});

test("requires an existing owner-private output directory",async()=>{
  const unsafe=join(root,"unsafe-output");
  await mkdir(unsafe,{mode:0o755});
  await chmod(unsafe,0o755);
  const result=await run(validArgs({outputDir:unsafe}));
  assert.equal(result.code,65);
  assert.deepEqual(JSON.parse(result.stdout),{
    version:1,status:"error",code:"unsafe_output_directory"
  });
  assert.equal(result.stderr,"");
});

test("accepts only the fixed byte ceilings and a bounded deadline",async()=>{
  for (const override of [
    {audioMax:"1"},
    {audioMax:String(32*1024*1024+1)},
    {videoMax:"1"},
    {videoMax:String(128*1024*1024+1)},
    {deadline:"999"},
    {deadline:"120001"},
    {deadline:"not-a-number"}
  ]) {
    const result=await run(validArgs(override));
    assert.equal(result.code,64,JSON.stringify(override));
    assert.deepEqual(JSON.parse(result.stdout),{
      version:1,status:"error",code:"invalid_arguments"
    });
    assert.equal(result.stderr,"");
  }
});

function validArgs({
  url=PAGE_URL,
  outputDir=privateOutput,
  audioMax=String(32*1024*1024),
  videoMax=String(128*1024*1024),
  deadline="45000"
}={}) {
  return [
    "--url",url,
    "--output-dir",outputDir,
    "--audio-max-bytes",audioMax,
    "--video-max-bytes",videoMax,
    "--deadline-ms",deadline
  ];
}

async function run(args) {
  return new Promise((resolvePromise,rejectPromise)=>{
    const child=execFile(helper,args,{
      cwd:root,
      env:{
        PATH:"/usr/bin:/bin",
        LANG:"en_US.UTF-8",
        LC_ALL:"en_US.UTF-8",
        TMPDIR:root
      },
      timeout:2_000,
      maxBuffer:64*1024
    },(error,stdout,stderr)=>{
      if (error&&typeof error.code!=="number") {
        rejectPromise(error);
        return;
      }
      resolvePromise({
        code:error?.code??0,
        stdout:String(stdout).trim(),
        stderr:String(stderr)
      });
    });
  });
}
