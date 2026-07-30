import test from "node:test";
import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {mkdtemp,readdir,rm,stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Readable} from "node:stream";
import {
  createBilibiliConnectionBoundFetch,
  createBilibiliPublicAdapter
} from "../src/personal-assistant/bilibili-public-adapter.mjs";
import {
  AUDIO_BYTES,TEST_AUDIO_URL,TEST_BVID,TEST_CID,TEST_DURATION_MS,
  TEST_PAGE_URL,TEST_PLAY_URL,TEST_SHORT_URL,TEST_VIDEO_URL,
  TEST_VIEW_URL,VIDEO_BYTES,jsonResponse,mediaResponse,playBody,
  publicLookup,redirectResponse,syntheticInspector,viewBody
} from "./fixtures/bilibili-public-media.mjs";

test("pins the validated DNS answer into the actual HTTPS socket lookup",async()=>{
  const resolverCalls=[];
  const socketLookups=[];
  const boundFetch=createBilibiliConnectionBoundFetch({
    lookupAll:async(hostname,options)=>{
      resolverCalls.push({hostname,options});
      return [{address:"8.8.8.8",family:4}];
    },
    requestImpl:(url,options,onResponse)=>{
      assert.equal(url.hostname,"api.bilibili.com");
      assert.equal(options.servername,"api.bilibili.com");
      const request=new EventEmitter();
      request.destroy=error=>request.emit("error",error);
      request.end=()=>{
        options.lookup(url.hostname,{all:false},(error,address,family)=>{
          assert.ifError(error);
          socketLookups.push({address,family});
          const response=Readable.from([Buffer.from("{}")]);
          response.statusCode=200;
          response.headers={"content-type":"application/json"};
          onResponse(response);
        });
      };
      return request;
    }
  });

  const response=await boundFetch(TEST_VIEW_URL,{
    method:"GET",
    redirect:"manual",
    headers:{Accept:"application/json"}
  });
  const reader=response.body.getReader();
  const first=await reader.read();

  assert.equal(response.status,200);
  assert.equal(Buffer.from(first.value).toString("utf8"),"{}");
  assert.deepEqual(resolverCalls,[{
    hostname:"api.bilibili.com",
    options:{all:true,verbatim:true}
  }]);
  assert.deepEqual(socketLookups,[{address:"8.8.8.8",family:4}]);
});

test("uses the observed anonymous view to playurl contract",async()=>{
  const root=await privateWorkspace("llw-bilibili-control-");
  const calls=[];
  const adapter=createBilibiliPublicAdapter({
    lookupAll:publicLookup,
    inspectMediaHeader:syntheticInspector,
    fetchImpl:async(url,options)=>{
      calls.push({url:String(url),options});
      if (url===TEST_VIEW_URL) return jsonResponse(viewBody());
      if (url===TEST_PLAY_URL) return jsonResponse(playBody());
      if (url===TEST_AUDIO_URL) return mediaResponse(AUDIO_BYTES);
      if (url===TEST_VIDEO_URL) return mediaResponse(VIDEO_BYTES);
      throw new Error("unexpected_url");
    }
  });

  const result=await adapter.prepare({
    url:TEST_PAGE_URL,
    workspaceDir:root
  });

  assert.equal(result.platform,"bilibili");
  assert.equal(result.mediaId,TEST_BVID);
  assert.equal(result.canonicalUrl,TEST_PAGE_URL);
  assert.equal(result.durationMs,TEST_DURATION_MS);
  assert.equal(result.audio.detectedMime,"audio/mp4");
  assert.equal(result.audio.format,"m4a");
  assert.equal(result.video.detectedMime,"video/mp4");
  assert.equal(result.video.format,"mp4");
  assert.deepEqual(result.limitations,[]);
  assert.deepEqual(
    calls.map(call=>call.url),
    [TEST_VIEW_URL,TEST_PLAY_URL,TEST_AUDIO_URL,TEST_VIDEO_URL]
  );
  for (const {options} of calls) {
    assert.equal(options.headers.Cookie,undefined);
    assert.equal(options.headers.Authorization,undefined);
    assert.equal(options.headers.Referer,TEST_PAGE_URL);
  }
  assert.equal((await stat(result.audio.file)).mode&0o777,0o600);
  assert.equal((await stat(result.video.file)).mode&0o777,0o600);
  assert.ok(result.audio.file.endsWith(".m4a"));
  assert.ok(result.video.file.endsWith(".mp4"));
  assert.ok(!JSON.stringify(result).includes("signed=test"));
});

