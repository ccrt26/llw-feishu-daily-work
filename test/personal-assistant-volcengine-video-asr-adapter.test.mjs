import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {
  chmod,mkdtemp,rm,symlink,truncate,writeFile
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  createVolcengineVideoAsrAdapter
} from "../src/personal-assistant/volcengine-video-asr-adapter.mjs";
import {
  M4A_BYTES,TEST_KEY,TEST_REQUEST_ID,providerResponse,successBody
} from "./fixtures/volcengine-video-asr.mjs";

const SERVICE="com.llw.assistant.volcengine.video-asr.api-key";
const ACCOUNT="llw-assistant";
const SHA=createHash("sha256").update(M4A_BYTES).digest("hex");
const SUBMIT="https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit";
const QUERY="https://openspeech.bytedance.com/api/v3/auc/bigmodel/query";

async function audioFixture() {
  const root=await mkdtemp(join(tmpdir(),"llw-volcengine-adapter-"));
  const audioFile=join(root,"video-audio.m4a");
  await writeFile(audioFile,M4A_BYTES,{mode:0o600});
  return {root,audioFile,audioSha256:SHA,durationMs:1_000};
}

function usageStore({
  state="reserved",created=true,providerDurationMs=1_021
}={}) {
  const calls=[];
  return {
    calls,
    async reserve(value) {
      calls.push(["reserve",structuredClone(value)]);
      return {
        requestId:TEST_REQUEST_ID,
        state,
        durationMs:value.durationMs,
        created,
        ...(state==="completed"?{providerDurationMs}:{})
      };
    },
    async complete(value) {
      calls.push(["complete",structuredClone(value)]);
      return {
        requestId:value.requestId,
        state:"completed",
        durationMs:1_000,
        providerDurationMs:value.providerDurationMs
      };
    }
  };
}

function adapter({
  store=usageStore(),
  fetchImpl=async()=>providerResponse(),
  keyReader=async()=>TEST_KEY,
  sleepImpl=async()=>{},
  now=Date.now
}={}) {
  return {
    store,
    value:createVolcengineVideoAsrAdapter({
      usageStore:store,
      keychainService:SERVICE,
      keychainAccount:ACCOUNT,
      fetchImpl,keyReader,sleepImpl,now
    })
  };
}

async function cleanup(value) {
  await rm(value.root,{recursive:true,force:true});
}

test("submits bounded Base64 M4A and returns strict final video-audio evidence",async()=>{
  const input=await audioFixture();
  const requests=[];
  const {store,value}=adapter({
    fetchImpl:async(url,options)=>{
      requests.push({url,options});
      if (url===SUBMIT) return providerResponse({body:null});
      if (requests.filter(item=>item.url===QUERY).length===1) {
        return providerResponse({code:"20000001",body:null});
      }
      return providerResponse();
    }
  });
  try {
    const result=await value.transcribe(input);
    assert.equal(requests.length,3);
    assert.equal(requests[0].url,SUBMIT);
    assert.equal(requests[1].url,QUERY);
    assert.equal(requests[2].url,QUERY);
    const submitBody=JSON.parse(requests[0].options.body);
    assert.deepEqual(Object.keys(submitBody),["user","audio","request"]);
    assert.deepEqual(submitBody.user,{uid:"llw-video-asr"});
    assert.deepEqual(submitBody.audio,{
      format:"m4a",data:M4A_BYTES.toString("base64")
    });
    assert.deepEqual(submitBody.request,{model_name:"bigmodel"});
    assert.equal(requests[0].options.headers["X-Api-Key"],TEST_KEY);
    assert.equal(
      requests[0].options.headers["X-Api-Resource-Id"],
      "volc.bigasr.auc"
    );
    assert.equal(
      requests[0].options.headers["X-Api-Request-Id"],
      TEST_REQUEST_ID
    );
    assert.equal(requests[0].options.headers["X-Api-Sequence"],"-1");
    assert.deepEqual(result,{
      providerId:"volcengine",
      apiVersion:"v3",
      resourceId:"volc.bigasr.auc",
      requestProfile:"recording_file_standard_base64_m4a_v1",
      audioSha256:SHA,
      originalDurationMs:1_000,
      providerDurationMs:1_021,
      segments:[
        {
          startMs:100,endMs:500,text:"LLW测试。",
          alternatives:[],isFinal:true,status:"recognized"
        },
        {
          startMs:520,endMs:900,text:"时间三点。",
          alternatives:[],isFinal:true,status:"recognized"
        }
      ],
      coveredRanges:[{startMs:0,endMs:1_021}],
      uncoveredRanges:[],
      coverageStatus:"complete",
      limitations:["provider_utterance_timestamps_not_word_exact"]
    });
    assert.deepEqual(store.calls,[
      ["reserve",{audioSha256:SHA,durationMs:1_000}],
      ["complete",{
        audioSha256:SHA,
        requestId:TEST_REQUEST_ID,
        providerDurationMs:1_021
      }]
    ]);
    assert.equal(JSON.stringify(result).includes(TEST_KEY),false);
    assert.equal(JSON.stringify(result).includes(M4A_BYTES.toString("base64")),false);
  } finally {
    await cleanup(input);
  }
});

