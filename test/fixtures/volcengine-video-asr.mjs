export const TEST_REQUEST_ID="11111111-1111-4111-8111-111111111111";
export const TEST_KEY="synthetic-key-never-used-on-network";

export const M4A_BYTES=Buffer.from([
  0x00,0x00,0x00,0x18,
  0x66,0x74,0x79,0x70,
  0x4d,0x34,0x41,0x20,
  0x00,0x00,0x00,0x00,
  0x69,0x73,0x6f,0x6d,
  0x6d,0x70,0x34,0x32
]);

export function successBody(overrides={}) {
  const base={
    audio_info:{duration:1_021},
    result:{
      additions:{duration:"1021"},
      text:"LLW测试。时间三点。",
      utterances:[
        {
          start_time:100,
          end_time:500,
          text:"LLW测试。",
          words:[]
        },
        {
          start_time:520,
          end_time:900,
          text:"时间三点。",
          words:[]
        }
      ]
    }
  };
  return {
    ...base,
    ...overrides,
    audio_info:{
      ...base.audio_info,
      ...(overrides.audio_info||{})
    },
    result:{
      ...base.result,
      ...(overrides.result||{})
    }
  };
}

export function providerResponse({
  code="20000000",
  body=successBody(),
  status=200,
  message="OK"
}={}) {
  return new Response(
    body===null?"":typeof body==="string"?body:JSON.stringify(body),
    {
      status,
      headers:{
        "content-type":"application/json",
        "x-api-status-code":code,
        "x-api-message":message,
        "x-tt-logid":"synthetic-log-id"
      }
    }
  );
}
