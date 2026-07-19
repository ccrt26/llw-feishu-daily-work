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

test("persists a version-3 activity conversation with mode 0600", async () => {
  const {file} = await fresh();
  const store = await StateStore.open(file);
  await store.setConversation(conversation());
  const reopened = await StateStore.open(file);
  assert.equal(reopened.version(), 3);
  assert.deepEqual(reopened.getConversation(), conversation());
  assert.deepEqual(reopened.getCapabilityState("daily-work"), {conversation: conversation()});
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(file, "utf8")).version, 3);
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
  assert.equal(persisted.version, 3);
  assert.equal(JSON.stringify(persisted).includes("forceDaily"), false);
  assert.equal(store.hasOutcome("old"), true);
});

test("migrates version-2 conversation and outcomes without loss", async () => {
  const {file} = await fresh();
  await writeFile(file, JSON.stringify({
    version: 2,
    conversation: conversation(),
    outcomes: {m1: {status: "committed", reply: "已入库", recordIds: ["r1"], replied: true}}
  }));
  const store = await StateStore.open(file);
  assert.equal(store.version(), 3);
  assert.deepEqual(store.getConversation(), conversation());
  assert.equal(store.hasOutcome("m1"), true);
  const persisted = JSON.parse(await readFile(file, "utf8"));
  assert.equal(persisted.version, 3);
  assert.deepEqual(persisted.capabilityState["daily-work"], {conversation: conversation()});
});

test("clears conversation and retains bounded outcomes", async () => {
  const {file} = await fresh();
  const store = await StateStore.open(file, {maxOutcomes: 3});
  await store.setConversation(conversation());
  await store.clearConversation();
  await store.saveOutcome("m1", {status: "ignored", reply: "未入库", recordIds: []});
  await store.markReplied("m1");
  await store.saveOutcome("m2", {status: "ignored", reply: "未入库", recordIds: []});
  await store.saveOutcome("m3", {status: "ignored", reply: "未入库", recordIds: []});
  await store.saveOutcome("m4", {status: "ignored", reply: "未入库", recordIds: []});
  assert.equal(store.getConversation(), null);
  assert.equal(store.hasOutcome("m1"), false);
  assert.equal(store.hasOutcome("m2"), true);
  assert.equal(store.hasOutcome("m4"), true);
});

test("never evicts unreplied outcomes when the bound is exceeded", async () => {
  const {file} = await fresh();
  const store = await StateStore.open(file, {maxOutcomes: 2});
  await store.saveOutcome("m1", {status: "failed", reply: "失败1", recordIds: []});
  await store.saveOutcome("m2", {status: "failed", reply: "失败2", recordIds: []});
  await store.saveOutcome("m3", {status: "failed", reply: "失败3", recordIds: []});
  assert.equal(store.hasOutcome("m1"), true);
  assert.equal(store.hasOutcome("m2"), true);
  assert.equal(store.hasOutcome("m3"), true);
});

test("persists outcome before reply and exposes unreplied work", async () => {
  const {file} = await fresh();
  const store = await StateStore.open(file);
  await store.saveOutcome("m1", {status: "committed", reply: "已入库", recordIds: ["r1"]});
  assert.deepEqual(store.unreplied(), [{messageId: "m1", status: "committed", reply: "已入库", recordIds: ["r1"], replied: false}]);
  await store.markReplied("m1");
  assert.deepEqual((await StateStore.open(file)).unreplied(), []);
});

test("persists invoice archive transactions and terminal status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llw-state-"));
  const file = join(dir, "state.json");
  const store = await StateStore.open(file);
  await store.prepareInvoiceTransaction("tx-1", {targetRelativePath:"亚信工作/日常发票/餐饮发票/2026年07月/10.00.png",sourceHash:"a".repeat(64)});
  assert.equal(store.listInvoiceTransactions()[0].status,"prepared");
  await store.updateInvoiceTransaction("tx-1","published");
  const reopened = await StateStore.open(file);
  assert.deepEqual(reopened.listInvoiceTransactions(),[{transactionId:"tx-1",targetRelativePath:"亚信工作/日常发票/餐饮发票/2026年07月/10.00.png",sourceHash:"a".repeat(64),status:"published",createdAt:store.listInvoiceTransactions()[0].createdAt}]);
});
