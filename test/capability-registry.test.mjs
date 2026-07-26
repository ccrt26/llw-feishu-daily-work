import test from "node:test";
import assert from "node:assert/strict";
import {buildCapabilityRegistry} from "../src/capabilities/index.mjs";

test("registry has stable explicit order and omits disabled capabilities",() => {
  const daily={name:"daily-work"},invoice={name:"invoice"};
  const knowledge={name:"knowledge-ingest"};
  const contracts={
    "daily-work":{capability:"daily-work"},
    invoice:{capability:"invoice"},
    "knowledge-ingest":{capability:"knowledge-ingest"}
  };
  assert.deepEqual(buildCapabilityRegistry({
    dailyWork:daily,invoice,knowledgeIngest:knowledge,contracts,
    enabled:{"daily-work":true,invoice:true,"knowledge-ingest":false}
  }),[
    {...daily,routingContract:contracts["daily-work"]},{...invoice,routingContract:contracts.invoice}
  ]);
  assert.deepEqual(buildCapabilityRegistry({
    dailyWork:daily,invoice,knowledgeIngest:knowledge,contracts,
    enabled:{"daily-work":true,invoice:false,"knowledge-ingest":false}
  }),[
    {...daily,routingContract:contracts["daily-work"]}
  ]);
});

test("adds exactly one static knowledge handler only when explicitly enabled",()=>{
  const daily={name:"daily-work"},invoice={name:"invoice"};
  const knowledge={name:"knowledge-ingest",handle:async()=>({status:"ignored"})};
  const contracts={
    "daily-work":{capability:"daily-work"},
    invoice:{capability:"invoice"},
    "knowledge-ingest":{capability:"knowledge-ingest",accepts:["text","file"]}
  };
  const registry=buildCapabilityRegistry({
    dailyWork:daily,invoice,knowledgeIngest:knowledge,contracts,
    enabled:{"daily-work":true,invoice:true,"knowledge-ingest":true}
  });
  assert.deepEqual(registry.map(item=>item.name),[
    "daily-work","invoice","knowledge-ingest"
  ]);
  assert.equal(registry.filter(item=>item.name==="knowledge-ingest").length,1);
  assert.equal(JSON.stringify(registry).includes("/private/"),false);
  assert.throws(
    ()=>buildCapabilityRegistry({
      dailyWork:daily,invoice,contracts,
      enabled:{"daily-work":true,invoice:true,"knowledge-ingest":true}
    }),
    /invalid_capability_registry/
  );
});
