import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state-store.mjs";

async function fresh() {
  const dir = await mkdtemp(join(tmpdir(), "llw-state-"));
  return {dir, file: join(dir, "state.json")};
}

test("persists a pending confirmation without message loss", async () => {
  const {file} = await fresh();
  const store = await StateStore.open(file);
  const pending = {messageId: "m1", text: "这个后面再说", createTime: 1784426400000, question: "要记录什么事项？"};
  await store.setPending(pending);
  const reopened = await StateStore.open(file);
  assert.deepEqual(reopened.getPending(), pending);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("persists outcome before reply and exposes unreplied work", async () => {
  const {file} = await fresh();
  const store = await StateStore.open(file);
  await store.saveOutcome("m1", {status: "committed", reply: "已入库", recordIds: ["r1"]});
  assert.equal(store.hasOutcome("m1"), true);
  assert.deepEqual(store.unreplied(), [{messageId: "m1", status: "committed", reply: "已入库", recordIds: ["r1"], replied: false}]);
  await store.markReplied("m1");
  assert.deepEqual((await StateStore.open(file)).unreplied(), []);
});

test("clears pending and retains bounded recent outcomes", async () => {
  const {file} = await fresh();
  const store = await StateStore.open(file, {maxOutcomes: 3});
  await store.setPending({messageId: "p"});
  await store.clearPending();
  for (let index = 1; index <= 4; index++) {
    await store.saveOutcome(`m${index}`, {status: "ignored", reply: "未入库", recordIds: []});
  }
  assert.equal(store.getPending(), null);
  assert.equal(store.hasOutcome("m1"), false);
  assert.equal(store.hasOutcome("m4"), true);
});
