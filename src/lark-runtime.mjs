import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export async function startLarkListener({cliPath, profile, onEvent, onError = () => {}, environment = process.env, readyTimeoutMs = 30000}) {
  const args = ["--profile", profile, "event", "consume", "im.message.receive_v1", "--as", "bot"];
  const child = spawn(cliPath, args, {env: larkEnvironment(environment), stdio: ["pipe", "pipe", "pipe"]});
  let ready = false;
  let readyResolve;
  let readyReject;
  let queue = Promise.resolve();
  const pendingLines = [];
  const readyPromise = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const timer = setTimeout(() => {
    readyReject(new Error("lark_ready_timeout"));
    child.kill("SIGTERM");
  }, readyTimeoutMs);

  const deliver = line => {
    queue = queue.then(async () => {
      let event;
      try { event = JSON.parse(line); }
      catch { throw new Error("invalid_event_json"); }
      await onEvent(event);
    }).catch(error => onError(new Error(error.message)));
  };

  createInterface({input: child.stdout}).on("line", line => {
    if (!line) return;
    if (ready) deliver(line); else pendingLines.push(line);
  });
  createInterface({input: child.stderr}).on("line", line => {
    if (!ready && line === "[event] ready event_key=im.message.receive_v1") {
      ready = true;
      clearTimeout(timer);
      for (const pending of pendingLines.splice(0)) deliver(pending);
      readyResolve();
    }
  });

  const done = new Promise((resolve, reject) => {
    child.once("error", error => {
      clearTimeout(timer);
      const safe = new Error(`lark_spawn_failed:${error.code || "unknown"}`);
      readyReject(safe);
      reject(safe);
    });
    child.once("close", code => {
      clearTimeout(timer);
      if (!ready) readyReject(new Error(`lark_exited_before_ready:${code}`));
      queue.then(() => code === 0 ? resolve() : reject(new Error(`lark_listener_failed:${code}`)));
    });
  });
  await readyPromise;
  return {
    done,
    stop: async () => {
      if (child.exitCode !== null) return done;
      child.stdin.end();
      const fallback = setTimeout(() => child.kill("SIGTERM"), 5000);
      try { await done; } finally { clearTimeout(fallback); }
    }
  };
}

export async function sendLarkText({cliPath, profile, chatId, text, idempotencyKey, environment = process.env}) {
  const args = ["--profile", profile, "im", "+messages-send", "--as", "bot", "--chat-id", chatId, "--text", text, "--idempotency-key", idempotencyKey];
  const output = await run(cliPath, args, larkEnvironment(environment));
  let parsed;
  try { parsed = JSON.parse(output); }
  catch { throw new Error("lark_send_invalid_response"); }
  if (parsed?.ok !== true) throw new Error("lark_send_failed");
}

function larkEnvironment(environment) {
  const pathParts = ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin", ...(environment.PATH || "").split(":")];
  return {
    ...environment,
    PATH: [...new Set(pathParts.filter(Boolean))].join(":"),
    LARK_CLI_NO_PROXY: "1",
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1"
  };
}

function run(command, args, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {env: environment, stdio: ["ignore", "pipe", "pipe"]});
    let stdout = "";
    let stderrBytes = 0;
    child.stdout.on("data", chunk => {
      stdout += chunk;
      if (stdout.length > 1024 * 1024) child.kill("SIGTERM");
    });
    child.stderr.on("data", chunk => { stderrBytes += chunk.length; });
    child.once("error", error => reject(new Error(`lark_spawn_failed:${error.code || "unknown"}`)));
    child.once("close", code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`lark_failed:${code}:${stderrBytes}`)));
  });
}
