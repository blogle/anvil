import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationService } from "../src/application";
import { createDaemonApp, startReconciliationLoop } from "../src/daemon";
import { CommissionStore } from "../src/persistence/sqlite";
import { FakeWorld } from "./support/fake-world";
import { epoch, policy, proposalInput } from "./support/fixtures";

const token = "test-token-with-at-least-thirty-two-characters";
let directory: string | undefined;
let store: CommissionStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
  if (directory !== undefined)
    rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function setup() {
  directory = mkdtempSync(join(tmpdir(), "anvil-daemon-"));
  store = new CommissionStore(join(directory, "state.sqlite"));
  const world = new FakeWorld();
  const application = new ApplicationService(
    store,
    world,
    world,
    world,
    "controller-1",
    policy,
  );
  const app = createDaemonApp({
    application,
    store,
    config: { bearerToken: token, principalId: "operator-1" },
    policy,
    now: () => epoch + 1,
  });
  return app;
}

function authorized(body?: unknown): RequestInit {
  return {
    ...(body === undefined ? {} : { method: "POST" }),
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

test("authenticated HTTP commands persist through the application and deny unauthenticated writes", async () => {
  const app = setup();
  const health = await app.request("/healthz");
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ status: "ok" });

  const denied = await app.request("/api/commissions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(proposalInput({ id: "denied-commission" })),
  });
  expect(denied.status).toBe(401);
  expect(store?.get("denied-commission")).toBeNull();

  const created = await app.request(
    "/api/commissions",
    authorized(proposalInput({ id: "http-commission" })),
  );
  expect(created.status).toBe(201);
  const admitted = await app.request(
    "/api/commissions/http-commission/admit",
    authorized({}),
  );
  expect(admitted.status).toBe(200);
  const read = await app.request(
    "/api/commissions/http-commission",
    authorized(),
  );
  expect(read.status).toBe(200);
  expect(await read.json()).toMatchObject({
    commission: { id: "http-commission", lifecycle: "active" },
  });
  const held = await app.request(
    "/api/commissions/http-commission/hold",
    authorized({ reason: "operator review" }),
  );
  expect(held.status).toBe(200);
  expect(store?.get("http-commission")?.lifecycle).toBe("held");
});

test("authenticated MCP uses the same durable Commission commands as HTTP", async () => {
  const app = setup();
  const denied = await app.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
  });
  expect(denied.status).toBe(401);

  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const initialized = await app.request("/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1" },
      },
    }),
  });
  expect(initialized.status).toBe(200);
  const sessionId = initialized.headers.get("mcp-session-id");
  expect(sessionId).not.toBeNull();
  const sessionHeaders = {
    ...headers,
    "mcp-session-id": sessionId!,
  };
  const listed = await app.request("/mcp", {
    method: "POST",
    headers: sessionHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }),
  });
  expect(listed.status).toBe(200);
  const payload = (await listed.json()) as {
    result: { tools: readonly { name: string }[] };
  };
  expect(payload.result.tools.map(({ name }) => name)).toContain(
    "hold_commission",
  );

  const created = await app.request(
    "/api/commissions",
    authorized(proposalInput({ id: "mcp-commission" })),
  );
  expect(created.status).toBe(201);
  const call = await app.request("/mcp", {
    method: "POST",
    headers: sessionHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "admit_commission",
        arguments: { commissionId: "mcp-commission" },
      },
    }),
  });
  expect(call.status).toBe(200);
  expect(store?.get("mcp-commission")?.lifecycle).toBe("active");
});

test("daemon reconciliation loop performs an initial durable-state scan and stops", async () => {
  const app = setup();
  const created = await app.request(
    "/api/commissions",
    authorized(proposalInput({ id: "scheduled-commission" })),
  );
  expect(created.status).toBe(201);
  const admitted = await app.request(
    "/api/commissions/scheduled-commission/admit",
    authorized({}),
  );
  expect(admitted.status).toBe(200);

  const world = new FakeWorld();
  const application = new ApplicationService(
    store!,
    world,
    world,
    world,
    "controller-1",
    policy,
  );
  const loop = startReconciliationLoop(application, store!, {
    intervalMs: 60_000,
    now: () => epoch + 10,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await loop.stop();
  expect(world.observationCount).toBeGreaterThan(0);
});

test("an OpenCode execution event wakes only its Commission before the periodic scan", async () => {
  const app = setup();
  const created = await app.request(
    "/api/commissions",
    authorized(proposalInput({ id: "event-woken-commission" })),
  );
  expect(created.status).toBe(201);
  const admitted = await app.request(
    "/api/commissions/event-woken-commission/admit",
    authorized({}),
  );
  expect(admitted.status).toBe(200);
  const otherCreated = await app.request(
    "/api/commissions",
    authorized(proposalInput({ id: "not-woken-commission" })),
  );
  expect(otherCreated.status).toBe(201);
  const otherAdmitted = await app.request(
    "/api/commissions/not-woken-commission/admit",
    authorized({}),
  );
  expect(otherAdmitted.status).toBe(200);

  const world = new FakeWorld();
  world.executionKind = "running";
  const application = new ApplicationService(
    store!,
    world,
    world,
    world,
    "controller-1",
    policy,
  );
  const loop = startReconciliationLoop(application, store!, {
    intervalMs: 60_000,
    now: () => epoch + 10,
  });
  for (
    let attempt = 0;
    attempt < 100 && world.observationCount < 2;
    attempt += 1
  )
    await Bun.sleep(5);
  expect(world.observationCount).toBe(2);
  world.notifyExecutionEvent("event-woken-commission");
  for (
    let attempt = 0;
    attempt < 100 && world.observationCount === 2;
    attempt += 1
  )
    await Bun.sleep(5);
  expect(world.observationCount).toBe(3);
  expect(world.observedCommissionIds.at(-1)).toBe("event-woken-commission");
  await loop.stop();
});
