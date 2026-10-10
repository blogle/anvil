// Disposable localhost SendTurn ambiguity probe for the pinned OpenCode v1.18.30.
import { createServer, createConnection } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { closeSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../");

async function freePort() {
  const server = createServer();
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address();
  await new Promise((ok, fail) => server.close((error) => error ? fail(error) : ok()));
  return port;
}

async function api(url, method = "GET", body, timeoutMs = 10000) {
  const response = await fetch(url, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let payload = text;
  try { payload = text ? JSON.parse(text) : null; } catch { /* retain provider text for diagnostics */ }
  return { status: response.status, body: payload };
}

async function waitFor(predicate, label, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await predicate(); if (last) return last; } catch { /* poll transient startup */ }
    await delay(200);
  }
  throw new Error(`timeout waiting for ${label}; last=${JSON.stringify(last)}`);
}

async function messages(base, sessionId) {
  const response = await api(`${base}/session/${sessionId}/message`);
  if (response.status !== 200) throw new Error(`message query returned ${response.status}: ${JSON.stringify(response.body)}`);
  return Array.isArray(response.body) ? response.body : response.body?.data ?? [];
}

const info = (row) => row?.info ?? {};
const hasUser = (rows, messageId) => rows.some((row) => info(row).id === messageId && info(row).role === "user");
const assistantParents = (rows, messageId) => rows.filter((row) => info(row).role === "assistant" && info(row).parentID === messageId).map((row) => info(row).id);
const promptBody = (messageId, text) => ({ messageID: messageId, parts: [{ type: "text", text }], model: { providerID: "openai", modelID: "anvil-scripted" } });

