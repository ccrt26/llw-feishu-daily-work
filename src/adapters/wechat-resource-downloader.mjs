import {chmod,lstat,mkdir,mkdtemp,open,rm} from "node:fs/promises";
import {extname,join} from "node:path";
import {decryptWechatMedia} from "./wechat-api.mjs";

const MAX_FILE_BYTES=20*1024*1024;

export async function downloadWechatResource({
  api,resourceId,resources,tempRoot,maxFileBytes,timeoutMs,
  allowedFileExtensions=["pdf"]
}) {
  if (!api||typeof api.downloadEncryptedMedia!=="function"||!(resources instanceof Map)||
      !/^wxr_[a-f0-9]{32}$/.test(resourceId)||typeof tempRoot!=="string"||!tempRoot||
      !Number.isSafeInteger(maxFileBytes)||maxFileBytes<=0||maxFileBytes>MAX_FILE_BYTES||
      !Number.isSafeInteger(timeoutMs)||timeoutMs<=0||timeoutMs>120_000||
      !validAllowedExtensions(allowedFileExtensions)) {
    throw coded("download_failed");
  }
  await mkdir(tempRoot,{recursive:true,mode:0o700});
  const rootInfo=await lstat(tempRoot);
  if (!rootInfo.isDirectory()||rootInfo.isSymbolicLink()||rootInfo.uid!==process.getuid()) throw coded("unsafe_temp_root");
  await chmod(tempRoot,0o700);
  const tempDir=await mkdtemp(join(tempRoot,"job-"));
  await chmod(tempDir,0o700);
  const resource=resources.get(resourceId);
  resources.delete(resourceId);
  try {
    validateResource(resource,allowedFileExtensions);
    let ciphertext;
    try {
      ciphertext=await api.downloadEncryptedMedia({
        url:resource.url,
        maxBytes:maxFileBytes+16,
        timeoutMs
      });
    } catch (error) {
      throw coded(error?.message==="wechat_timeout"?"download_timeout":"download_failed");
    }
    let plaintext;
    try { plaintext=decryptWechatMedia(ciphertext,resource.aesKey); }
    catch { throw coded("download_failed"); }
    if (!plaintext.length||plaintext.length>maxFileBytes) throw coded("download_output_unsafe");
    const extension=detectExtension(plaintext,resource.type,resource.extension);
    if (!extension) throw coded("download_output_unsafe");
    const file=join(tempDir,`attachment.${extension}`);
    const handle=await open(file,"wx",0o600);
    try {
      await handle.writeFile(plaintext);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const info=await lstat(file);
    if (!info.isFile()||info.isSymbolicLink()||info.size!==plaintext.length||(info.mode&0o077)!==0) throw coded("download_output_unsafe");
    return {tempDir,file};
  } catch (error) {
    await rm(tempDir,{recursive:true,force:true});
    if (error?.code) throw error;
    throw coded("download_failed");
  }
}

function validateResource(value,allowedFileExtensions) {
  const fields=new Set(["url","aesKey","type","displayName","extension"]);
  if (!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).length!==fields.size||Object.keys(value).some(key=>!fields.has(key))) throw coded("download_output_unsafe");
  if (!["image","file"].includes(value.type)||typeof value.url!=="string"||!value.url||
      typeof value.aesKey!=="string"||!value.aesKey||typeof value.displayName!=="string"||!value.displayName||
      typeof value.extension!=="string"||
      value.type==="file"&&(
        !allowedFileExtensions.includes(value.extension)||
        extname(value.displayName).slice(1).toLowerCase()!==value.extension
      )) {
    throw coded("download_output_unsafe");
  }
}

function detectExtension(value,type,claimedExtension) {
  if (type==="file") {
    const pdf=value.subarray(0,5).toString("ascii")==="%PDF-";
    if (claimedExtension==="pdf") return pdf?"pdf":null;
    const zip=value.subarray(0,4).equals(Buffer.from([0x50,0x4b,0x03,0x04]));
    if (new Set(["docx","pptx","xlsx"]).has(claimedExtension)) {
      return zip?claimedExtension:null;
    }
    if (pdf||zip||
        value.subarray(0,8).equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]))) {
      return null;
    }
    return new Set(["txt","md"]).has(claimedExtension)?claimedExtension:null;
  }
  if (value.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return "png";
  if (value[0]===0xff&&value[1]===0xd8&&value[2]===0xff) return "jpg";
  if (value.subarray(0,4).toString("ascii")==="RIFF"&&value.subarray(8,12).toString("ascii")==="WEBP") return "webp";
  return null;
}

function validAllowedExtensions(value) {
  return Array.isArray(value)&&value.length>=1&&value.length<=6&&
    new Set(value).size===value.length&&
    value.every(extension=>
      new Set(["pdf","txt","md","docx","pptx","xlsx"]).has(extension)
    );
}

function coded(code) { return Object.assign(new Error(code),{code}); }
