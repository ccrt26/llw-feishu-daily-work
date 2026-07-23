import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {loadRoutingContract,validateRoutingContract} from "../src/core/routing-contract.mjs";

const valid={capability:"daily-work",purpose:"记录明确工作内容",accepts:["text"],positive_examples:["今天完成评审"],negative_examples:["解释什么是评审"],supports_continuation:true};

test("loads one strict routing contract from the business Skill",async () => {
  const dir=await mkdtemp(join(tmpdir(),"llw-contract-"));
  await mkdir(join(dir,"references"));
  await writeFile(join(dir,"references","routing-contract.json"),JSON.stringify(valid));
  assert.deepEqual(await loadRoutingContract(dir,"daily-work"),valid);
});

test("rejects malformed or mismatched routing contracts",() => {
  const invalid=[
    {...valid,extra:true},
    {...valid,capability:"invoice"},
    {...valid,capability:"Bad_Name"},
    {...valid,purpose:""},
    {...valid,accepts:["video"]},
    {...valid,positive_examples:[]},
    {...valid,negative_examples:[""]},
    {...valid,supports_continuation:"yes"}
  ];
  for (const value of invalid) assert.throws(()=>validateRoutingContract(value,"daily-work"),/invalid_routing_contract/);
});
