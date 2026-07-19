import test from "node:test";
import assert from "node:assert/strict";
import {buildCapabilityRegistry} from "../src/capabilities/index.mjs";

test("registry has stable explicit order and omits disabled capabilities",() => {
  const daily={name:"daily-work"},invoice={name:"invoice"};
  const contracts={"daily-work":{capability:"daily-work"},invoice:{capability:"invoice"}};
  assert.deepEqual(buildCapabilityRegistry({dailyWork:daily,invoice,contracts,enabled:{"daily-work":true,invoice:true}}),[
    {...daily,routingContract:contracts["daily-work"]},{...invoice,routingContract:contracts.invoice}
  ]);
  assert.deepEqual(buildCapabilityRegistry({dailyWork:daily,invoice,contracts,enabled:{"daily-work":true,invoice:false}}),[
    {...daily,routingContract:contracts["daily-work"]}
  ]);
});
