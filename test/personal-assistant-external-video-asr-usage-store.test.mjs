import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,lstat,mkdir,mkdtemp,readFile,rm,stat,symlink,writeFile
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  ExternalVideoAsrUsageStore,
  VIDEO_ASR_INITIAL_CONSUMED_MS,
  VIDEO_ASR_TRIAL_HARD_LIMIT_MS
} from "../src/personal-assistant/external-video-asr-usage-store.mjs";

test("includes every approved real ASR call in the retained trial baseline",()=>{
  assert.equal(VIDEO_ASR_INITIAL_CONSUMED_MS,516_317);
});

const SHA_A="a".repeat(64);
const SHA_B="b".repeat(64);

async function fixture(options={}) {
  const root=await mkdtemp(join(tmpdir(),"llw-video-asr-usage-"));
  const parent=join(root,"protected");
  const file=join(parent,"usage.json");
  const store=new ExternalVideoAsrUsageStore({file,...options});
  return {root,parent,file,store};
}

async function cleanup(value) {
  await rm(value.root,{recursive:true,force:true});
}

test("creates one private fail-closed trial ledger seeded with probe usage",async()=>{
  const value=await fixture();
  try {
    const reservation=await value.store.reserve({
      audioSha256:SHA_A,durationMs:30_000
    });
    assert.equal(reservation.state,"reserved");
    assert.equal(reservation.created,true);
    assert.equal(reservation.durationMs,30_000);
    assert.match(reservation.requestId,/^[0-9a-f-]{36}$/u);
    assert.equal((await stat(value.parent)).mode&0o777,0o700);
    assert.equal((await stat(value.file)).mode&0o777,0o600);
    const stored=JSON.parse(await readFile(value.file,"utf8"));
    assert.deepEqual(
      {
        version:stored.version,
        hardLimitMs:stored.hardLimitMs,
        initialConsumedMs:stored.initialConsumedMs
      },
      {
        version:1,
        hardLimitMs:VIDEO_ASR_TRIAL_HARD_LIMIT_MS,
        initialConsumedMs:VIDEO_ASR_INITIAL_CONSUMED_MS
      }
    );
    assert.deepEqual(Object.keys(stored.entries),[SHA_A]);
    assert.equal(JSON.stringify(stored).includes("transcript"),false);
  } finally {
    await cleanup(value);
  }
});

test("serializes concurrent duplicate reservations and charges one duration",async()=>{
  const value=await fixture();
  try {
    const reservations=await Promise.all(Array.from({length:8},()=>
      value.store.reserve({audioSha256:SHA_A,durationMs:45_000})
    ));
    assert.equal(new Set(reservations.map(item=>item.requestId)).size,1);
    assert.equal(reservations.filter(item=>item.created).length,1);
    const stored=JSON.parse(await readFile(value.file,"utf8"));
    assert.equal(Object.keys(stored.entries).length,1);
    assert.equal(stored.entries[SHA_A].durationMs,45_000);
  } finally {
    await cleanup(value);
  }
});

test("does not turn the historical 30-minute candidate bound into a product gate",async()=>{
  const value=await fixture();
  try {
    const reservation=await value.store.reserve({
      audioSha256:SHA_A,durationMs:1_800_001
    });
    assert.equal(reservation.durationMs,1_800_001);
  } finally {
    await cleanup(value);
  }
});

test("charges both completed public probes before enforcing the 19-hour cap",async()=>{
  const value=await fixture();
  try {
    for (let index=1;index<=37;index+=1) {
      await value.store.reserve({
        audioSha256:index.toString(16).padStart(64,"0"),
        durationMs:1_800_000
      });
    }
    await value.store.reserve({
      audioSha256:"e".repeat(64),durationMs:1_283_224
    });
    await assert.rejects(
      ()=>value.store.reserve({audioSha256:SHA_B,durationMs:460}),
      /video_asr_trial_exhausted/
    );
    const stored=JSON.parse(await readFile(value.file,"utf8"));
    assert.equal(Object.keys(stored.entries).length,38);
    assert.equal(Object.hasOwn(stored.entries,SHA_B),false);
  } finally {
    await cleanup(value);
  }
});

test("completes idempotently and restart reuses the same request without releasing quota",async()=>{
  const value=await fixture();
  try {
    const reserved=await value.store.reserve({
      audioSha256:SHA_A,durationMs:30_000
    });
    const completed=await value.store.complete({
      audioSha256:SHA_A,
      requestId:reserved.requestId,
      providerDurationMs:30_021
    });
    assert.equal(completed.state,"completed");
    assert.equal(completed.providerDurationMs,30_021);
    assert.deepEqual(
      await value.store.complete({
        audioSha256:SHA_A,
        requestId:reserved.requestId,
        providerDurationMs:30_021
      }),
      completed
    );
    const restarted=new ExternalVideoAsrUsageStore({file:value.file});
    const reused=await restarted.reserve({
      audioSha256:SHA_A,durationMs:30_000
    });
    assert.equal(reused.created,false);
    assert.equal(reused.requestId,completed.requestId);
    assert.equal(reused.providerDurationMs,completed.providerDurationMs);
    await assert.rejects(
      ()=>restarted.reserve({audioSha256:SHA_A,durationMs:29_999}),
      /video_asr_usage_invalid/
    );
  } finally {
    await cleanup(value);
  }
});

