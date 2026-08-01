import test from "node:test";
import assert from "node:assert/strict";
import {
  isPreparedSourceSetId
} from "../src/core/opaque-identifier.mjs";
import {
  validateLegacyAssistantConversation
} from "../src/personal-assistant/legacy-conversation-state.mjs";

const valid=()=>({
  waitingType:"waiting_file",
  question:"请补充文件。",
  instructionText:"整理材料",
  preparedTool:null,
  confirmed:{},
  turns:[],
  model:"codex",
  preparedSourceSetId:"A".repeat(43),
  startedAt:"2026-07-28T00:00:00.000Z",
  updatedAt:"2026-07-28T00:01:00.000Z"
});

test("keeps only the opaque ID and legacy state validator needed for migration",()=>{
  assert.equal(isPreparedSourceSetId("A".repeat(43)),true);
  for (const value of [
    "../private/source","A".repeat(42),"A".repeat(44),"A+B".padEnd(43,"A")
  ]) {
    assert.equal(isPreparedSourceSetId(value),false);
  }
  assert.deepEqual(
    validateLegacyAssistantConversation(valid()),
    valid()
  );
});

test("rejects forged retained-source state without runtime conversation APIs",()=>{
  assert.throws(
    ()=>validateLegacyAssistantConversation({
      ...valid(),preparedSourceSetId:"../private/source"
    }),
    {message:"legacy_conversation_state_invalid"}
  );
});
