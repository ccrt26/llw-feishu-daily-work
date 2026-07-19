import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state-store.mjs";

async function fresh() {
  const dir = await mkdtemp(join(tmpdir(), "llw-state-"));
  return {dir, file: join(dir, "state.json")};
}

function conversation() {
  return {
    id: "c1",
    status: "open",
    turns: [
      {role: "user", text: "我补充一下……", createTime: 1784445972514},
      {role: "assistant", text: "补充哪一场会议？"}
    ],
    candidateIds: ["90f29b02eb9ec9bb"]
  };
}

test("persists a version-2 activity conversation with mode 0600", async () => {
  const {file} = await fresh();
  const store = await StateStore.open(file);
  await store.setConversation(conversation());
  const reopened = await StateStore.open(file);
  assert.deepEqual(reopened.getConversation(), conversation());
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(file, "utf8")).version, 2);
});

test("migrates version-1 pending data without preserving forceDaily semantics", async () => {
  const {file} = await fresh();
  await writeFile(file, JSON.stringify({
    version: 1,
    pending: {messageId: "m1", text: "这个后面再说", createTime: 1784426400000, question: "要记录什么事项？", forceDaily: true},
    outcomes: {old: {status: "ignored", reply: "未入库", recordIds: [], replied: true}}
  }));
  const store = await StateStore.open(file);
  assert.deepEqual(store.getConversation(), {
    id: "legacy-m1",
    status: "open",
    turns: [
      {role: "user", text: "这个后面再说", createTime: 1784426400000},
      {role: "assistant", text: "要记录什么事项？"}
    ],
    candidateIds: []
  });
  const persisted = JSON.parse(await readFile(file, "utf8"));
  assert.equal(persisted.version, 2);
  assert.equal(JSON.stringify(persisted).includes("forceDaily"), false);
  assert.equal(store.hasOutcome("old"), true);
});

test("clears conversation and retains bounded outcomes", async () => {
  const {file} = await fresh();
  const store = await StateStore.open(file, {maxOutcomes: 3});
  await store.setConversation(conversation());
  await store.clearConversation();
  for (let index = 1; index <= 4; index++) {
    await store.saveOutcome(`m${index}`, {status: "ignored", reply: "未入库", recordIds: []});
  }
  assert.equal(store.getConversation(), null);
  assert.equal(store.hasOutcome("m1"), false);
  assert.equal(store.hasOutcome("m4"), true);
});

test("persists outcome before reply and exposes unreplied work", async () => {
  const {file} = await fresh();
  const store = await StateStore.open(file);
  await store.saveOutcome("m1", {status: "committed", reply: "已入库", recordIds: ["r1"]});
  assert.deepEqual(store.unreplied(), [{messageId: "m1", status: "committed", reply: "已入库", recordIds: ["r1"], replied: false}]);
  await store.markReplied("m1");
  assert.deepEqual((await StateStore.open(file)).unreplied(), []);
});
