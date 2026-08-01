import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {
  access,chmod,mkdtemp,readFile,readdir,rm,stat,writeFile
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  createPublicVideoSourcePreparer,
  createTurnSourcePreparerWithPublicVideo
} from "../src/personal-assistant/public-video-source-preparer.mjs";

test("stages one complete public video and audio as a task-owned source",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-public-video-source-"));
  const audio=Buffer.from("0000ftypM4A synthetic audio");
  const video=Buffer.from("0000ftypmp42 synthetic video");
  let adapterCalls=0;
  try {
    const prepare=createPublicVideoSourcePreparer({
      tempRoot:root,
      bilibiliAdapter:{
        async prepare({workspaceDir}) {
          adapterCalls+=1;
          const audioFile=join(workspaceDir,"bilibili-audio.m4a");
          const videoFile=join(workspaceDir,"bilibili-video.mp4");
          await writeFile(audioFile,audio,{mode:0o600});
          await writeFile(videoFile,video,{mode:0o600});
          return {
            platform:"bilibili",
            mediaId:"BV1Synthetic",
            canonicalUrl:"https://www.bilibili.com/video/BV1Synthetic/",
            durationMs:250_709,
            audio:{
              file:audioFile,byteSize:audio.length,
              sha256:sha(audio),detectedMime:"audio/mp4",
              format:"m4a",durationMs:250_665
            },
            video:{
              file:videoFile,byteSize:video.length,
              sha256:sha(video),detectedMime:"video/mp4",
              format:"mp4",durationMs:250_650,
              width:1280,height:720
            },
            limitations:[]
          };
        }
      },
      douyinAdapter:{async prepare(){throw new Error("unexpected");}}
    });

    const result=await prepare({
      request:{
        platform:"bilibili",
        url:"https://b23.tv/Mn2sUpl"
      },
      sourceId:"source-001"
    });

    assert.equal(adapterCalls,1);
    assert.equal(result.source.handle.mediaClass,"video");
    assert.equal(result.source.handle.durationMs,250_709);
    assert.equal(
      result.source.handle.representationIndexPath,
      "source-001.manifest.json"
    );
    assert.equal(result.source.auxiliaryFiles.length,1);
    assert.deepEqual(
      {
        role:result.source.auxiliaryFiles[0].role,
        extension:result.source.auxiliaryFiles[0].extension,
        byteSize:result.source.auxiliaryFiles[0].byteSize,
        sha256:result.source.auxiliaryFiles[0].sha256
      },
      {
        role:"audio",extension:"m4a",
        byteSize:audio.length,sha256:sha(audio)
      }
    );
    assert.equal(
      (await stat(result.source.absolutePath)).mode&0o777,
      0o600
    );
    assert.deepEqual(
      await readFile(result.source.auxiliaryFiles[0].absolutePath),
      audio
    );
    const staging=result.workspaceDir;
    await result.cleanup();
    await assert.rejects(access(staging),{code:"ENOENT"});
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test("rejects a mismatched or incomplete adapter result and cleans staging",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-public-video-invalid-"));
  try {
    const prepare=createPublicVideoSourcePreparer({
      tempRoot:root,
      bilibiliAdapter:{
        async prepare(){return {
          platform:"douyin",
          mediaId:"wrong"
        };}
      },
      douyinAdapter:{async prepare(){throw new Error("unexpected");}}
    });
    let caught;
    await assert.rejects(
      prepare({
        request:{platform:"bilibili",url:"https://b23.tv/Mn2sUpl"},
        sourceId:"source-001"
      }),
      error=>{
        caught=error;
        return error?.message==="public_video_source_invalid";
      }
    );
    assert.equal(
      caught.publicVideoFailureCode,
      "bilibili_result_metadata_invalid"
    );
    assert.deepEqual(
      (await readdir(root)).filter(
        name=>name.startsWith("llw-public-video-")
      ),
      []
    );
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test("distinguishes Bilibili media metadata and hash revalidation failures",async()=>{
  for (const [expected,mutate] of [
    ["bilibili_video_file_metadata_invalid",async result=>{
      await chmod(result.video.file,0o644);
    }],
    ["bilibili_audio_hash_mismatch",async result=>{
      result.audio.sha256="0".repeat(64);
    }]
  ]) {
    const root=await mkdtemp(join(tmpdir(),"llw-public-video-stage-"));
    let caught;
    try {
      const prepare=createPublicVideoSourcePreparer({
        tempRoot:root,
        bilibiliAdapter:{
          async prepare({workspaceDir}) {
            const result=await writeValidBilibiliResult(workspaceDir);
            await mutate(result);
            return result;
          }
        },
        douyinAdapter:{async prepare(){throw new Error("unexpected");}}
      });
      await assert.rejects(
        prepare({
          request:{platform:"bilibili",url:"https://b23.tv/Mn2sUpl"},
          sourceId:"source-001"
        }),
        error=>{
          caught=error;
          return error?.message==="public_video_source_invalid";
        }
      );
      assert.equal(caught.publicVideoFailureCode,expected);
      assert.deepEqual(
        (await readdir(root)).filter(
          name=>name.startsWith("llw-public-video-")
        ),
        []
      );
    } finally {
      await rm(root,{recursive:true,force:true});
    }
  }
});

test("keeps internal Bilibili revalidation diagnostics off Douyin",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-public-video-douyin-stage-"));
  let caught;
  try {
    const prepare=createPublicVideoSourcePreparer({
      tempRoot:root,
      bilibiliAdapter:{async prepare(){throw new Error("unexpected");}},
      douyinAdapter:{
        async prepare(){return {platform:"bilibili",mediaId:"wrong"};}
      }
    });
    await assert.rejects(
      prepare({
        request:{
          platform:"douyin",
          url:"https://v.douyin.com/BoundedRetry/"
        },
        sourceId:"source-001"
      }),
      error=>{
        caught=error;
        return error?.message==="public_video_source_invalid";
      }
    );
    assert.equal(caught.publicVideoFailureCode,undefined);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test("does not automatically retry a transient Bilibili source failure",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-public-video-single-attempt-"));
  let calls=0;
  try {
    const prepare=createPublicVideoSourcePreparer({
      tempRoot:root,
      bilibiliAdapter:{
        async prepare({workspaceDir}) {
          calls+=1;
          throw new Error("bilibili_media_unavailable");
        }
      },
      douyinAdapter:{async prepare(){throw new Error("unexpected");}}
    });
    let caught;
    await assert.rejects(
      prepare({
        request:{platform:"bilibili",url:"https://b23.tv/Mn2sUpl"},
        sourceId:"source-001"
      }),
      error=>{
        caught=error;
        return error?.message==="public_video_source_invalid";
      }
    );
    assert.equal(calls,1);
    assert.equal(
      caught.publicVideoFailureCode,
      "bilibili_media_unavailable"
    );
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

for (const code of [
  "bilibili_url_invalid",
  "bilibili_access_denied",
  "bilibili_media_unavailable",
  "bilibili_control_invalid",
  "bilibili_media_invalid",
  "bilibili_limit_exceeded",
  "unexpected_internal_error"
]) {
  test(`uses one Bilibili source attempt for ${code}`,async()=>{
    const result=await runRejectedSourceCase({
      platform:"bilibili",code
    });
    assert.equal(result.calls,1);
    assert.equal(result.error.message,"public_video_source_invalid");
    assert.equal(
      result.error.publicVideoFailureCode,
      code.startsWith("bilibili_")?code:undefined
    );
    assert.deepEqual(result.staging,[]);
  });
}

test("does not retry a transient Bilibili error after cancellation",async()=>{
  const controller=new AbortController();
  controller.abort();
  const result=await runRejectedSourceCase({
    platform:"bilibili",
    code:"bilibili_media_unavailable",
    signal:controller.signal
  });
  assert.equal(result.calls,1);
  assert.equal(
    result.error.publicVideoFailureCode,
    "bilibili_media_unavailable"
  );
  assert.deepEqual(result.staging,[]);
});

test("does not add a Bilibili retry or diagnostic to Douyin",async()=>{
  const result=await runRejectedSourceCase({
    platform:"douyin",code:"bilibili_media_unavailable"
  });
  assert.equal(result.calls,1);
  assert.equal(result.error.publicVideoFailureCode,undefined);
  assert.deepEqual(result.staging,[]);
});

test("adds a typed public-video link to the ordinary turn sources once",async()=>{
  let baseCalls=0,videoCalls=0,baseCleanups=0,videoCleanups=0;
  const prepare=createTurnSourcePreparerWithPublicVideo({
    basePreparer:async message=>{
      baseCalls+=1;
      return {
        instructionText:message.instructionText,
        workspaceDir:"/private/tmp/base",
        sources:[],
        cleanup:async()=>{baseCleanups+=1;}
      };
    },
    publicVideoSourcePreparer:async({request,sourceId})=>{
      videoCalls+=1;
      assert.equal(request.platform,"bilibili");
      assert.equal(sourceId,"source-001");
      return {
        source:{handle:{sourceId}},
        cleanup:async()=>{videoCleanups+=1;}
      };
    }
  });

  const result=await prepare({
    instructionText:"总结 https://b23.tv/Mn2sUpl，不保存",
    attachments:[]
  });
  assert.equal(baseCalls,1);
  assert.equal(videoCalls,1);
  assert.equal(result.sources.length,1);
  await result.cleanup();
  await result.cleanup();
  assert.equal(baseCleanups,1);
  assert.equal(videoCleanups,1);
});

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeValidBilibiliResult(workspaceDir) {
  const audio=Buffer.from("0000ftypM4A retry audio");
  const video=Buffer.from("0000ftypmp42 retry video");
  const audioFile=join(workspaceDir,"bilibili-audio.m4a");
  const videoFile=join(workspaceDir,"bilibili-video.mp4");
  await writeFile(audioFile,audio,{mode:0o600});
  await writeFile(videoFile,video,{mode:0o600});
  return {
    platform:"bilibili",
    mediaId:"BV1Synthetic",
    canonicalUrl:"https://www.bilibili.com/video/BV1Synthetic/",
    durationMs:250_709,
    audio:{
      file:audioFile,byteSize:audio.length,sha256:sha(audio),
      detectedMime:"audio/mp4",format:"m4a",durationMs:250_665
    },
    video:{
      file:videoFile,byteSize:video.length,sha256:sha(video),
      detectedMime:"video/mp4",format:"mp4",durationMs:250_650
    },
    limitations:[]
  };
}

async function runRejectedSourceCase({platform,code,signal}) {
  const root=await mkdtemp(join(tmpdir(),"llw-public-video-rejected-"));
  let calls=0,caught;
  const failing={
    async prepare() {
      calls+=1;
      throw new Error(code);
    }
  };
  const prepare=createPublicVideoSourcePreparer({
    tempRoot:root,
    bilibiliAdapter:platform==="bilibili"
      ?failing:{async prepare(){throw new Error("unexpected");}},
    douyinAdapter:platform==="douyin"
      ?failing:{async prepare(){throw new Error("unexpected");}}
  });
  try {
    await assert.rejects(
      prepare({
        request:{
          platform,
          url:platform==="bilibili"
            ?"https://b23.tv/Mn2sUpl"
            :"https://v.douyin.com/BoundedRetry/"
        },
        sourceId:"source-001",signal
      }),
      error=>{
        caught=error;
        return error?.message==="public_video_source_invalid";
      }
    );
    return {
      calls,error:caught,
      staging:(await readdir(root)).filter(
        name=>name.startsWith("llw-public-video-")
      )
    };
  } finally {
    await rm(root,{recursive:true,force:true});
  }
}