test("rejects unsafe, malformed and contract-mismatched state closed",async t=>{
  await t.test("broad parent",async()=>{
    const value=await fixture();
    try {
      await mkdir(value.parent,{mode:0o755});
      await assert.rejects(
        ()=>value.store.reserve({audioSha256:SHA_A,durationMs:1_000}),
        /video_asr_usage_unavailable/
      );
    } finally { await cleanup(value); }
  });

  await t.test("symlink file",async()=>{
    const value=await fixture();
    try {
      await mkdir(value.parent,{mode:0o700});
      const target=join(value.root,"target.json");
      await writeFile(target,"{}\n",{mode:0o600});
      await symlink(target,value.file);
      await assert.rejects(
        ()=>value.store.reserve({audioSha256:SHA_A,durationMs:1_000}),
        /video_asr_usage_unavailable/
      );
    } finally { await cleanup(value); }
  });

  for (const [name,state] of [
    ["malformed","{"],
    ["wrong version",JSON.stringify({
      version:2,
      hardLimitMs:VIDEO_ASR_TRIAL_HARD_LIMIT_MS,
      initialConsumedMs:VIDEO_ASR_INITIAL_CONSUMED_MS,
      entries:{}
    })],
    ["wrong hard limit",JSON.stringify({
      version:1,
      hardLimitMs:1,
      initialConsumedMs:VIDEO_ASR_INITIAL_CONSUMED_MS,
      entries:{}
    })]
  ]) {
    await t.test(name,async()=>{
      const value=await fixture();
      try {
        await mkdir(value.parent,{mode:0o700});
        await writeFile(value.file,`${state}\n`,{mode:0o600});
        await assert.rejects(
          ()=>value.store.reserve({audioSha256:SHA_A,durationMs:1_000}),
          /video_asr_usage_(?:invalid|unavailable)/
        );
      } finally { await cleanup(value); }
    });
  }

  await t.test("broad state file",async()=>{
    const value=await fixture();
    try {
      await mkdir(value.parent,{mode:0o700});
      await writeFile(value.file,JSON.stringify({
        version:1,
        hardLimitMs:VIDEO_ASR_TRIAL_HARD_LIMIT_MS,
        initialConsumedMs:VIDEO_ASR_INITIAL_CONSUMED_MS,
        entries:{}
      }),{mode:0o644});
      await assert.rejects(
        ()=>value.store.reserve({audioSha256:SHA_A,durationMs:1_000}),
        /video_asr_usage_unavailable/
      );
    } finally { await cleanup(value); }
  });
});

test("atomic replacement failure leaves the prior valid ledger intact",async()=>{
  const value=await fixture();
  try {
    const first=await value.store.reserve({
      audioSha256:SHA_A,durationMs:1_000
    });
    const before=await readFile(value.file,"utf8");
    const failing=new ExternalVideoAsrUsageStore({
      file:value.file,
      renameFile:async()=>{ throw new Error("synthetic_rename_failure"); }
    });
    await assert.rejects(
      ()=>failing.complete({
        audioSha256:SHA_A,
        requestId:first.requestId,
        providerDurationMs:1_000
      }),
      /video_asr_usage_unavailable/
    );
    assert.equal(await readFile(value.file,"utf8"),before);
    const names=await (await import("node:fs/promises")).readdir(value.parent);
    assert.deepEqual(names,["usage.json"]);
    const info=await lstat(value.file);
    assert.equal(info.isFile(),true);
    assert.equal(info.isSymbolicLink(),false);
  } finally {
    await cleanup(value);
  }
});

test("rejects invalid constructor, reservation and completion values",async()=>{
  assert.throws(
    ()=>new ExternalVideoAsrUsageStore({file:"relative"}),
    /video_asr_usage_invalid/
  );
  const value=await fixture();
  try {
    for (const request of [
      {audioSha256:"A".repeat(64),durationMs:1_000},
      {audioSha256:SHA_A,durationMs:0},
      {audioSha256:SHA_A,durationMs:18_000_000}
    ]) {
      await assert.rejects(
        ()=>value.store.reserve(request),
        /video_asr_usage_invalid/
      );
    }
    const reserved=await value.store.reserve({
      audioSha256:SHA_A,durationMs:1_000
    });
    await assert.rejects(
      ()=>value.store.complete({
        audioSha256:SHA_A,
        requestId:"not-the-request",
        providerDurationMs:1_000
      }),
      /video_asr_usage_invalid/
    );
    await chmod(value.file,0o600);
    assert.equal(reserved.state,"reserved");
  } finally {
    await cleanup(value);
  }
});
