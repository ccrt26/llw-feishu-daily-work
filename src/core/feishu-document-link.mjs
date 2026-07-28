const URL_PATTERN=/https:\/\/[^\s<>()\[\]{}，。；！？、）》】”’"']+/gu;
const DOCUMENT_PATH=/^\/(?:docx?|sheets|slides|wiki)\/[A-Za-z0-9_-]+\/?$/u;

export function extractFeishuDocumentRequests(message) {
  if (!message||typeof message!=="object"||Array.isArray(message)||
      message.source!=="feishu") {
    return null;
  }
  const instructionText=typeof message.instructionText==="string"
    ?message.instructionText
    :typeof message.text==="string"
      ?message.text
      :null;
  if (instructionText===null) return null;
  const urls=[...instructionText.matchAll(URL_PATTERN)]
    .map(match=>match[0]);
  if (!urls.length||new Set(urls).size!==urls.length) return null;
  for (const value of urls) {
    try {
      const url=new URL(value);
      const host=url.hostname.toLowerCase();
      const allowedHost=host==="feishu.cn"||host.endsWith(".feishu.cn")||
        host==="larksuite.com"||host.endsWith(".larksuite.com");
      if (url.protocol!=="https:"||!allowedHost||url.username||url.password||
          url.search||url.hash||!DOCUMENT_PATH.test(url.pathname)) {
        return null;
      }
    } catch {
      return null;
    }
  }
  let safeInstructionText=instructionText;
  for (let index=0;index<urls.length;index+=1) {
    safeInstructionText=safeInstructionText.replace(
      urls[index],
      urls.length===1
        ?"[飞书文档快照]"
        :`[飞书文档快照 ${index+1}]`
    );
  }
  return {
    requests:urls.map(url=>({url})),
    safeInstructionText
  };
}
