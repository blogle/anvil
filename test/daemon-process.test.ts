import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proposalInput } from "./support/fixtures";

let directory: string | undefined;
type DaemonProcess = Readonly<{
  kill: (signal?: number | NodeJS.Signals) => void;
  exited: Promise<number>;
}>;
let child: DaemonProcess | undefined;

afterEach(async () => {
  if (child !== undefined) {
    child.kill("SIGTERM");
    await child.exited;
    child = undefined;
  }
  if (directory !== undefined)
    rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function reservePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = server;
  server.stop(true);
  return port;
}

function startDaemon(port: number, database: string): DaemonProcess {
  return Bun.spawn(["bun", "run", "src/main.ts"], {
    cwd: process.cwd(),
    env: {
      ...(process.env as Record<string, string>),
      ANVIL_API_TOKEN: "local-process-test-token-at-least-32-characters",
      ANVIL_DATABASE: database,
      ANVIL_RECONCILE_INTERVAL_MS: "10000",
      PORT: String(port),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
}

async function waitReady(baseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/readyz`);
      if (response.ok) return;
    } catch {
      // The process is still binding its local listener.
    }
    await Bun.sleep(25);
  }
  throw new Error("Daemon did not become ready within 2.5 seconds");
}

test("real Bun daemon persists authorized Commission state across process restart", async () => {
  directory = mkdtempSync(join(tmpdir(), "anvil-daemon-process-"));
  const database = join(directory, "daemon.sqlite");
  const port = reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const headers = {
    authorization: "Bearer local-process-test-token-at-least-32-characters",
    "content-type": "application/json",
  };

  child = startDaemon(port, database);
  await waitReady(baseUrl);
  const created = await fetch(`${baseUrl}/api/commissions`, {
    method: "POST",
    headers,
    body: JSON.stringify(proposalInput({ id: "process-commission" })),
  });
  expect(created.status).toBe(201);
  const admitted = await fetch(
    `${baseUrl}/api/commissions/process-commission/admit`,
    { method: "POST", headers, body: "{}" },
  );
  expect(admitted.status).toBe(200);
  child.kill("SIGTERM");
  await child.exited;
  child = undefined;

  child = startDaemon(port, database);
  await waitReady(baseUrl);
  const recovered = await fetch(
    `${baseUrl}/api/commissions/process-commission`,
    { headers: { authorization: headers.authorization } },
  );
  expect(recovered.status).toBe(200);
  expect(await recovered.json()).toMatchObject({
    commission: {
      id: "process-commission",
      lifecycle: "active",
      owner: { controllerId: "anvil-local-controller", epoch: 1 },
    },
  });
});
