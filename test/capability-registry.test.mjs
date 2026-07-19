import test from "node:test";
import assert from "node:assert/strict";
import {buildCapabilityRegistry} from "../src/capabilities/index.mjs";

test("registry has stable explicit order and omits disabled capabilities",() => {
  const daily={name:"daily-work"},invoice={name:"invoice"};
  assert.deepEqual(buildCapabilityRegistry({dailyWork:daily,invoice,enabled:{"daily-work":true,invoice:true}}),[daily,invoice]);
  assert.deepEqual(buildCapabilityRegistry({dailyWork:daily,invoice,enabled:{"daily-work":true,invoice:false}}),[daily]);
});
