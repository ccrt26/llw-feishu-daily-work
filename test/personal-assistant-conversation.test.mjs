import test from "node:test";
import assert from "node:assert/strict";
import {
  applyConversationDecision,getActiveConversation,clearConversation,
  isConversationCancellation
} from "../src/personal-assistant/conversation.mjs";

const now="2026-07-28T00:00:00.000Z";

test("stores only one bounded waiting_file conversation per channel",() => {
  const state={feishu:null,wechat:null};
  const next=applyConversationDecision({
    state,source:"feishu",now,
    decision:{
      kind:"ask",waitingType:"waiting_file",
      question:"请发送要保存的文件。",
      instructionText:"保存我接下来发的文件",
      preparedTool:"save_knowledge"
    }
  });
  assert.equal(next.feishu.waitingType,"waiting_file");
  assert.equal(next.feishu.instructionText,"保存我接下来发的文件");
  assert.equal(next.wechat,null);
  assert.equal(JSON.stringify(next).includes("/Users/"),false);
});

test("never consumes a pending file across channels and expires after 24 hours",() => {
  const state=applyConversationDecision({
    state:{feishu:null,wechat:null},source:"feishu",now,
    decision:{kind:"ask",waitingType:"waiting_file",question:"请发文件",preparedTool:"save_knowledge"}
  });
  assert.equal(getActiveConversation(state,"wechat","2026-07-28T01:00:00.000Z"),null);
  assert.equal(getActiveConversation(state,"feishu","2026-07-29T00:00:00.001Z"),null);
});

test("explicit cancellation clears state without an AI decision",() => {
  const state={feishu:{waitingType:"waiting_answer"},wechat:null};
  assert.deepEqual(clearConversation(state,"feishu"),{feishu:null,wechat:null});
  assert.equal(isConversationCancellation("不用了，取消"),true);
  assert.equal(isConversationCancellation("取消昨天的记录"),false);
});

test("keeps only one opaque prepared source id while waiting",()=>{
  const preparedSourceSetId="A".repeat(43);
  const next=applyConversationDecision({
    state:{feishu:null,wechat:null},source:"wechat",now,
    decision:{
      kind:"ask",waitingType:"waiting_answer",
      question:"要重点总结哪一部分？",
      instructionText:"总结这个视频",
      preparedTool:null,preparedSourceSetId
    }
  });
  assert.equal(
    next.wechat.preparedSourceSetId,
    preparedSourceSetId
  );
  assert.throws(()=>applyConversationDecision({
    state:{feishu:null,wechat:null},source:"wechat",now,
    decision:{
      kind:"ask",waitingType:"waiting_answer",
      question:"继续吗？",preparedSourceSetId:"../private/source"
    }
  }),/conversation_invalid/u);
});
