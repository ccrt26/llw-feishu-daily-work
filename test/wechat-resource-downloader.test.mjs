import test from "node:test";
import assert from "node:assert/strict";
import {createCipheriv} from "node:crypto";
import {lstat,mkdtemp,readFile,readdir,rm,symlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {downloadWechatResource} from "../src/adapters/wechat-resource-downloader.mjs";

const key=Buffer.from("0123456789abcdef");
const keyBase64=key.toString("base64");
const png=Buffer.concat([
  Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
  Buffer.from("test-png")
]);
const pdf=Buffer.from("%PDF-1.4\ntest\n%%EOF\n");

function encrypt(value,selectedKey=key) {
  const cipher=createCipheriv("aes-128-ecb",selectedKey,null);
  return Buffer.concat([cipher.update(value),cipher.final()]);
}

async function run(plaintext,{type="image",displayName="微信图片",extension="",api,entry={}}={}) {
  const root=await mkdtemp(join(tmpdir(),"llw-wechat-download-"));
  const resourceId="wxr_0123456789abcdef0123456789abcdef";
  const resources=new Map([[resourceId,{
    url:"https://media.weixin.qq.com/encrypted",
    aesKey:keyBase64,type,displayName,extension,...entry
  }]]);
  try {
    const result=await downloadWechatResource({
      api:api||{downloadEncryptedMedia:async()=>encrypt(plaintext)},
      resourceId,resources,tempRoot:join(root,"jobs"),
      maxFileBytes:20*1024*1024,timeoutMs:2000
    });
    return {root,result,resources};
  } catch (error) {
    await rm(root,{recursive:true,force:true});
    throw error;
  }
}

test("decrypts one image or PDF into one private ordinary file",async () => {
  for (const [plaintext,options,suffix] of [
    [png,{},".png"],
    [pdf,{type:"file",displayName:"发票.PDF",extension:"pdf"},".pdf"]
  ]) {
    const {root,result,resources}=await run(plaintext,options);
    try {
      assert.deepEqual(await readFile(result.file),plaintext);
      assert.equal(result.file.endsWith(suffix),true);
      assert.equal((await lstat(result.tempDir)).mode&0o777,0o700);
      const info=await lstat(result.file);
      assert.equal(info.isFile(),true);
      assert.equal(info.isSymbolicLink(),false);
      assert.equal(info.mode&0o777,0o600);
      assert.equal(resources.size,0);
      assert.deepEqual(await readdir(result.tempDir),[result.file.split("/").at(-1)]);
    } finally { await rm(root,{recursive:true,force:true}); }
  }
});

test("cleans failed jobs and consumes unsafe in-memory references",async () => {
  for (const [options,code] of [
    [{entry:{aesKey:"bad-key"}},"download_failed"],
    [{api:{downloadEncryptedMedia:async()=>{throw new Error("wechat_timeout");}}},"download_timeout"],
    [{api:{downloadEncryptedMedia:async()=>{throw new Error("network secret");}}},"download_failed"],
    [{type:"file",displayName:"not-an-invoice.txt",extension:"txt"},"download_output_unsafe"]
  ]) {
    const root=await mkdtemp(join(tmpdir(),"llw-wechat-download-fail-"));
    const tempRoot=join(root,"jobs");
    const resourceId="wxr_0123456789abcdef0123456789abcdef";
    const resources=new Map([[resourceId,{
      url:"https://media.weixin.qq.com/encrypted",aesKey:keyBase64,
      type:options.type||"image",displayName:options.displayName||"微信图片",
      extension:options.extension||"",...(options.entry||{})
    }]]);
    try {
      await assert.rejects(()=>downloadWechatResource({
        api:options.api||{downloadEncryptedMedia:async()=>encrypt(png)},
        resourceId,resources,tempRoot,maxFileBytes:20*1024*1024,timeoutMs:100
      }),error=>error.code===code&&!error.message.includes("secret"));
      assert.deepEqual(await readdir(tempRoot),[]);
      assert.equal(resources.size,0);
    } finally { await rm(root,{recursive:true,force:true}); }
  }
});

test("rejects a symbolic-link temp root before media download",async () => {
  const root=await mkdtemp(join(tmpdir(),"llw-wechat-download-link-"));
  const outside=await mkdtemp(join(tmpdir(),"llw-wechat-download-outside-"));
  const tempRoot=join(root,"jobs");
  await symlink(outside,tempRoot);
  let calls=0;
  try {
    await assert.rejects(()=>downloadWechatResource({
      api:{downloadEncryptedMedia:async()=>{calls++;return encrypt(png);}},
      resourceId:"wxr_0123456789abcdef0123456789abcdef",
      resources:new Map([["wxr_0123456789abcdef0123456789abcdef",{
        url:"https://media.weixin.qq.com/encrypted",aesKey:keyBase64,type:"image",displayName:"微信图片",extension:""
      }]]),
      tempRoot,maxFileBytes:20*1024*1024,timeoutMs:100
    }),error=>error.code==="unsafe_temp_root");
    assert.equal(calls,0);
  } finally {
    await rm(root,{recursive:true,force:true});
    await rm(outside,{recursive:true,force:true});
  }
});
