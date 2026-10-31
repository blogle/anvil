import { randomBytes } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { OpenCodeAdapter } from "../src/providers/opencode";
import { WorkerBootstrap } from "../src/providers/worker-bootstrap";
import { WorkerGitCapabilitySigner } from "../src/providers/git-credentials";
import { proposeCommission, evolve, type Operation } from "../src/domain";

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
      PATH:
        process.argv[4] === undefined
          ? dirname(executable)
          : (process.env["PATH"] ?? dirname(executable)),
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

  // Validate real listener authentication, not just the controller client's
  // happy path. No model execution is needed for these rejected mutations.
  for (const authorization of [
    undefined,
    `Basic ${Buffer.from("opencode:wrong-password").toString("base64")}`,
  ]) {
    for (const path of [
      "api/session",
      "api/shell",
      "api/experimental/fs/write?path=/tmp/unauthorized-anvil-probe",
      "api/session/foreign/prompt",
      "api/session/foreign/interrupt",
    ]) {
      const response = await fetch(new URL(path, baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authorization === undefined ? {} : { authorization }),
        },
        body: "{}",
        redirect: "error",
      });
      assert(
        response.status === 401,
        "OpenCode accepted an unauthenticated mutation",
      );
      await response.body?.cancel();
    }
  }

  const created = await adapter.createSession();
  assert(created.ok, "OpenCode session creation route was rejected");
  assert(created.value.id.length > 0, "OpenCode returned an empty Session ID");
  const helper = process.argv[4];
  if (helper !== undefined) {
    const now = Date.now();
    const repo = join(home, "workspace");
    mkdirSync(repo);
    const proposal = proposeCommission({
      id: "bootstrap-smoke",
      campaignId: "smoke",
      objective: "Protocol compatibility probe",
      repository: "https://github.com/example/repository",
      integrationTarget: "main",
      obligations: [
        {
          id: "probe",
          description: "No model or GitHub work",
          independentReviewRequired: false,
        },
      ],
      independentReviewRequired: false,
      budget: {
        maxAttempts: 1,
        maxInstructions: 1,
        maxRepairs: 0,
        maxCostMicros: 1,
        deadlineAt: now + 60000,
      },
    });
    assert(proposal.ok, "Probe proposal failed");
    const admitted = evolve(proposal.value.commission, {
      kind: "admit",
      actor: { kind: "approver", identity: "smoke" },
      lease: {
        owner: { controllerId: "smoke", epoch: 1 },
        resourceVersion: "local",
        observedAt: now,
        validUntil: now + 60000,
      },
      attemptId: "attempt",
      assignmentId: "assignment",
      now,
    });
    assert(admitted.ok, "Probe admission failed");
    const operation: Operation = {
      id: "bootstrap-protocol-smoke",
      logicalKey: "bootstrap-protocol-smoke",
      commissionId: "bootstrap-smoke",
      kind: "bootstrap_worker",
      target: `session:${created.value.id}`,
      controllerId: "smoke",
      ownerEpoch: 1,
      specificationGeneration: 1,
      assignmentId: "assignment",
      attemptId: "attempt",
      instructionSequence: 1,
      retryCount: 0,
      candidateRevision: null,
      findingIds: [],
      directive: "Non-model bootstrap probe",
      createdAt: now,
      outcome: { kind: "submitted", submittedAt: now },
    };
    const root = join(home, ".anvil-worker");
    const bootstrap = new WorkerBootstrap({
      signer: new WorkerGitCapabilitySigner(randomBytes(32).toString("hex")),
      credentialUrl: "https://controller.example.invalid/v1/git/credentials",
      privateDirectory: root,
      repositoryDirectory: repo,
      imageHelper: helper,
      targetRef: () => "refs/heads/probe",
    });
    const result = await adapter.bootstrapWorker(
      bootstrap,
      admitted.value.commission,
      operation,
      "workspace",
      created.value.id,
      now,
      async () => true,
    );
    assert(
      result.ok && result.value,
      `Actual OpenCode worker bootstrap failed: ${result.ok ? "unverified receipt" : result.error.message}`,
    );
    assert(
      (statSync(join(root, "capability")).mode & 0o777) === 0o600,
      "Capability mode was not 0600",
    );
    assert(
      (statSync(join(root, "helper")).mode & 0o111) !== 0,
      "Installed helper was not executable",
    );
    assert(
      readFileSync(join(home, ".gitconfig"), "utf8").includes(
        join(root, "helper"),
      ),
      "Worker Git helper was not configured",
    );
    console.log(
      "actual OpenCode shell/fs bootstrap passed: private capability, executable helper, Git config and receipt; no model instruction or provider credential",
    );

    // Same-UID tool execution is not an authentication boundary. This probe
    // records booleans only; the recovered ephemeral credential never leaves
    // the subprocess or enters its arguments, output, or workspace files.
    const marker = join(home, "worker-authority-probe.json");
    const mutation = join(repo, "unauthorized-worker-api-write");
    const probe = `const proc = await Bun.file(${JSON.stringify(`/proc/${server.pid}/environ`)}).text().catch(() => "");
const inherited = process.env.OPENCODE_SERVER_PASSWORD;
const recovered = inherited || proc.split("\\0").find(v => v.startsWith("OPENCODE_SERVER_PASSWORD="))?.slice("OPENCODE_SERVER_PASSWORD=".length);
let created = false, written = false;
if (recovered) {
  const headers = { authorization: "Basic " + Buffer.from("opencode:" + recovered).toString("base64"), "content-type": "application/json" };
  const result = await fetch(${JSON.stringify(`${baseUrl}api/session`)}, { method: "POST", headers, body: "{}", redirect: "error" });
  created = result.ok && typeof (await result.json()).data?.id === "string";
  const write = await fetch(${JSON.stringify(`${baseUrl}api/experimental/fs/write?path=${encodeURIComponent(mutation)}`)}, { method: "POST", headers: { ...headers, "content-type": "application/octet-stream" }, body: "unauthorized worker API write", redirect: "error" });
  written = write.ok;
}
await Bun.write(${JSON.stringify(marker)}, JSON.stringify({ inherited: !!inherited, processReadable: !!proc, created, written }));`;
    const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    const headers = {
      authorization: `Basic ${Buffer.from(`opencode:${serverPassword}`).toString("base64")}`,
      "content-type": "application/json",
    };
    const shell = await fetch(`${baseUrl}api/shell`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        command: `${q(process.execPath)} -e ${q(probe)}`,
        cwd: repo,
        timeout: 10000,
      }),
      redirect: "error",
    });
    assert(shell.ok, "Actual worker authority probe shell was rejected");
    let shellInfo = (
      (await shell.json()) as {
        data: { id: string; status: string; exit?: number };
      }
    ).data;
    for (
      let poll = 0;
      poll < 100 && shellInfo.status === "running";
      poll += 1
    ) {
      await Bun.sleep(100);
      const status = await fetch(`${baseUrl}api/shell/${shellInfo.id}`, {
        headers,
        redirect: "error",
      });
      assert(status.ok, "Actual worker authority probe could not be observed");
      shellInfo = ((await status.json()) as { data: typeof shellInfo }).data;
    }
    assert(
      shellInfo.status === "exited" && shellInfo.exit === 0,
      "Actual worker authority probe failed to execute",
    );
    const exposure = JSON.parse(readFileSync(marker, "utf8")) as {
      inherited: boolean;
      processReadable: boolean;
      created: boolean;
      written: boolean;
    };
    console.log(
      `worker API authority probe: ${JSON.stringify(exposure)} (no credential values)`,
    );
    if (process.argv[5] === "--require-worker-isolation")
      assert(
        !exposure.created && !exposure.written,
        "BLOCKED/WORKER-API: same-UID worker recovers OpenCode authority and can create a Session/write Workspace; deployment isolation is required",
      );
  }

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
