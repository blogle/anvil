import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { OpenCodeAdapter } from "../src/providers/opencode";

const executable = process.argv[2];
const expectedVersion = process.argv[3];
if (executable === undefined || expectedVersion === undefined)
  throw new Error("usage: bun smoke-opencode-runtime.ts EXECUTABLE VERSION");

const home = mkdtempSync(join(tmpdir(), "anvil-opencode-runtime-smoke-"));
const configHome = join(home, "config");
const cacheHome = join(home, "cache");
const dataHome = join(home, "data");
const stateHome = join(home, "state");
const temporaryHome = join(home, "tmp");
const serverPassword = randomBytes(24).toString("hex");
for (const directory of [
  configHome,
  cacheHome,
  dataHome,
  stateHome,
  temporaryHome,
])
  mkdirSync(directory);

const portProbe = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response(),
});
const port = portProbe.port;
portProbe.stop(true);
const unavailableProbe = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response(),
});
const unavailablePort = unavailableProbe.port;
unavailableProbe.stop(true);
if (unavailablePort === port)
  throw new Error("OpenCode smoke could not reserve distinct ports");
const baseUrl = `http://127.0.0.1:${port}/`;
const server = Bun.spawn(
  [executable, "serve", "--hostname", "127.0.0.1", "--port", String(port)],
  {
    cwd: home,
    env: {
      HOME: home,
      XDG_CONFIG_HOME: configHome,
      XDG_CACHE_HOME: cacheHome,
      XDG_DATA_HOME: dataHome,
      XDG_STATE_HOME: stateHome,
      TMPDIR: temporaryHome,
      PATH: dirname(executable),
      OPENCODE_SERVER_PASSWORD: serverPassword,
      NO_COLOR: "1",
    },
    stdout: "ignore",
    stderr: "pipe",
  },
);
let serverLogs = "";
const serverLogsRead = (async () => {
  const reader = server.stderr.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    serverLogs = `${serverLogs}${decoder.decode(value)}`.replaceAll(
      serverPassword,
      "[redacted]",
    );
  }
})();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function stopServer(): Promise<void> {
  if (server.exitCode !== null) return;
  server.kill("SIGTERM");
  const exitCode = await Promise.race([
    server.exited,
    Bun.sleep(5_000).then(() => null),
  ]);
  assert(exitCode !== null, "OpenCode server did not stop after SIGTERM");
  assert(
    exitCode === 0 || exitCode === 130,
    "OpenCode server returned an unexpected shutdown status",
  );
  try {
    const response = await fetch(`${baseUrl}api/info`, {
      signal: AbortSignal.timeout(500),
    });
    await response.body?.cancel();
    throw new Error("OpenCode server remained reachable after shutdown");
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "OpenCode server remained reachable after shutdown"
    )
      throw error;
  }
}

async function waitForApi(adapter: OpenCodeAdapter) {
  let lastFailure = "OpenCode server has not responded";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server.exitCode !== null) {
      await serverLogsRead;
      throw new Error(
        `OpenCode runtime exited before API startup: ${serverLogs}`,
      );
    }
    const result = await adapter.health();
    if (result.ok) return result.value;
    lastFailure = result.error.message;
    if (
      result.error.kind === "rejected" &&
      result.error.message ===
        "OpenCode API version is not a supported V2 contract"
    )
      throw new Error(
        `OpenCode API rejected the health request: ${result.error.message}`,
      );
    await Bun.sleep(100);
  }
  throw new Error(
    `OpenCode v2 API did not become available (${lastFailure}): ${serverLogs}`,
  );
}

try {
  assert(
    process.getuid !== undefined && process.getuid() !== 0,
    "OpenCode runtime smoke must run as a non-root user",
  );
  const adapter = new OpenCodeAdapter({
    baseUrl,
    password: serverPassword,
    timeoutMs: 2_000,
  });
  const info = await waitForApi(adapter);
  assert(
    info.version === expectedVersion,
    "OpenCode API version did not match the pinned Nix package",
  );

  const created = await adapter.createSession();
  assert(created.ok, "OpenCode session creation route was rejected");
  assert(created.value.id.length > 0, "OpenCode returned an empty Session ID");

  const exists = await adapter.sessionExists(created.value.id);
  assert(exists.ok && exists.value, "OpenCode session observation failed");
  const messages = await adapter.messages(created.value.id);
  assert(messages.ok, "OpenCode message observation route was rejected");
  const active = await adapter.activeSessions();
  assert(active.ok, "OpenCode active-session route was rejected");
  const execution = await adapter.observeExecution(
    created.value.id,
    Date.now(),
    {
      providerId: "smoke-provider",
      modelId: "smoke-model",
    },
  );
  assert(
    execution.kind === "idle" && execution.sessionId === created.value.id,
    "new OpenCode Session did not observe as idle",
  );

  const unavailableAdapter = new OpenCodeAdapter({
    baseUrl: `http://127.0.0.1:${unavailablePort}/`,
    password: serverPassword,
    timeoutMs: 500,
  });
  const unavailable = await unavailableAdapter.health();
  assert(
    !unavailable.ok && unavailable.error.kind === "unavailable",
    "unavailable OpenCode route was incorrectly accepted as healthy",
  );

  await stopServer();
  console.log(
    `OpenCode runtime smoke passed: ${info.version}, session create/observe, unavailable-route rejection, SIGTERM`,
  );
} finally {
  await stopServer();
  rmSync(home, { recursive: true, force: true });
}