test("signals processing only after quota reservation and provider acceptance",async()=>{
  const input=await audioFixture();
  const events=[];
  const store={
    async reserve(value) {
      events.push("reserve");
      return {
        requestId:TEST_REQUEST_ID,
        state:"reserved",
        durationMs:value.durationMs,
        created:true
      };
    },
    async complete(value) {
      events.push("complete");
      return {
        requestId:value.requestId,
        state:"completed",
        durationMs:1_000,
        providerDurationMs:value.providerDurationMs
      };
    }
  };
  const {value}=adapter({
    store,
    keyReader:async()=>{
      events.push("key");
      return TEST_KEY;
    },
    fetchImpl:async url=>{
      if (url===SUBMIT) {
        events.push("submit");
        return providerResponse({body:null});
      }
      events.push("query");
      return providerResponse();
    }
  });
  try {
    const result=await value.transcribe({
      ...input,
      onProcessingAccepted:async()=>{events.push("accepted");}
    });
    assert.equal(result.coverageStatus,"complete");
    assert.deepEqual(events,[
      "key","reserve","submit","accepted","query","complete"
    ]);
  } finally {
    await cleanup(input);
  }
});

test("a processing receipt failure does not change the ASR result",async()=>{
  const input=await audioFixture();
  let callbacks=0;
  const {value}=adapter();
  try {
    const result=await value.transcribe({
      ...input,
      onProcessingAccepted:async()=>{
        callbacks+=1;
        throw new Error("reply_failed");
      }
    });
    assert.equal(callbacks,1);
    assert.equal(result.coverageStatus,"complete");
  } finally {
    await cleanup(input);
  }
});

test("quota rejection never signals processing or reaches the provider",async()=>{
  const input=await audioFixture();
  let callbacks=0,network=0;
  const store={
    async reserve() {
      throw new Error("video_asr_trial_exhausted");
    },
    async complete() {
      throw new Error("unexpected_complete");
    }
  };
  const {value}=adapter({
    store,
    fetchImpl:async()=>{
      network+=1;
      return providerResponse();
    }
  });
  try {
    await assert.rejects(
      ()=>value.transcribe({
        ...input,
        onProcessingAccepted:async()=>{callbacks+=1;}
      }),
      /video_asr_trial_exhausted/
    );
    assert.equal(callbacks,0);
    assert.equal(network,0);
  } finally {
    await cleanup(input);
  }
});

test("does not turn the historical 30-minute candidate bound into a product gate",async()=>{
  const input=await audioFixture();
  input.durationMs=1_800_001;
  const {store,value}=adapter({
    fetchImpl:async url=>url===SUBMIT
      ?providerResponse({body:null})
      :providerResponse({body:successBody({
        audio_info:{duration:1_800_001},
        result:{additions:{duration:"1800001"}}
      })})
  });
  try {
    const result=await value.transcribe(input);
    assert.equal(result.originalDurationMs,1_800_001);
    assert.deepEqual(store.calls[0],[
      "reserve",{audioSha256:SHA,durationMs:1_800_001}
    ]);
  } finally {
    await cleanup(input);
  }
});