async function main() {
  const openCodePort = await freePort();
  const modelPort = await freePort();
  const temporary = await mkdtemp(`${tmpdir()}/anvil-opencode-spike-`);
  const home = resolve(temporary, "home");
  const configDir = resolve(temporary, "config");
  await mkdir(home, { recursive: true });
  await mkdir(configDir, { recursive: true });
  const config = resolve(configDir, "opencode.jsonc");
  await writeFile(config, JSON.stringify({
    $schema: "https://opencode.ai/config.json", permission: "allow", model: "openai/anvil-scripted",
    provider: { openai: { name: "local spike model", options: { baseURL: `http://127.0.0.1:${modelPort}/v1`, apiKey: "local-only" }, models: { "anvil-scripted": { name: "fixture", tool_call: true } } } },
  }));
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: resolve(home, ".config"), XDG_CACHE_HOME: resolve(home, ".cache"), XDG_DATA_HOME: resolve(home, ".local/share"), XDG_STATE_HOME: resolve(home, ".local/state"), OPENCODE_CONFIG: config, OPENCODE_CONFIG_DIR: configDir, OPENCODE_DISABLE_AUTOUPDATE: "1", OPENAI_API_KEY: "local-only", ANVIL_TEST_MODEL_PORT: String(modelPort), ANVIL_TEST_MODEL_GATE: "1" };
  const modelLog = openSync(resolve(temporary, "model.log"), "w");
  const serverLog = openSync(resolve(temporary, "opencode.log"), "a");
  let model;
  let server;
  const base = `http://127.0.0.1:${openCodePort}`;

  async function startServer() {
    server = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(openCodePort)], { cwd: root, env, stdio: ["ignore", serverLog, serverLog] });
    server.once("exit", (code) => { if (code !== null && code !== 0) serverLog.write(`server exited ${code}\n`); });
    await waitFor(async () => (await api(`${base}/global/health`)).status === 200, "OpenCode health");
  }

  try {
    model = spawn(resolve(root, "target/debug/anvil-test-model"), [], { cwd: root, env, stdio: ["ignore", modelLog, modelLog] });
    await waitFor(async () => (await api(`http://127.0.0.1:${modelPort}/healthz`)).status === 200, "test model health");
    console.error("spike: test model ready");
    await startServer();
    console.error("spike: OpenCode v1.18.30 ready");
    const created = await api(`${base}/session`, "POST", {});
    if (![200, 201].includes(created.status)) throw new Error(`session create returned ${created.status}: ${JSON.stringify(created.body)}`);
    const sessionId = created.body?.id ?? created.body?.sessionID;
    if (!sessionId) throw new Error(`session response had no ID: ${JSON.stringify(created.body)}`);

    const busyId = "msg_anvil_spike_busy_duplicate_01";
    const busyPrompt = promptBody(busyId, "ANVIL-E2E:wait-for-release busy duplicate probe");
    const busyFirst = await api(`${base}/session/${sessionId}/prompt_async`, "POST", busyPrompt);
    console.error(`spike: first prompt status=${busyFirst.status} body=${JSON.stringify(busyFirst.body)}`);
    if (busyFirst.status < 200 || busyFirst.status >= 300) throw new Error(`first prompt failed: ${JSON.stringify(busyFirst)}`);
    await waitFor(async () => hasUser(await messages(base, sessionId), busyId), "busy user message persistence");
    console.error("spike: first busy turn accepted");
    const duplicateBusyPending = api(`${base}/session/${sessionId}/prompt_async`, "POST", busyPrompt, 3000);
    await delay(300);
    await api(`http://127.0.0.1:${modelPort}/__test/release`, "POST", {});
    const duplicateBusy = await duplicateBusyPending;
    await waitFor(async () => assistantParents(await messages(base, sessionId), busyId).length > 0, "busy assistant completion");
    const busyParents = assistantParents(await messages(base, sessionId), busyId);
    const duplicateIdle = await api(`${base}/session/${sessionId}/prompt_async`, "POST", busyPrompt);
    await delay(1000);
    const idleParents = assistantParents(await messages(base, sessionId), busyId);
    console.error("spike: busy/idle duplicate observations complete");

    const timeoutId = "msg_anvil_spike_timeout_after_dispatch_02";
    await api(`http://127.0.0.1:${modelPort}/__test/hold`, "POST", {});
    const payload = JSON.stringify(promptBody(timeoutId, "ANVIL-E2E:wait-for-release timeout probe"));
    await new Promise((ok, fail) => {
      const socket = createConnection({ host: "127.0.0.1", port: openCodePort }, () => {
        socket.write(`POST /session/${sessionId}/prompt_async HTTP/1.1\r\nHost: 127.0.0.1:${openCodePort}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`);
        setTimeout(() => { socket.destroy(); ok(); }, 250);
      });
      socket.once("error", fail);
    });
    await waitFor(async () => hasUser(await messages(base, sessionId), timeoutId), "accepted user message after client close");
    await api(`http://127.0.0.1:${modelPort}/__test/release`, "POST", {});
    await waitFor(async () => assistantParents(await messages(base, sessionId), timeoutId).length > 0, "timeout probe assistant completion");
    console.error("spike: timeout-after-dispatch observation complete");

    server.kill("SIGTERM");
    await new Promise((ok) => server.once("exit", ok));
    await startServer();
    const afterRestart = await messages(base, sessionId);
    const modelLogText = await readFile(resolve(temporary, "model.log"), "utf8");
    const result = {
      pinned_opencode_version: execFileSync("opencode", ["--version"], { cwd: root, env, encoding: "utf8" }).trim(),
      busy_first_http_status: busyFirst.status,
      busy_duplicate_http_status: duplicateBusy.status,
      busy_distinct_assistant_parents_for_message_id: new Set(busyParents).size,
      idle_duplicate_http_status: duplicateIdle.status,
      idle_distinct_assistant_parents_for_message_id: new Set(idleParents).size,
      timeout_after_dispatch_user_persisted: hasUser(afterRestart, timeoutId),
      timeout_after_dispatch_assistant_parent_observed: assistantParents(afterRestart, timeoutId).length > 0,
      restart_preserved_messages: hasUser(afterRestart, busyId) && hasUser(afterRestart, timeoutId),
      local_model_request_lines: modelLogText.split("\n").filter((line) => line.includes("deterministic chat completion request:") || line.includes("deterministic responses request:")).length,
      tools_requested_by_probe: 0,
      user_without_assistant_failure_injection: "UNPROVEN: no pinned OpenCode failpoint was added to crash between persisted user message and ensureRunning.",
    };
    console.log(JSON.stringify(result, null, 2));
    await writeFile(resolve(temporary, "result.json"), JSON.stringify(result, null, 2));
  } finally {
    if (server?.exitCode === null) { server.kill("SIGTERM"); await new Promise((ok) => server.once("exit", ok)); }
    if (model?.exitCode === null) { model.kill("SIGTERM"); await new Promise((ok) => model.once("exit", ok)); }
    closeSync(modelLog);
    closeSync(serverLog);
    // Keep no runtime/session state from this isolated provider probe.
    await rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
