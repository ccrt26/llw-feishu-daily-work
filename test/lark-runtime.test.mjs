import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startLarkListener, sendLarkText } from "../src/lark-runtime.mjs";
import {createLarkMessenger} from "../src/adapters/lark-reply.mjs";

const fixture = fileURLToPath(new URL("./fixtures/fake-lark-cli.mjs", import.meta.url));
const event = {message_id: "m1", content: "测试"};

test("uses existing lark-cli event consumer and delivers NDJSON after ready", async () => {
  await chmod(fixture, 0o755);
  const dir = await mkdtemp(join(tmpdir(), "llw-lark-"));
  const argsFile = join(dir, "args.json");
  const received = [];
  const listener = await startLarkListener({
    cliPath: fixture, profile: "llw-private", onEvent: async item => received.push(item),
    environment: {...process.env, PATH: "/usr/bin:/bin", FAKE_LARK_ARGS: argsFile, FAKE_EVENTS: JSON.stringify([event])}
  });
  await listener.done;
  assert.deepEqual(received, [event]);
  assert.deepEqual(JSON.parse(await readFile(argsFile, "utf8")), ["--profile", "llw-private", "event", "consume", "im.message.receive_v1", "--as", "bot"]);
});

test("uses existing idempotent bot send command", async () => {
  await chmod(fixture, 0o755);
  const dir = await mkdtemp(join(tmpdir(), "llw-lark-send-"));
  const argsFile = join(dir, "args.json");
  await sendLarkText({
    cliPath: fixture, profile: "llw-private", chatId: "chat-1", text: "已入库", idempotencyKey: "reply:m1",
    environment: {...process.env, FAKE_LARK_ARGS: argsFile}
  });
  assert.deepEqual(JSON.parse(await readFile(argsFile, "utf8")), ["--profile", "llw-private", "im", "+messages-send", "--as", "bot", "--chat-id", "chat-1", "--text", "已入库", "--idempotency-key", "reply:m1"]);
});

test("replies to the source invoice message with a stable bot idempotency key",async () => {
  const dir=await mkdtemp(join(tmpdir(),"llw-lark-reply-")); const argsFile=join(dir,"args.json");
  const messenger=createLarkMessenger({cliPath:fixture,profile:"llw-private",boundChatId:"chat-1",environment:{...process.env,FAKE_LARK_ARGS:argsFile}});
  await messenger.send({capability:"invoice",event:{messageId:"m1",chatId:"chat-1"},text:"发票已归档",idempotencyKey:"invoice-reply:m1"});
  assert.deepEqual(JSON.parse(await readFile(argsFile,"utf8")),["--profile","llw-private","im","+messages-reply","--as","bot","--message-id","m1","--text","发票已归档","--idempotency-key","invoice-reply:m1"]);
});
