export const TEST_BVID="BV1Synthetic";
export const TEST_CID=399_623_486;
export const TEST_DURATION_MS=12_000;
export const TEST_PAGE_URL=
  `https://www.bilibili.com/video/${TEST_BVID}/`;
export const TEST_SHORT_URL="https://b23.tv/llw-test";
export const TEST_VIEW_URL=
  `https://api.bilibili.com/x/web-interface/view?bvid=${TEST_BVID}`;
export const TEST_PLAY_URL=[
  "https://api.bilibili.com/x/player/playurl",
  `?bvid=${TEST_BVID}`,
  `&cid=${TEST_CID}`,
  "&qn=32&fnval=4048&fnver=0&fourk=1"
].join("");

export const TEST_AUDIO_URL=
  "https://audio.example.bilivideo.com/audio-low.m4s?signed=test";
export const TEST_VIDEO_URL=
  "https://video.example.bilivideo.com/video-avc-480.m4s?signed=test";

export const AUDIO_BYTES=Buffer.from([
  0x00,0x00,0x00,0x18,
  0x66,0x74,0x79,0x70,
  0x69,0x73,0x6f,0x35,
  0x00,0x00,0x00,0x00,
  0x69,0x73,0x6f,0x36,
  0x64,0x61,0x73,0x68
]);

export const VIDEO_BYTES=Buffer.from([
  0x00,0x00,0x00,0x18,
  0x66,0x74,0x79,0x70,
  0x69,0x73,0x6f,0x35,
  0x00,0x00,0x00,0x00,
  0x69,0x73,0x6f,0x36,
  0x64,0x61,0x73,0x68,
  0x76,0x69,0x64,0x65,0x6f
]);

export function viewBody(overrides={}) {
  const value={
    code:0,
    message:"0",
    ttl:1,
    data:{
      bvid:TEST_BVID,
      cid:TEST_CID,
      duration:TEST_DURATION_MS/1_000,
      pages:[{
        cid:TEST_CID,
        page:1,
        duration:TEST_DURATION_MS/1_000
      }]
    }
  };
  return merge(value,overrides);
}

export function playBody(overrides={}) {
  const value={
    code:0,
    message:"0",
    ttl:1,
    data:{
      timelength:TEST_DURATION_MS,
      dash:{
        audio:[
          {
            id:30280,
            bandwidth:172_635,
            codecs:"mp4a.40.2",
            mimeType:"audio/mp4",
            baseUrl:TEST_AUDIO_URL.replace("audio-low","audio-high")
          },
          {
            id:30216,
            bandwidth:65_590,
            codecs:"mp4a.40.2",
            mimeType:"audio/mp4",
            baseUrl:TEST_AUDIO_URL
          }
        ],
        video:[
          {
            id:32,
            bandwidth:718_893,
            codecs:"avc1.640033",
            mimeType:"video/mp4",
            width:852,
            height:480,
            baseUrl:TEST_VIDEO_URL
          },
          {
            id:32,
            bandwidth:439_818,
            codecs:"av01.0.08M.08",
            mimeType:"video/mp4",
            width:852,
            height:480,
            baseUrl:TEST_VIDEO_URL.replace("avc","av1")
          },
          {
            id:16,
            bandwidth:300_350,
            codecs:"avc1.640028",
            mimeType:"video/mp4",
            width:640,
            height:360,
            baseUrl:TEST_VIDEO_URL.replace("480","360")
          }
        ]
      }
    }
  };
  return merge(value,overrides);
}

export function jsonResponse(value,status=200) {
  return new Response(
    typeof value==="string"?value:JSON.stringify(value),
    {
      status,
      headers:{"content-type":"application/json; charset=utf-8"}
    }
  );
}

export function redirectResponse(location,status=302) {
  return new Response(null,{status,headers:{location}});
}

export function mediaResponse(bytes,status=200) {
  return new Response(bytes,{
    status,
    headers:{"content-type":"application/octet-stream"}
  });
}

export async function publicLookup(hostname) {
  return hostname.includes("video")
    ?[{address:"2001:4860:4860::8888",family:6}]
    :[{address:"8.8.8.8",family:4}];
}

export async function syntheticInspector({header,kind,durationMs}) {
  if (header.length<12||
      header.subarray(4,8).toString("ascii")!=="ftyp") {
    throw new Error("synthetic_not_iso_bmff");
  }
  return {
    detectedMime:kind==="audio"?"audio/mp4":"video/mp4",
    format:kind==="audio"?"m4a":"mp4",
    durationMs,
    limitations:[]
  };
}

function merge(base,overrides) {
  const result=structuredClone(base);
  for (const [key,value] of Object.entries(overrides||{})) {
    if (key==="data"&&plain(value)) {
      result.data={...result.data,...structuredClone(value)};
      if (plain(value.dash)) {
        result.data.dash={
          ...(base.data?.dash||{}),
          ...structuredClone(value.dash)
        };
      }
    } else {
      result[key]=structuredClone(value);
    }
  }
  return result;
}

function plain(value) {
  return value!==null&&typeof value==="object"&&!Array.isArray(value);
}
