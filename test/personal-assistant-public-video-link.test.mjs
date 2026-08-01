import test from "node:test";
import assert from "node:assert/strict";
import {
  extractPublicVideoRequest
} from "../src/personal-assistant/public-video-link.mjs";

test("extracts one Bilibili public-video request from typed text",()=>{
  assert.deepEqual(
    extractPublicVideoRequest(
      "请总结这个视频，不保存：https://b23.tv/Mn2sUpl"
    ),
    {
      platform:"bilibili",
      url:"https://b23.tv/Mn2sUpl"
    }
  );
});

test("canonicalizes one tracked Bilibili mobile video link",()=>{
  assert.deepEqual(
    extractPublicVideoRequest([
      "总结内容，不保存：",
      "https://m.bilibili.com/video/BV1AbCdEfGhJ?",
      "buvid=redacted&p=1&share_source=WEIXIN"
    ].join("")),
    {
      platform:"bilibili",
      url:"https://www.bilibili.com/video/BV1AbCdEfGhJ/"
    }
  );
  assert.deepEqual(
    extractPublicVideoRequest(
      "总结 https://m.bilibili.com/video/BV1AbCdEfGhJ/"
    ),
    {
      platform:"bilibili",
      url:"https://www.bilibili.com/video/BV1AbCdEfGhJ/"
    }
  );
});

test("rejects unsafe or unsupported Bilibili mobile links",()=>{
  const invalid=[
    "https://m.bilibili.com/video/BV1AbCdEfGhJ?p=2",
    "https://m.bilibili.com/video/BV1AbCdEfGhJ?p=1&p=1",
    "https://user:password@m.bilibili.com/video/BV1AbCdEfGhJ",
    "https://m.bilibili.com:444/video/BV1AbCdEfGhJ",
    "https://m.bilibili.com/video/BV1AbCdEfGhJ#part",
    "https://m.bilibili.com/space/BV1AbCdEfGhJ"
  ];
  for (const url of invalid) {
    assert.throws(
      ()=>extractPublicVideoRequest(`总结 ${url}`),
      /public_video_link_invalid/
    );
  }
});

test("extracts one canonical Douyin public-video request from typed text",()=>{
  assert.deepEqual(
    extractPublicVideoRequest(
      "分析 https://www.douyin.com/video/7645139256003906842"
    ),
    {
      platform:"douyin",
      url:"https://www.douyin.com/video/7645139256003906842"
    }
  );
});

test("extracts one Douyin share short-link from typed text",()=>{
  assert.deepEqual(
    extractPublicVideoRequest(
      "分析这个作品 https://v.douyin.com/hhw45Popmfc/"
    ),
    {
      platform:"douyin",
      url:"https://v.douyin.com/hhw45Popmfc/"
    }
  );
});

test("leaves ordinary text and unrelated web links unchanged",()=>{
  assert.equal(extractPublicVideoRequest("继续推进"),null);
  assert.equal(
    extractPublicVideoRequest("阅读 https://example.com/article"),
    null
  );
});

test("rejects multiple supported public-video links as one ambiguous stage",()=>{
  assert.throws(
    ()=>extractPublicVideoRequest(
      "比较 https://b23.tv/One 和 https://b23.tv/Two"
    ),
    /public_video_link_invalid/
  );
});
