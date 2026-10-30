import { afterEach, expect, test } from "bun:test";
import { createDaemonApp } from "../src/daemon";
import { value } from "./support/fixtures";
import { SteeringHarness } from "./support/steering-harness";

let harness: SteeringHarness | undefined;
const servers: ReturnType<typeof Bun.serve>[] = [];
const token = "steering-protocol-operator-token-with-32-characters";
afterEach(() => {
  for (const server of servers) server.stop(true);
  servers.length = 0;
  harness?.close();
  harness = undefined;
});

function serve(h: SteeringHarness, principalId = "operator-1") {
  const app = createDaemonApp({
    application: h.application,
    store: h.store,
    policy: h.policy,
    now: () => h.now,
    config: { bearerToken: token, principalId },
  });
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  servers.push(server);
  return async (
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(new URL(path, server.url), {
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      ...(body === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(body) }),
    });
}

async function mcpClient(http: ReturnType<typeof serve>) {
  const init = await http("/mcp", {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "steering-test", version: "1" },
    },
  });
  expect(init.status).toBe(200);
  const session = init.headers.get("mcp-session-id")!;
  let id = 1;
  return async (name: string, args: unknown) => {
    const response = await http(
      "/mcp",
      {
        jsonrpc: "2.0",
        id: ++id,
        method: "tools/call",
        params: { name, arguments: args },
      },
      { "mcp-session-id": session },
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      result: { isError?: boolean; content: { text: string }[] };
    };
    return payload.result.isError
      ? { protocolError: true }
      : (JSON.parse(payload.result.content[0]!.text) as unknown);
  };
}

test("real local HTTP and MCP share one attributable steering intent, safe dispatch and projection status", async () => {
  const h = new SteeringHarness();
  harness = h;
  await h.initialize();
  h.active = true;
  const http = serve(h);
  const request = h.request();
  const path = "/api/commissions/commission-1/steer";
  expect(
    (await http(path, request, { authorization: "Bearer wrong-token" })).status,
  ).toBe(401);
  expect((await http(path, { ...request, obligations: [] })).status).toBe(400);
  const accepted = await http(path, request);
  expect(accepted.status).toBe(202);
  const payload = (await accepted.json()) as { operation: { id: string } };
  const acceptedVersion = h.store.get("commission-1")!.version;
  const mcp = await mcpClient(http);
  const duplicate = await mcp("steer_assignment", {
    commissionId: "commission-1",
    ...request,
  });
  expect(duplicate).toMatchObject({
    ok: true,
    value: {
      id: payload.operation.id,
      steering: { ...request, principalId: "operator-1" },
    },
  });
  expect(h.store.get("commission-1")!.version).toBe(acceptedVersion);
  expect(
    await mcp("steer_assignment", {
      commissionId: "commission-1",
      ...request,
      instruction: "Changed body",
    }),
  ).toMatchObject({ ok: false, error: { error: "idempotency_conflict" } });
  expect(
    await mcp("steer_assignment", {
      commissionId: "commission-1",
      ...request,
      budget: {},
    }),
  ).toEqual({ protocolError: true });
  expect(
    await mcp("reconcile_commission", { commissionId: "commission-1" }),
  ).toMatchObject({ ok: true, value: { decision: { kind: "wait" } } });
  expect(h.prompts).toHaveLength(0);
  const pending = await (
    await http("/api/commissions/commission-1/projection")
  ).json();
  expect(pending).toMatchObject({
    steeringCommands: [
      {
        operationId: payload.operation.id,
        pending: true,
        target: "session:session-1",
        request: { ...request, principalId: "operator-1" },
        disposition: { kind: "prepared" },
        requestedAt: h.now,
      },
    ],
  });
  expect(
    await mcp("get_commission_projection", { commissionId: "commission-1" }),
  ).toEqual(pending);
  h.active = false;
  expect(
    await mcp("reconcile_commission", { commissionId: "commission-1" }),
  ).toMatchObject({ ok: true });
  expect(h.prompts).toHaveLength(1);
  expect(h.interrupts).toBe(0);
  const observed = await (
    await http("/api/commissions/commission-1/projection")
  ).json();
  expect(observed).toMatchObject({
    steeringCommands: [
      {
        operationId: payload.operation.id,
        pending: false,
        request: { principalId: "operator-1" },
        disposition: { kind: "observed", result: "applied" },
      },
    ],
  });
  expect(
    await mcp("get_history", { commissionId: "commission-1" }),
  ).toMatchObject({ history: expect.any(Array) });
  expect(
    (
      await http(
        path,
        h.request({ idempotencyKey: "stale", expectedGeneration: 99 }),
      )
    ).status,
  ).toBe(409);
  value(await h.application.hold("commission-1", "review", h.now));
  expect((await http(path, h.request({ idempotencyKey: "held" }))).status).toBe(
    409,
  );
  expect(
    h.store.operations("commission-1").filter((o) => o.kind === "steer"),
  ).toHaveLength(1);
});

test("HTTP and MCP cannot turn an authenticated but unauthorized principal into an approver", async () => {
  const h = new SteeringHarness();
  harness = h;
  await h.initialize();
  const denied = serve(h, "unauthorized-worker");
  const request = h.request();
  expect(
    (await denied("/api/commissions/commission-1/steer", request)).status,
  ).toBe(403);
  const mcp = await mcpClient(denied);
  expect(
    await mcp("steer_assignment", { commissionId: "commission-1", ...request }),
  ).toMatchObject({ ok: false, error: { kind: "unauthorized" } });
  expect(
    h.store.operations("commission-1").filter((o) => o.kind === "steer"),
  ).toHaveLength(0);
  expect(h.store.get("commission-1")!.budget.used.instructions).toBe(0);
  expect(h.prompts).toHaveLength(0);
});
