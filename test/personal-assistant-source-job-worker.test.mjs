import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {SourceJobStore} from "../src/personal-assistant/source-job-store.mjs";
import {SourceJobWorker} from "../src/personal-assistant/source-job-worker.mjs";

const BINDING={
  source:"wechat",userId:"wechat-user",conversationId:"wechat-chat"
};

test("runs one source job at a time and deduplicates repeated submission",async()=>{
  const {store,first,second}=await jobs();
  const order=[];
  let releaseFirst;
  const firstWaiting=new Promise(resolve=>{releaseFirst=resolve;});
  const worker=new SourceJobWorker({
    store,
    run:async({preparedSourceSetId})=>{
      order.push(`start:${preparedSourceSetId}`);
      if (preparedSourceSetId===first.preparedSourceSetId) {
        await firstWaiting;
      }
      order.push(`end:${preparedSourceSetId}`);
    }
  });
  assert.equal(worker.submit({...BINDING,...first}).status,"queued");
  assert.equal(worker.submit({...BINDING,...first}).status,"duplicate");
  assert.equal(worker.submit({...BINDING,...second}).status,"queued");
  await nextTurn();
  assert.deepEqual(order,[`start:${first.preparedSourceSetId}`]);
  releaseFirst();
  await worker.flush();
  assert.deepEqual(order,[
    `start:${first.preparedSourceSetId}`,
    `end:${first.preparedSourceSetId}`,
    `start:${second.preparedSourceSetId}`,
    `end:${second.preparedSourceSetId}`
  ]);
});

test("persists and signals cancellation without waiting for the running job",async()=>{
  const {store,first}=await jobs();
  let observedAbort=false;
  const worker=new SourceJobWorker({
    store,
    run:({signal})=>new Promise(resolve=>{
      signal.addEventListener("abort",()=>{
        observedAbort=true;
        resolve();
      },{once:true});
    })
  });
  worker.submit({...BINDING,...first});
  await nextTurn();
  const cancelled=await worker.requestCancel({...BINDING,...first});
  assert.equal(cancelled.cancelRequested,true);
  assert.equal(observedAbort,true);
  await worker.flush();
  assert.equal(
    (await store.get({...BINDING,...first})).state,
    "cancelled"
  );
});

async function jobs() {
  const root=await mkdtemp(join(tmpdir(),"llw-source-worker-"));
  const store=new SourceJobStore({root,now:()=>1_000});
  const first=await store.create({
    ...BINDING,messageKeys:["first"],
    createdAt:"1970-01-01T00:00:01.000Z"
  });
  const second=await store.create({
    ...BINDING,messageKeys:["second"],
    createdAt:"1970-01-01T00:00:01.000Z"
  });
  return {store,first,second};
}

function nextTurn() {
  return new Promise(resolve=>setImmediate(resolve));
}
