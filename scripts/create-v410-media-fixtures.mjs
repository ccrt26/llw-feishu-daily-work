import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {
  chmod,mkdir,open,realpath,rm,stat
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname,join,resolve,sep} from "node:path";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";

const PHRASE="请把测试代号海风七三一九记录下来";
const VISUAL_CODE="BLUE-7319";
const SCRIPT_DIR=dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH=fileURLToPath(import.meta.url);

if (process.argv[1]&&resolve(process.argv[1])===SCRIPT_PATH) {
  try {
    await main();
  } catch (error) {
    const message=boundedError(error);
    process.stderr.write(`${message}\n`);
    process.exitCode=1;
  }
}

async function main() {
  const [rootArgument]=process.argv.slice(2);
  if (process.argv.slice(2).length!==1||!rootArgument) invalid("usage");
  const root=resolve(rootArgument);
  const allowedRoot=await realpath(resolve(tmpdir()));
  if (root===allowedRoot||!root.startsWith(`${allowedRoot}${sep}`)) {
    const parent=await realpath(dirname(root));
    if (parent!==allowedRoot&&!parent.startsWith(`${allowedRoot}${sep}`)) {
      invalid("unsafe_fixture_root");
    }
  }
  await mkdir(root,{recursive:true,mode:0o700});
  const canonicalRoot=await realpath(root);
  if (!canonicalRoot.startsWith(`${allowedRoot}${sep}`)) {
    invalid("unsafe_fixture_root");
  }
  await chmod(root,0o700);

  const audio=join(root,"instruction.aiff");
  const video=join(root,"visual-facts.mov");
  const manifestPath=join(root,"manifest.json");
  const binary=join(root,".fixture-video-generator");
  for (const file of [audio,video,manifestPath,binary]) {
    if (await exists(file)) invalid("fixture_output_exists");
  }

  await run("/usr/bin/say",[
    "-v","Tingting","-o",audio,PHRASE
  ]);
  await chmod(audio,0o600);

  try {
    await run("/usr/bin/clang",[
      "-fobjc-arc",
      "-framework","Foundation",
      "-framework","AVFoundation",
      "-framework","CoreGraphics",
      "-framework","CoreText",
      "-framework","CoreVideo",
      "-framework","CoreMedia",
      "-o",binary,
      join(SCRIPT_DIR,"v410-video-fixture-generator.m")
    ],120_000);
    await run(binary,[video],120_000);
  } finally {
    await rm(binary,{force:true});
  }
  await chmod(video,0o600);

  const manifest=await buildFixtureManifest({audio,video});
  const handle=await open(manifestPath,"wx",0o600);
  try {
    await handle.writeFile(`${JSON.stringify(manifest,null,2)}\n`,"utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  process.stdout.write(`${manifestPath}\n`);
}

export async function buildFixtureManifest({audio,video}) {
  return {
    version:1,
    containsUserData:false,
    audioPhrase:PHRASE,
    visualOnlyCode:VISUAL_CODE,
    visualOnlyCodeSpoken:false,
    sequenceSpoken:false,
    expectedVisualSequence:["circle","square","triangle"],
    codeVisibleRangeMs:{start:5_000,end:7_000},
    durationMs:12_000,
    files:{audio:"instruction.aiff",video:"visual-facts.mov"},
    sha256:{
      audio:await sha256(audio),
      video:await sha256(video)
    }
  };
}

async function sha256(file) {
  const hash=createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error?.code==="ENOENT") return false;
    throw error;
  }
}

function run(command,args,timeoutMs=30_000) {
  return new Promise((resolvePromise,rejectPromise)=>{
    const child=spawn(command,args,{stdio:["ignore","ignore","pipe"]});
    let stderr="";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data",chunk=>{
      if (stderr.length<4_096) stderr+=chunk;
    });
    const timeout=setTimeout(()=>{
      child.kill("SIGKILL");
      rejectPromise(new Error("fixture_process_timeout"));
    },timeoutMs);
    child.once("error",error=>{
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.once("close",code=>{
      clearTimeout(timeout);
      if (code===0) resolvePromise();
      else rejectPromise(new Error(
        `fixture_process_failed:${command.split("/").at(-1)}:${stderr.trim()}`
      ));
    });
  });
}

function invalid(code) {
  throw new Error(code);
}

function boundedError(error) {
  const raw=error instanceof Error?error.message:String(error);
  return raw
    .replaceAll(resolve(tmpdir()),"<temporary>")
    .replaceAll(process.env.HOME||"\0","<home>")
    .slice(0,4_096);
}
