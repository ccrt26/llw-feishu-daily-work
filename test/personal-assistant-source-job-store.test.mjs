import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,readFile,stat
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {SourceJobStore} from "../src/personal-assistant/source-job-store.mjs";

const FEISHU={
  source:"feishu",userId:"feishu-user",conversationId:"feishu-chat"
};
const WECHAT={
  source:"wechat",userId:"wechat-user",conversationId:"wechat-chat"
};

test("creates one private opaque job without storing raw platform identity",async()=>{
  const root=await privateRoot();
  const store=new SourceJobStore({root,now:()=>1_000});
  const created=await store.create({
    ...WECHAT,messageKeys:["message-1"],
    createdAt:"1970-01-01T00:00:01.000Z"
  });
  assert.match(created.preparedSourceSetId,/^[A-Za-z0-9_-]{43}$/u);
  assert.equal((await stat(created.workspaceDir)).mode&0o777,0o700);
  const file=join(created.workspaceDir,"job.json");
  assert.equal((await stat(file)).mode&0o777,0o600);
  const stored=await readFile(file,"utf8");
  for (const secret of [
    WECHAT.userId,WECHAT.conversationId,"message-1",created.workspaceDir
  ]) {
    assert.equal(stored.includes(secret),false);
  }
  assert.equal((await store.get({...WECHAT,...created})).state,"queued");
});

test("refuses cross-entry, cross-user and cross-conversation job access",async()=>{
  const root=await privateRoot();
  const store=new SourceJobStore({root,now:()=>1_000});
  const created=await store.create({
    ...WECHAT,messageKeys:["message-1"],
    createdAt:"1970-01-01T00:00:01.000Z"
  });
  for (const binding of [
    {...FEISHU,preparedSourceSetId:created.preparedSourceSetId},
    {...WECHAT,userId:"other",preparedSourceSetId:created.preparedSourceSetId},
    {
      ...WECHAT,conversationId:"other",
      preparedSourceSetId:created.preparedSourceSetId
    }
  ]) {
    await assert.rejects(
      ()=>store.get(binding),
      /source_job_binding_mismatch/u
    );
  }
});

test("enforces transitions, cancellation and restart recovery checkpoints",async()=>{
  const root=await privateRoot();
  const store=new SourceJobStore({root,now:()=>1_000});
  const created=await store.create({
    ...WECHAT,messageKeys:["message-1"],
    createdAt:"1970-01-01T00:00:01.000Z"
  });
  const binding={...WECHAT,...created};
  await store.transition({...binding,from:"queued",to:"preparing"});
  await assert.rejects(
    ()=>store.transition({...binding,from:"queued",to:"ready"}),
    /source_job_transition_invalid/u
  );
  await store.checkpoint({
    ...binding,name:"original_received",
    value:{sha256:"a".repeat(64)}
  });
  const cancelled=await store.requestCancel(binding);
  assert.equal(cancelled.cancelRequested,true);

  const reopened=new SourceJobStore({root,now:()=>2_000});
  await reopened.recoverInterrupted();
  const recovered=await reopened.get(binding);
  assert.equal(recovered.state,"failed");
  assert.deepEqual(recovered.failure,{
    code:"source_job_interrupted",recoverable:true
  });
  assert.equal(recovered.checkpoints.original_received.sha256,"a".repeat(64));
});

test("expires a job after 24 hours and removes its private workspace",async()=>{
  const root=await privateRoot();
  let now=1_000;
  const store=new SourceJobStore({
    root,ttlMs:86_400_000,now:()=>now
  });
  const created=await store.create({
    ...WECHAT,messageKeys:["message-1"],
    createdAt:"1970-01-01T00:00:01.000Z"
  });
  now+=86_400_001;
  await assert.rejects(
    ()=>store.get({...WECHAT,...created}),
    /source_job_expired/u
  );
  await assert.rejects(()=>stat(created.workspaceDir),/ENOENT/u);
});

test("releases a completed job workspace without reopening the task",async()=>{
  const root=await privateRoot();
  const store=new SourceJobStore({root,now:()=>1_000});
  const created=await store.create({
    ...WECHAT,messageKeys:["message-1"],
    createdAt:"1970-01-01T00:00:01.000Z"
  });
  const binding={...WECHAT,...created};
  await store.transition({...binding,from:"queued",to:"preparing"});
  await store.transition({...binding,from:"preparing",to:"ready"});
  await store.transition({...binding,from:"ready",to:"running_ai"});
  await store.transition({...binding,from:"running_ai",to:"completed"});
  await store.complete(binding);
  await assert.rejects(()=>stat(created.workspaceDir),/ENOENT/u);
});

async function privateRoot() {
  return mkdtemp(join(tmpdir(),"llw-source-jobs-"));
}