test("rejects unsafe or out-of-contract audio before Keychain, quota or network",async t=>{
  const input=await audioFixture();
  const store=usageStore();
  let keyReads=0;
  let network=0;
  const {value}=adapter({
    store,
    keyReader:async()=>{ keyReads+=1; return TEST_KEY; },
    fetchImpl:async()=>{ network+=1; return providerResponse(); }
  });
  try {
    const outside=join(input.root,"outside.m4a");
    await writeFile(outside,M4A_BYTES,{mode:0o600});
    const linked=join(input.root,"linked.m4a");
    await symlink(outside,linked);
    const wrongExtension=join(input.root,"audio.wav");
    await writeFile(wrongExtension,M4A_BYTES,{mode:0o600});
    const empty=join(input.root,"empty.m4a");
    await writeFile(empty,"",{mode:0o600});
    const large=join(input.root,"large.m4a");
    await writeFile(large,M4A_BYTES,{mode:0o600});
    await truncate(large,32*1024*1024+1);
    const broad=join(input.root,"broad.m4a");
    await writeFile(broad,M4A_BYTES,{mode:0o644});
    for (const candidate of [
      {...input,audioFile:linked},
      {...input,audioFile:wrongExtension},
      {...input,audioFile:empty},
      {...input,audioFile:large},
      {...input,audioFile:broad},
      {...input,audioSha256:"f".repeat(64)},
      {...input,durationMs:0},
      {...input,durationMs:18_000_000},
      {...input,audioFile:"relative.m4a"},
      {...input,onProcessingAccepted:"not-a-function"}
    ]) {
      await assert.rejects(
        ()=>value.transcribe(candidate),
        /video_asr_input_invalid/
      );
    }
    assert.equal(keyReads,0);
    assert.equal(network,0);
    assert.equal(store.calls.length,0);
  } finally {
    await cleanup(input);
  }
});

test("reads only the fixed Keychain item and hides unavailable credentials",async()=>{
  const input=await audioFixture();
  try {
    for (const keyReader of [
      async()=>{ throw new Error(`do-not-leak-${TEST_KEY}`); },
      async()=>"",
      async()=>"x".repeat(4_097)
    ]) {
      let network=0;
      const store=usageStore();
      const {value}=adapter({
        store,keyReader,
        fetchImpl:async()=>{ network+=1; return providerResponse(); }
      });
      await assert.rejects(
        async()=>{
          try { await value.transcribe(input); }
          catch (error) {
            assert.equal(error.message,"video_asr_key_unavailable");
            assert.equal(error.message.includes(TEST_KEY),false);
            throw error;
          }
        },
        /video_asr_key_unavailable/
      );
      assert.equal(network,0);
      assert.equal(store.calls.length,0);
    }
  } finally {
    await cleanup(input);
  }
});

test("queries an existing reservation before any submit and never resubmits it",async()=>{
  const input=await audioFixture();
  const requests=[];
  const {value}=adapter({
    store:usageStore({created:false}),
    fetchImpl:async(url)=>{
      requests.push(url);
      return providerResponse();
    }
  });
  try {
    await value.transcribe(input);
    assert.deepEqual(requests,[QUERY]);
  } finally {
    await cleanup(input);
  }
});

test("requires existing completed audio to reuse durable task evidence",async()=>{
  const input=await audioFixture();
  let network=0;
  const {value}=adapter({
    store:usageStore({state:"completed",created:false}),
    fetchImpl:async()=>{ network+=1; return providerResponse(); }
  });
  try {
    await assert.rejects(
      ()=>value.transcribe(input),
      /video_asr_result_reuse_required/
    );
    assert.equal(network,0);
  } finally {
    await cleanup(input);
  }
});

