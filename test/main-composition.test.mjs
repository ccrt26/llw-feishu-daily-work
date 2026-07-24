import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";

test("main validates PDF tools before state and injects the bounded PDF preparer",async () => {
  const source=await readFile(fileURLToPath(new URL("../src/main.mjs",import.meta.url)),"utf8");
  assert.match(source,/import \{loadConfig,validatePdfTools\} from "\.\/config\.mjs"/);
  assert.match(source,/import \{prepareInvoicePdf\} from "\.\/capabilities\/invoice\/pdf-preparer\.mjs"/);
  assert.ok(source.indexOf("await validatePdfTools(invoiceConfig)") < source.indexOf("StateStore.open"));
  assert.match(source,/preparePdf:\(\{file\}\) => prepareInvoicePdf\(\{/);
  for (const field of ["pdfInfoPath","pdfToTextPath","pdfToPpmPath","maxPdfPages","maxPdfTextBytes","maxPdfRenderBytes","pdfPrepareTimeoutMs"]) {
    assert.match(source,new RegExp(`invoiceConfig\\.${field}`));
  }
});

test("main validates business routing contracts and injects one read-only intent router",async () => {
  const source=await readFile(fileURLToPath(new URL("../src/main.mjs",import.meta.url)),"utf8");
  assert.match(source,/import \{loadRoutingContract\} from "\.\/core\/routing-contract\.mjs"/);
  assert.match(source,/import \{validateIntentRouterSkill\} from "\.\/core\/intent-router-client\.mjs"/);
  assert.match(source,/import \{createRouterTextTask,createRouterVisualTask,createDailyWorkInterpretTask,createInvoiceVisualTask\} from "\.\/core\/semantic-tasks\.mjs"/);
  assert.match(source,/import \{createPreparedImageRunner\} from "\.\/core\/prepared-image\.mjs"/);
  assert.match(source,/import \{parseInvoiceResource\} from "\.\/capabilities\/invoice\/resource-marker\.mjs"/);
  assert.match(source,/import \{ModelMode\} from "\.\/core\/model-mode\.mjs"/);
  assert.match(source,/deepseekModel:config\.deepseekModel/);
  assert.match(source,/deepseekKeychainService:config\.deepseekKeychainService/);
  assert.match(source,/deepseekKeychainAccount:config\.deepseekKeychainAccount/);
  assert.match(source,/deepseekEnabled:config\.deepseekEnabled/);
  assert.match(source,/feishu-intent-router/);
  assert.ok(source.indexOf("await validateIntentRouterSkill(routerSkillRoot)")<source.indexOf("StateStore.open"));
  assert.match(source,/loadRoutingContract\(config\.capabilities\["daily-work"\]\.skillRoot,"daily-work"\)/);
  assert.match(source,/loadRoutingContract\(invoiceConfig\.skillRoot,"invoice"\)/);
  assert.match(source,/buildCapabilityRegistry\(\{dailyWork:dailyCapability,invoice:invoiceCapability,contracts,enabled:/);
  assert.match(source,/new Dispatcher\(\{binding,bindings,state,capabilities,intentRouter,withPreparedImage,messenger,modelMode,deepseekEnabled:config\.deepseekEnabled\}\)/);
  assert.match(source,/const routerText=createRouterTextTask\(\{/);
  assert.match(source,/const routerVisual=createRouterVisualTask\(\{/);
  assert.match(source,/const dailyWorkInterpret=createDailyWorkInterpretTask\(\{/);
  assert.match(source,/const invoiceVisual=createInvoiceVisualTask\(\{/);
  assert.match(source,/decide:dailyWorkInterpret/);
  assert.match(source,/decide:invoiceVisual/);
  assert.match(source,/const withPreparedImage=createPreparedImageRunner\(\{/);
  assert.match(source,/const intentRouter=\{decide:routerText,decideVisual:routerVisual\}/);
});

test("keeps every WeChat read and network call at zero when the switch is false",async () => {
  const {startChatEntries}=await import("../src/main.mjs");
  const calls={feishu:0,state:0,keychain:0,fetch:0,media:0};
  const lark={done:new Promise(()=>{}),stop:async()=>{}};
  const result=await startChatEntries({
    wechatEnabled:false,
    startFeishu:async()=>{calls.feishu++;return lark;},
    startWechat:async()=>{
      calls.state++;calls.keychain++;calls.fetch++;calls.media++;
      throw new Error("must_not_start");
    },
    feishuOptions:{},
    wechatOptions:{},
    onWechatLog:()=>{}
  });
  assert.equal(result.larkListener,lark);
  assert.equal(result.wechatListener,null);
  assert.deepEqual(calls,{feishu:1,state:0,keychain:0,fetch:0,media:0});
});

test("starts Feishu first and contains WeChat initialization or listener failure",async () => {
  const {startChatEntries}=await import("../src/main.mjs");
  for (const mode of ["start","done"]) {
    const order=[],handled=[],logs=[];
    let feishuOptions;
    const lark={done:new Promise(()=>{}),stop:async()=>{}};
    const result=await startChatEntries({
      wechatEnabled:true,
      startFeishu:async options=>{order.push("feishu");feishuOptions=options;return lark;},
      startWechat:async()=>{
        order.push("wechat");
        if (mode==="start") throw new Error("wechat secret");
        return {stop:()=>{},done:Promise.reject(new Error("listener secret"))};
      },
      feishuOptions:{onEvent:event=>handled.push(event)},
      wechatOptions:{},
      onWechatLog:code=>logs.push(code)
    });
    await feishuOptions.onEvent({message_id:`${mode}-m1`});
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(order,["feishu","wechat"]);
    assert.deepEqual(handled,[{message_id:`${mode}-m1`}]);
    assert.equal(result.larkListener,lark);
    assert.deepEqual(logs,[mode==="start"?"wechat_start_failed":"wechat_listener_stopped"]);
  }
});
