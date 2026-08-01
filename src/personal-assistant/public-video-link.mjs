const URL_PATTERN=
  /https:\/\/[^\s<>()\[\]{}，。；！？、）》】”’"']+/giu;
const BILIBILI_MOBILE_HOST="m.bilibili.com";
const BILIBILI_MOBILE_VIDEO=
  /^\/video\/(BV[A-Za-z0-9]{10})\/?$/u;

export function extractPublicVideoRequest(instructionText) {
  if (typeof instructionText!=="string") {
    throw new Error("public_video_link_invalid");
  }
  const requests=[];
  for (const match of instructionText.matchAll(URL_PATTERN)) {
    let url;
    try {
      url=new URL(match[0]);
    } catch {
      continue;
    }
    const request=normalizeRequest(url);
    if (!request) continue;
    requests.push(request);
  }
  if (requests.length>1) {
    throw new Error("public_video_link_invalid");
  }
  return requests.length?Object.freeze(requests[0]):null;
}

function normalizeRequest(url) {
  if (url.hostname.toLowerCase()!==BILIBILI_MOBILE_HOST) {
    const platform=platformFor(url.hostname);
    return platform?{platform,url:url.href}:null;
  }
  const match=BILIBILI_MOBILE_VIDEO.exec(url.pathname);
  const parts=url.searchParams.getAll("p");
  if (
    url.protocol!=="https:"||url.username||url.password||
    (url.port&&url.port!=="443")||url.hash||!match||
    parts.length>1||(parts.length===1&&parts[0]!=="1")
  ) {
    throw new Error("public_video_link_invalid");
  }
  return {
    platform:"bilibili",
    url:`https://www.bilibili.com/video/${match[1]}/`
  };
}

function platformFor(hostname) {
  const value=hostname.toLowerCase();
  if (value==="b23.tv"||value==="www.bilibili.com") {
    return "bilibili";
  }
  if (value==="www.douyin.com"||value==="v.douyin.com") {
    return "douyin";
  }
  return null;
}