test("maps provider no-speech to explicit complete empty evidence",async()=>{
  const input=await audioFixture();
  const {value}=adapter({
    fetchImpl:async url=>url===SUBMIT
      ?providerResponse({body:null})
      :providerResponse({code:"20000003",body:null,message:"silence"})
  });
  try {
    const result=await value.transcribe(input);
    assert.equal(result.coverageStatus,"complete");
    assert.deepEqual(result.segments,[]);
    assert.deepEqual(result.coveredRanges,[{startMs:0,endMs:1_000}]);
    assert.deepEqual(result.limitations,["no_speech_detected"]);
  } finally {
    await cleanup(input);
  }
});

test("rejects malformed, unsafe and excessive provider responses closed",async t=>{
  const cases=[
    ["http",providerResponse({status:503,body:null}),/video_asr_http_error/],
    ["unknown status",providerResponse({code:"49999999",body:null}),/video_asr_provider_rejected/],
    ["malformed JSON",providerResponse({body:"{"}),/video_asr_response_invalid/],
    ["duration mismatch",providerResponse({
      body:successBody({audio_info:{duration:7_000}})
    }),/video_asr_response_invalid/],
    ["overlapping utterances",providerResponse({
      body:successBody({result:{
        utterances:[
          {start_time:100,end_time:700,text:"A",words:[]},
          {start_time:600,end_time:900,text:"B",words:[]}
        ],
        text:"AB"
      }})
    }),/video_asr_response_invalid/],
    ["out of range utterance",providerResponse({
      body:successBody({result:{
        utterances:[
          {start_time:100,end_time:2_000,text:"A",words:[]}
        ],
        text:"A"
      }})
    }),/video_asr_response_invalid/],
    ["text mismatch",providerResponse({
      body:successBody({result:{text:"different"}})
    }),/video_asr_response_invalid/],
    ["oversized response",providerResponse({
      body:"x".repeat(2*1024*1024+1)
    }),/video_asr_response_too_large/]
  ];
  for (const [name,response,pattern] of cases) {
    await t.test(name,async()=>{
      const input=await audioFixture();
      const {value}=adapter({
        fetchImpl:async url=>url===SUBMIT
          ?providerResponse({body:null})
          :response
      });
      try {
        await assert.rejects(()=>value.transcribe(input),pattern);
      } finally {
        await cleanup(input);
      }
    });
  }
});

test("aborts immediately and enforces the 180-second polling deadline",async()=>{
  const input=await audioFixture();
  try {
    const controller=new AbortController();
    controller.abort();
    let touched=0;
    const {value:aborted}=adapter({
      keyReader:async()=>{ touched+=1; return TEST_KEY; }
    });
    await assert.rejects(
      ()=>aborted.transcribe({...input,signal:controller.signal}),
      /video_asr_aborted/
    );
    assert.equal(touched,0);

    let clock=0;
    const {value:timed}=adapter({
      now:()=>clock,
      sleepImpl:async()=>{ clock+=181_000; },
      fetchImpl:async url=>url===SUBMIT
        ?providerResponse({body:null})
        :providerResponse({code:"20000001",body:null})
    });
    await assert.rejects(
      ()=>timed.transcribe(input),
      /video_asr_timeout/
    );
  } finally {
    await cleanup(input);
  }
});

test("validates fixed configuration without exposing provider choices",()=>{
  const store=usageStore();
  for (const overrides of [
    {usageStore:null},
    {keychainService:"other"},
    {keychainAccount:"other"},
    {fetchImpl:null},
    {keyReader:null},
    {sleepImpl:null},
    {now:null}
  ]) {
    assert.throws(
      ()=>createVolcengineVideoAsrAdapter({
        usageStore:store,
        keychainService:SERVICE,
        keychainAccount:ACCOUNT,
        fetchImpl:async()=>providerResponse(),
        keyReader:async()=>TEST_KEY,
        sleepImpl:async()=>{},
        now:Date.now,
        ...overrides
      }),
      /video_asr_configuration_invalid/
    );
  }
});
