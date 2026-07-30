import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readdir,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  createDouyinPublicAdapter
} from "../src/personal-assistant/douyin-public-adapter.mjs";

const PAGE_URL=
  "https://www.douyin.com/video/7645139256003906842";
const MEDIA_ID="7645139256003906842";
const WORKSPACE="/private/tmp/llw-douyin-public-test";
const SHA_A="a".repeat(64);
const SHA_B="b".repeat(64);

test("delegates one canonical public URL and returns audio plus video evidence",async()=>{
  const calls=[];
  const adapter=createDouyinPublicAdapter({
    reader:{
      async read(input) {
        calls.push(input);
        return readerResult();
      }
    }
  });
  const controller=new AbortController();
  const result=await adapter.prepare({
    url:PAGE_URL,
    workspaceDir:WORKSPACE,
    signal:controller.signal
  });

  assert.equal(result.platform,"douyin");
  assert.equal(result.mediaId,MEDIA_ID);
  assert.equal(result.canonicalUrl,PAGE_URL);
  assert.equal(result.audio.detectedMime,"audio/mp4");
  assert.equal(result.video.detectedMime,"video/mp4");
  assert.deepEqual(result.limitations,[]);
  assert.deepEqual(calls,[{
    url:PAGE_URL,
    workspaceDir:WORKSPACE,
    signal:controller.signal
  }]);
  assert.equal(Object.isFrozen(result),true);
  assert.equal(Object.isFrozen(result.audio),true);
  assert.equal(Object.isFrozen(result.video),true);
});

test("does not turn the historical two-hour helper bound into a product gate",async()=>{
  const value=readerResult();
  value.durationMs=7_200_001;
  value.audio.durationMs=7_200_001;
  value.video.durationMs=7_200_001;
  const adapter=createDouyinPublicAdapter({
    reader:{async read(){return value;}}
  });

  const result=await adapter.prepare({
    url:PAGE_URL,workspaceDir:WORKSPACE
  });

  assert.equal(result.durationMs,7_200_001);
});

test("resolves one bounded Douyin share link before reading media",async()=>{
  const fetchCalls=[];
  const readerCalls=[];
  const adapter=createDouyinPublicAdapter({
    fetchImpl:async(url,options)=>{
      fetchCalls.push({url,options});
      return new Response(null,{
        status:302,
        headers:{
          location:
            `https://www.iesdouyin.com/share/video/${MEDIA_ID}/`+
            "?region=CN&share_sign=discarded"
        }
      });
    },
    reader:{
      async read(input) {
        readerCalls.push(input);
        return readerResult();
      }
    }
  });
  const shortUrl="https://v.douyin.com/hhw45Popmfc/";
  const result=await adapter.prepare({
    url:shortUrl,workspaceDir:WORKSPACE
  });

  assert.equal(result.canonicalUrl,PAGE_URL);
  assert.equal(result.mediaId,MEDIA_ID);
  assert.equal(fetchCalls.length,1);
  assert.equal(fetchCalls[0].url,shortUrl);
  assert.equal(fetchCalls[0].options.redirect,"manual");
  assert.deepEqual(readerCalls,[{
    url:PAGE_URL,
    workspaceDir:WORKSPACE,
    signal:undefined
  }]);
});

test("rejects non-canonical URLs before calling the reader",async()=>{
  let calls=0;
  const adapter=createDouyinPublicAdapter({
    reader:{
      async read() {
        calls++;
        return readerResult();
      }
    }
  });
  for (const url of [
    "https://www.douyin.com/video/not-numeric",
    "https://www.douyin.com/video/7645139256003906842?share=1",
    "https://v.douyin.com/a/b/",
    "https://v.douyin.com/hhw45Popmfc/?bad=1",
    "https://example.com/video/7645139256003906842"
  ]) {
    await assert.rejects(
      adapter.prepare({url,workspaceDir:WORKSPACE}),
      error=>safe(error,"douyin_url_invalid")
    );
  }
  assert.equal(calls,0);
});

