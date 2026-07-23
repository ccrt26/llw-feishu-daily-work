import test from "node:test";
import assert from "node:assert/strict";
import {validateIntentDecision} from "../src/core/intent-decision-validator.mjs";

const route={action:"route",capability:"daily-work",confidence:"high",reason_code:"direct_match",question:"",reason:""};
const clarify={action:"clarify",capability:"",confidence:"",reason_code:"",question:"你希望我处理什么？",reason:""};
const unsupported={action:"unsupported",capability:"",confidence:"",reason_code:"",question:"",reason:"当前没有相应能力"};

test("normalizes the three exact router actions",() => {
  assert.deepEqual(validateIntentDecision(route,["daily-work","invoice"]),{action:"route",capability:"daily-work",confidence:"high",reasonCode:"direct_match"});
  assert.deepEqual(validateIntentDecision(clarify,["daily-work"]),{action:"clarify",question:"你希望我处理什么？"});
  assert.deepEqual(validateIntentDecision(unsupported,["daily-work"]),{action:"unsupported",reason:"当前没有相应能力"});
});

test("rejects unsafe, ambiguous and unknown router output",() => {
  for (const value of [
    {...route,extra:true}, {...route,capability:"other"}, {...route,confidence:"medium"},
    {...route,reason_code:"bad code"}, {...route,question:"x"}, {...route,reason:"x"},
    {...clarify,question:""}, {...clarify,capability:"daily-work"}, {...clarify,question:"x".repeat(201)},
    {...unsupported,reason:""}, {...unsupported,question:"x"}, {...unsupported,reason:"x".repeat(201)},
    {...route,action:"other"}, [route], null
  ]) assert.throws(()=>validateIntentDecision(value,["daily-work","invoice"]),/invalid_intent_decision/);
});
