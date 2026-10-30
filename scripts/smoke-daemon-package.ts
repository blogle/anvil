import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const daemonExecutableArgument = process.argv[2];
if (daemonExecutableArgument === undefined)
  throw new Error("usage: bun smoke-daemon-package.ts DAEMON_EXECUTABLE");
const daemonExecutable: string = daemonExecutableArgument;

const directory = mkdtempSync(join(tmpdir(), "anvil-daemon-package-smoke-"));
const databasePath = join(directory, "state.sqlite");
const testToken = "test-only-daemon-smoke-token-not-for-production";
const listener = Bun.serve({ port: 0, fetch: () => new Response() });
const port = listener.port;
listener.stop(true);
const baseUrl = `http://127.0.0.1:${port}`;
const environment = {
  ...process.env,
  ANVIL_API_TOKEN: testToken,
  ANVIL_DATABASE: databasePath,
  ANVIL_PROVIDER_MODE: "unavailable",
  PORT: String(port),
};
type DaemonProcess = Readonly<{
  exitCode: number | null;
  exited: Promise<number>;
  kill: (signal?: number | NodeJS.Signals) => void;
}>;
let daemon: DaemonProcess | undefined;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function startDaemon(): DaemonProcess {
  return Bun.spawn([daemonExecutable], {
    cwd: directory,
    env: environment,
    stdout: "ignore",
    stderr: "ignore",
  });
}

async function waitUntilReady(): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (daemon?.exitCode !== null && daemon?.exitCode !== undefined)
      throw new Error("packaged daemon exited before becoming ready");
    try {
      const [health, ready] = await Promise.all([
        fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(500) }),
        fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(500) }),
      ]);
      if (health.ok && ready.ok) {
        assert(
          (await health.json()).status === "ok",
          "packaged daemon health response was invalid",
        );
        assert(
          (await ready.json()).status === "ready",
          "packaged daemon readiness response was invalid",
        );
        return;
      }
    } catch {
      // The child may still be opening SQLite or binding its listener.
    }
    await Bun.sleep(50);
  }
  throw new Error("packaged daemon health/readiness timed out");
}

async function stopDaemon(): Promise<void> {
  if (daemon === undefined) return;
  const process = daemon;
  daemon = undefined;
  process.kill("SIGTERM");
  const exitCode = await Promise.race([
    process.exited,
    Bun.sleep(3_000).then(() => null),
  ]);
  assert(exitCode !== null, "packaged daemon did not stop after SIGTERM");
  assert(exitCode === 0, "packaged daemon did not exit cleanly after SIGTERM");
}

function databaseFacts(): Readonly<{
  migrationVersion: number;
  commissions: number;
}> {
  const database = new Database(databasePath, { readonly: true });
  try {
    const migration = database
      .query("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version: number | null };
    const rows = database
      .query("SELECT COUNT(*) AS count FROM commissions")
      .get() as { count: number };
    assert(migration.version !== null, "SQLite migrations were not recorded");
    return { migrationVersion: migration.version, commissions: rows.count };
  } finally {
    database.close();
  }
}

try {
  assert(
    process.getuid !== undefined && process.getuid() !== 0,
    "packaged daemon smoke must run as a non-root user",
  );
  daemon = startDaemon();
  await waitUntilReady();
  const ui = await fetch(baseUrl);
  assert(
    ui.ok && ui.headers.get("content-type")?.includes("text/html"),
    "packaged daemon did not serve its built UI",
  );
  assert(
    ui.headers
      .get("content-security-policy")
      ?.includes("frame-ancestors 'none'"),
    "UI lacks its frame isolation policy",
  );
  const html = await ui.text();
  const asset = html.match(/src="(\/assets\/[a-zA-Z0-9_-]+\.js)"/)?.[1];
  assert(
    asset !== undefined,
    "UI HTML does not reference the built JavaScript asset",
  );
  const javascript = await fetch(`${baseUrl}${asset}`);
  assert(
    javascript.ok && (await javascript.text()).includes("Controller decision"),
    "built operational UI asset is unavailable",
  );
  assert(
    (await fetch(`${baseUrl}/api/commissions`)).status === 401,
    "static UI accidentally bypasses API authentication",
  );
  assert(
    (await fetch(`${baseUrl}/assets/package.json`)).status === 404,
    "static handler exposes non-asset files",
  );
  assert(
    (await fetch(`${baseUrl}/api/unknown`)).status === 401,
    "API fallback bypasses authentication",
  );
  const createCommission = await fetch(`${baseUrl}/api/commissions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${testToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      id: "nix-daemon-smoke",
      campaignId: "nix-daemon-smoke-campaign",
      objective: "Verify packaged daemon persistence",
      repository: "https://github.com/acme/demo",
      integrationTarget: "main",
      obligations: [
        {
          id: "smoke-obligation",
          description: "Persist a Commission through the packaged daemon",
          independentReviewRequired: false,
        },
      ],
      independentReviewRequired: false,
      budget: {
        maxAttempts: 1,
        maxInstructions: 2,
        maxRepairs: 1,
        maxCostMicros: 100_000,
        deadlineAt: Date.now() + 600_000,
      },
    }),
  });
  assert(
    createCommission.status === 201,
    "packaged daemon did not persist a Commission",
  );
  const initialFacts = databaseFacts();
  assert(
    initialFacts.migrationVersion === 6,
    "SQLite schema migrations did not reach the current version",
  );
  assert(
    initialFacts.commissions === 1,
    "SQLite Commission row was not created",
  );
  await stopDaemon();

  daemon = startDaemon();
  await waitUntilReady();
  const listed = await fetch(`${baseUrl}/api/commissions`, {
    headers: { authorization: `Bearer ${testToken}` },
  });
  assert(listed.ok, "restarted packaged daemon could not read SQLite state");
  const result = (await listed.json()) as {
    commissions: readonly { id: string }[];
  };
  assert(
    result.commissions.some(({ id }) => id === "nix-daemon-smoke"),
    "Commission state was lost across packaged daemon restart",
  );
  const reopenedFacts = databaseFacts();
  assert(
    reopenedFacts.migrationVersion === initialFacts.migrationVersion &&
      reopenedFacts.commissions === initialFacts.commissions,
    "SQLite schema or Commission rows changed unexpectedly after restart",
  );
  await stopDaemon();
  console.log(
    "packaged daemon smoke passed: built UI/assets, auth, health, readiness, SQLite, SIGTERM, restart",
  );
} finally {
  await stopDaemon();
  rmSync(directory, { recursive: true, force: true });
}