for (const [name,mutate] of [
  ["missing audio",value=>{delete value.audio;}],
  ["missing video",value=>{delete value.video;}],
  ["title fallback",value=>{value.title="not media evidence";}],
  ["comment fallback",value=>{value.comments=["not evidence"];}],
  ["mismatched canonical URL",value=>{
    value.canonicalUrl=
      "https://www.douyin.com/video/7000000000000000000";
  }],
  ["unsafe media path",value=>{value.audio.file="relative.m4a";}]
]) {
  test(`fails closed for ${name}`,async()=>{
    const value=readerResult();
    mutate(value);
    const adapter=createDouyinPublicAdapter({
      reader:{async read(){return value;}}
    });
    await assert.rejects(
      adapter.prepare({url:PAGE_URL,workspaceDir:WORKSPACE}),
      error=>safe(error,"douyin_media_invalid")
    );
  });
}

test("does not expose an underlying helper diagnostic",async()=>{
  const adapter=createDouyinPublicAdapter({
    reader:{
      async read() {
        throw new Error(
          "https://media.douyinvod.com/file?secret=signed-value"
        );
      }
    }
  });
  await assert.rejects(
    adapter.prepare({url:PAGE_URL,workspaceDir:WORKSPACE}),
    error=>safe(error,"douyin_media_unavailable")&&
      !error.message.includes("secret")
  );
});

test("rejects bounded audio coverage and removes every published media file",async()=>{
  const workspaceDir=await mkdtemp(
    join(tmpdir(),"llw-douyin-public-")
  );
  const value=readerResult();
  value.audio.file=join(workspaceDir,"audio.m4a");
  value.video.file=join(workspaceDir,"video.mp4");
  value.limitations=[
    "bounded_audio_prefix",
    "bounded_video_prefix"
  ];
  await writeFile(value.audio.file,"audio",{mode:0o600});
  await writeFile(value.video.file,"video",{mode:0o600});
  const adapter=createDouyinPublicAdapter({
    reader:{async read(){return value;}}
  });
  try {
    await assert.rejects(
      adapter.prepare({url:PAGE_URL,workspaceDir}),
      error=>safe(error,"douyin_complete_audio_unavailable")
    );
    assert.deepEqual(await readdir(workspaceDir),[]);
  } finally {
    await rm(workspaceDir,{recursive:true,force:true});
  }
});

test("rejects bounded visual coverage and removes published media",async()=>{
  const workspaceDir=await mkdtemp(
    join(tmpdir(),"llw-douyin-public-")
  );
  const value=readerResult();
  value.audio.file=join(workspaceDir,"audio.m4a");
  value.video.file=join(workspaceDir,"video.mp4");
  value.limitations=["bounded_video_prefix"];
  await writeFile(value.audio.file,"audio",{mode:0o600});
  await writeFile(value.video.file,"video",{mode:0o600});
  const adapter=createDouyinPublicAdapter({
    reader:{async read(){return value;}}
  });
  try {
    await assert.rejects(
      adapter.prepare({url:PAGE_URL,workspaceDir}),
      error=>safe(error,"douyin_complete_video_unavailable")
    );
    assert.deepEqual(await readdir(workspaceDir),[]);
  } finally {
    await rm(workspaceDir,{recursive:true,force:true});
  }
});

function readerResult() {
  return {
    platform:"douyin",
    mediaId:MEDIA_ID,
    canonicalUrl:PAGE_URL,
    durationMs:64_689,
    audio:{
      file:"/private/tmp/douyin-audio.m4a",
      byteSize:1_024,
      sha256:SHA_A,
      detectedMime:"audio/mp4",
      format:"m4a",
      durationMs:64_689
    },
    video:{
      file:"/private/tmp/douyin-video.mp4",
      byteSize:2_048,
      sha256:SHA_B,
      detectedMime:"video/mp4",
      format:"mp4",
      durationMs:64_689,
      width:1280,
      height:720
    },
    limitations:[]
  };
}

function safe(error,code) {
  return error?.message===code&&Object.keys(error).length===0;
}
