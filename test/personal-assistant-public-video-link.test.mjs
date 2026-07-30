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
