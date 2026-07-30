const URL_PATTERN=
  /https:\/\/[^\s<>()\[\]{}，。；！？、）》】”’"']+/giu;

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
    const platform=platformFor(url.hostname);
    if (!platform) continue;
    requests.push({
      platform,
      url:url.href
    });
  }
  if (requests.length>1) {
    throw new Error("public_video_link_invalid");
  }
  return requests.length?Object.freeze(requests[0]):null;
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