test("does not turn the historical 30-minute candidate bound into a product gate",async()=>{
  const root=await privateWorkspace("llw-bilibili-over-thirty-");
  const durationSeconds=1_801;
  const durationMs=durationSeconds*1_000;
  const adapter=workingAdapter(async url=>{
    if (url===TEST_VIEW_URL) {
      return jsonResponse(viewBody({data:{
        duration:durationSeconds,
        pages:[{cid:TEST_CID,page:1,duration:durationSeconds}]
      }}));
    }
    if (url===TEST_PLAY_URL) {
      return jsonResponse(playBody({data:{timelength:durationMs}}));
    }
    if (url===TEST_AUDIO_URL) return mediaResponse(AUDIO_BYTES);
    if (url===TEST_VIDEO_URL) return mediaResponse(VIDEO_BYTES);
    throw new Error("unexpected_url");
  });
  try {
    const result=await adapter.prepare({
      url:TEST_PAGE_URL,workspaceDir:root
    });
    assert.equal(result.durationMs,durationMs);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test("resolves a bounded b23.tv redirect before fixed API calls",async()=>{
  const root=await privateWorkspace("llw-bilibili-short-");
  const calls=[];
  const adapter=workingAdapter(async(url,options)=>{
    calls.push({url:String(url),options});
    if (url===TEST_SHORT_URL) return redirectResponse(TEST_PAGE_URL);
    if (url===TEST_VIEW_URL) return jsonResponse(viewBody());
    if (url===TEST_PLAY_URL) return jsonResponse(playBody());
    if (url===TEST_AUDIO_URL) return mediaResponse(AUDIO_BYTES);
    if (url===TEST_VIDEO_URL) return mediaResponse(VIDEO_BYTES);
    throw new Error("unexpected_url");
  });
  const result=await adapter.prepare({
    url:TEST_SHORT_URL,workspaceDir:root
  });
  assert.equal(result.canonicalUrl,TEST_PAGE_URL);
  assert.equal(calls[0].options.redirect,"manual");
  assert.equal(calls[1].url,TEST_VIEW_URL);
});

test("canonicalizes trusted Bilibili share queries after a short redirect",async()=>{
  const root=await privateWorkspace("llw-bilibili-share-query-");
  const redirected=
    `${TEST_PAGE_URL}?buvid=share-device&p=1&share_source=COPY`;
  const calls=[];
  const adapter=workingAdapter(async(url,options)=>{
    calls.push({url:String(url),options});
    if (url===TEST_SHORT_URL) return redirectResponse(redirected);
    if (url===TEST_VIEW_URL) return jsonResponse(viewBody());
    if (url===TEST_PLAY_URL) return jsonResponse(playBody());
    if (url===TEST_AUDIO_URL) return mediaResponse(AUDIO_BYTES);
    if (url===TEST_VIDEO_URL) return mediaResponse(VIDEO_BYTES);
    throw new Error("unexpected_url");
  });

  const result=await adapter.prepare({
    url:TEST_SHORT_URL,workspaceDir:root
  });

  assert.equal(result.canonicalUrl,TEST_PAGE_URL);
  assert.equal(calls[1].url,TEST_VIEW_URL);
  assert.equal(calls[1].options.headers.Referer,TEST_PAGE_URL);
});

test("rejects malformed user URLs before any network request",async()=>{
  const invalid=[
    "http://www.bilibili.com/video/BV1Synthetic/",
    "https://user@www.bilibili.com/video/BV1Synthetic/",
    "https://www.bilibili.com:444/video/BV1Synthetic/",
    "https://www.bilibili.com/video/BV1Synthetic/#fragment",
    "https://www.bilibili.com/video/BV1Synthetic/?p=1",
    "https://www.bilibili.com/bangumi/play/ep1",
    "https://space.bilibili.com/video/BV1Synthetic/",
    "https://example.com/video/BV1Synthetic/"
  ];
  for (const url of invalid) {
    let fetched=false;
    const adapter=workingAdapter(async()=>{
      fetched=true;
      throw new Error("must_not_fetch");
    });
    await assert.rejects(
      ()=>adapter.prepare({url,workspaceDir:"/private/tmp"}),
      error=>error?.message==="bilibili_url_invalid"
    );
    assert.equal(fetched,false,url);
  }
});

test("rejects unsafe DNS and excessive short redirects",async()=>{
  for (const answers of [
    [{address:"127.0.0.1",family:4}],
    [{address:"8.8.8.8",family:4},{address:"10.0.0.1",family:4}],
    [{address:"169.254.169.254",family:4}],
    [{address:"::1",family:6}],
    [{address:"fe80::1",family:6}],
    []
  ]) {
    const adapter=workingAdapter(
      async()=>jsonResponse(viewBody()),
      async()=>answers
    );
    await assert.rejects(
      ()=>adapter.prepare({
        url:TEST_PAGE_URL,workspaceDir:"/private/tmp"
      }),
      error=>error?.message==="bilibili_access_denied"
    );
  }

  const adapter=workingAdapter(async url=>
    redirectResponse(
      url===TEST_SHORT_URL
        ?"https://b23.tv/one"
        :url==="https://b23.tv/one"
          ?"https://b23.tv/two"
          :url==="https://b23.tv/two"
            ?"https://b23.tv/three"
            :TEST_PAGE_URL
    )
  );
  await assert.rejects(
    ()=>adapter.prepare({
      url:TEST_SHORT_URL,workspaceDir:"/private/tmp"
    }),
    error=>error?.message==="bilibili_access_denied"
  );
});

test("rejects malformed or conflicting view control data before playurl",async()=>{
  const invalid=[
    "not-json",
    viewBody({code:-404}),
    viewBody({data:{bvid:"BV1Different0"}}),
    viewBody({data:{duration:18_000}}),
    viewBody({data:{pages:[]}}),
    viewBody({data:{pages:[
      {cid:1,page:1,duration:12},
      {cid:2,page:2,duration:12}
    ]}}),
    viewBody({data:{cid:123}}),
    viewBody({data:{pages:[{cid:0,page:1,duration:12}]}})
  ];
  for (const body of invalid) {
    const root=await privateWorkspace("llw-bilibili-view-invalid-");
    let playCalls=0;
    const adapter=workingAdapter(async url=>{
      if (url===TEST_VIEW_URL) return jsonResponse(body);
      playCalls++;
      throw new Error("must_not_call_play");
    });
    await assert.rejects(
      ()=>adapter.prepare({url:TEST_PAGE_URL,workspaceDir:root}),
      error=>error?.message==="bilibili_control_invalid"
    );
    assert.equal(playCalls,0);
    assert.deepEqual(await readdir(root),[]);
  }
});

test("rejects unsupported play data before media requests",async()=>{
  const invalid=[
    playBody({code:-404}),
    playBody({data:{timelength:18_001}}),
    playBody({data:{dash:{audio:[]}}}),
    playBody({data:{dash:{video:[]}}}),
    playBody({data:{dash:{audio:[{
      id:1,bandwidth:1,codecs:"opus",
      mimeType:"audio/webm",baseUrl:TEST_AUDIO_URL
    }]}}}),
    playBody({data:{dash:{video:[{
      id:32,bandwidth:1,codecs:"av01.0.08M.08",
      mimeType:"video/mp4",baseUrl:TEST_VIDEO_URL
    }]}}})
  ];
  for (const body of invalid) {
    const root=await privateWorkspace("llw-bilibili-play-invalid-");
    let mediaCalls=0;
    const adapter=workingAdapter(async url=>{
      if (url===TEST_VIEW_URL) return jsonResponse(viewBody());
      if (url===TEST_PLAY_URL) return jsonResponse(body);
      mediaCalls++;
      throw new Error("must_not_fetch_media");
    });
    await assert.rejects(
      ()=>adapter.prepare({url:TEST_PAGE_URL,workspaceDir:root}),
      error=>error?.message==="bilibili_control_invalid"
    );
    assert.equal(mediaCalls,0);
    assert.deepEqual(await readdir(root),[]);
  }
});

test("rejects duplicate selected representations as conflicting control data",async()=>{
  const root=await privateWorkspace("llw-bilibili-duplicate-");
  const duplicate={
    id:30216,
    bandwidth:65_590,
    codecs:"mp4a.40.2",
    mimeType:"audio/mp4",
    baseUrl:TEST_AUDIO_URL
  };
  const body=playBody({
    data:{dash:{audio:[duplicate,structuredClone(duplicate)]}}
  });
  let mediaCalls=0;
  const adapter=workingAdapter(async url=>{
    if (url===TEST_VIEW_URL) return jsonResponse(viewBody());
    if (url===TEST_PLAY_URL) return jsonResponse(body);
    mediaCalls++;
    throw new Error("must_not_fetch_media");
  });
  await assert.rejects(
    ()=>adapter.prepare({url:TEST_PAGE_URL,workspaceDir:root}),
    error=>error?.message==="bilibili_control_invalid"
  );
  assert.equal(mediaCalls,0);
  assert.deepEqual(await readdir(root),[]);
});

test("selects an allowed bilivideo.com backup from the real response shape",async()=>{
  const root=await privateWorkspace("llw-bilibili-backup-");
  const safeAudio=
    "https://audio-backup.bilivideo.com/audio.m4s?signed=backup";
  const safeVideo=
    "https://video-backup.bilivideo.com/video.m4s?signed=backup";
  const body=playBody({
    data:{dash:{
      audio:[{
        id:30216,
        bandwidth:65_590,
        codecs:"mp4a.40.2",
        mimeType:"audio/mp4",
        baseUrl:"https://audio.mcdn.bilivideo.cn/audio.m4s",
        backupUrl:[
          "https://audio.edge.mountaintoys.cn/audio.m4s",
          safeAudio
        ]
      }],
      video:[{
        id:32,
        bandwidth:718_893,
        codecs:"avc1.640033",
        mimeType:"video/mp4",
        width:852,
        height:480,
        baseUrl:"https://video.edge.mountaintoys.cn/video.m4s",
        backupUrl:[safeVideo]
      }]
    }}
  });
  const fetched=[];
  const adapter=workingAdapter(async url=>{
    fetched.push(String(url));
    if (url===TEST_VIEW_URL) return jsonResponse(viewBody());
    if (url===TEST_PLAY_URL) return jsonResponse(body);
    if (url===safeAudio) return mediaResponse(AUDIO_BYTES);
    if (url===safeVideo) return mediaResponse(VIDEO_BYTES);
    throw new Error("unexpected_url");
  });
  const result=await adapter.prepare({
    url:TEST_PAGE_URL,workspaceDir:root
  });
  assert.equal(result.audio.detectedMime,"audio/mp4");
  assert.equal(result.video.detectedMime,"video/mp4");
  assert.deepEqual(
    fetched,
    [TEST_VIEW_URL,TEST_PLAY_URL,safeAudio,safeVideo]
  );
});

test("enforces audio size and removes partial output",async()=>{
  const root=await privateWorkspace("llw-bilibili-limit-");
  const oversized=Buffer.alloc(32*1024*1024+1,0x61);
  const adapter=workingAdapter(async url=>{
    if (url===TEST_VIEW_URL) return jsonResponse(viewBody());
    if (url===TEST_PLAY_URL) return jsonResponse(playBody());
    if (url===TEST_AUDIO_URL) return mediaResponse(oversized);
    throw new Error("video_must_not_start");
  });
  await assert.rejects(
    ()=>adapter.prepare({url:TEST_PAGE_URL,workspaceDir:root}),
    error=>error?.message==="bilibili_limit_exceeded"
  );
  assert.deepEqual(await readdir(root),[]);
});

test("rejects wrong container or duration without published files",async()=>{
  for (const inspectMediaHeader of [
    async()=>({
      detectedMime:"audio/webm",format:"webm",
      durationMs:TEST_DURATION_MS,limitations:[]
    }),
    async({kind})=>({
      detectedMime:kind==="audio"?"audio/mp4":"video/mp4",
      format:kind==="audio"?"m4a":"mp4",
      durationMs:TEST_DURATION_MS+5_001,
      limitations:[]
    })
  ]) {
    const root=await privateWorkspace("llw-bilibili-inspect-");
    const adapter=createBilibiliPublicAdapter({
      lookupAll:publicLookup,
      inspectMediaHeader,
      fetchImpl:async url=>{
        if (url===TEST_VIEW_URL) return jsonResponse(viewBody());
        if (url===TEST_PLAY_URL) return jsonResponse(playBody());
        if (url===TEST_AUDIO_URL) return mediaResponse(AUDIO_BYTES);
        if (url===TEST_VIDEO_URL) return mediaResponse(VIDEO_BYTES);
        throw new Error("unexpected_url");
      }
    });
    await assert.rejects(
      ()=>adapter.prepare({url:TEST_PAGE_URL,workspaceDir:root}),
      error=>error?.message==="bilibili_media_invalid"
    );
    assert.deepEqual(await readdir(root),[]);
  }
});

test("removes published audio when video download fails",async()=>{
  const root=await privateWorkspace("llw-bilibili-video-fail-");
  const adapter=workingAdapter(async url=>{
    if (url===TEST_VIEW_URL) return jsonResponse(viewBody());
    if (url===TEST_PLAY_URL) return jsonResponse(playBody());
    if (url===TEST_AUDIO_URL) return mediaResponse(AUDIO_BYTES);
    throw new Error("synthetic_video_failure");
  });
  await assert.rejects(
    ()=>adapter.prepare({url:TEST_PAGE_URL,workspaceDir:root}),
    error=>error?.message==="bilibili_media_unavailable"
  );
  assert.deepEqual(await readdir(root),[]);
});

test("maps a media redirect outside bilivideo.com to media unavailable",async()=>{
  const root=await privateWorkspace("llw-bilibili-media-redirect-");
  const adapter=workingAdapter(async url=>{
    if (url===TEST_VIEW_URL) return jsonResponse(viewBody());
    if (url===TEST_PLAY_URL) return jsonResponse(playBody());
    if (url===TEST_AUDIO_URL) {
      return redirectResponse("https://example.com/audio.m4s");
    }
    throw new Error("must_not_follow_unsafe_redirect");
  });
  await assert.rejects(
    ()=>adapter.prepare({url:TEST_PAGE_URL,workspaceDir:root}),
    error=>error?.message==="bilibili_media_unavailable"
  );
  assert.deepEqual(await readdir(root),[]);
});

test("cancellation prevents network and leaves no output",async()=>{
  const root=await privateWorkspace("llw-bilibili-cancel-");
  const controller=new AbortController();
  controller.abort();
  let fetched=false;
  const adapter=workingAdapter(async()=>{
    fetched=true;
    throw new Error("must_not_fetch");
  });
  await assert.rejects(
    ()=>adapter.prepare({
      url:TEST_PAGE_URL,
      workspaceDir:root,
      signal:controller.signal
    }),
    error=>error?.message==="bilibili_media_unavailable"
  );
  assert.equal(fetched,false);
  assert.deepEqual(await readdir(root),[]);
});

function workingAdapter(fetchImpl,lookupAll=publicLookup) {
  return createBilibiliPublicAdapter({
    fetchImpl,lookupAll,inspectMediaHeader:syntheticInspector
  });
}

async function privateWorkspace(prefix) {
  const root=await mkdtemp(join(tmpdir(),prefix));
  assert.deepEqual(await readdir(root),[]);
  return root;
}
