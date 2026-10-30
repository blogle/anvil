import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationService } from "../src/application";
import { createDaemonApp } from "../src/daemon";
import { projectCommission } from "../src/operational";
import { CommissionStore } from "../src/persistence/sqlite";
import { FakeWorld } from "./support/fake-world";
import { epoch, policy, proposalInput, value } from "./support/fixtures";

let store: CommissionStore | undefined;
let directory: string | undefined;
afterEach(() => {
  store?.close();
  if (directory !== undefined)
    rmSync(directory, { recursive: true, force: true });
});

test("durable operational views survive SQLite reopen, retain provenance, and reject reordered/stale writers", async () => {
  directory = mkdtempSync(join(tmpdir(), "anvil-projections-"));
  const path = join(directory, "state.sqlite");
  store = new CommissionStore(path);
  const world = new FakeWorld();
  world.executionKind = "running";
  const app = new ApplicationService(
    store,
    world,
    world,
    world,
    "controller-1",
    policy,
  );
  expect(app.propose(proposalInput()).ok).toBe(true);
  value(await app.admit("commission-1", "operator-1", epoch));
  const initial = value(await app.reconcile("commission-1", epoch + 1));
  const record = store.reconciliation("commission-1")!;
  expect(record.observation?.value.execution.source).toBe("fake-opencode");
  expect(record.result).toMatchObject({
    kind: "decision",
    decision: { kind: "wait" },
  });
  for (let i = 2; i < 6; i++)
    value(await app.reconcile("commission-1", epoch + i));
  expect(store.get("commission-1")?.version).toBe(initial.commission.version);
  expect(store.decisionHistory("commission-1")).toHaveLength(1);
  expect(store.recordReconciliation("commission-1", record)).toBe(false);
  expect(
    store.recordReconciliation("commission-1", {
      ...record,
      recordedAt: epoch + 100,
      commissionVersion: 0,
    }),
  ).toBe(false);
  store.close();
  store = new CommissionStore(path);
  const commission = store.get("commission-1")!;
  const persisted = store.reconciliation(commission.id)!;
  expect(persisted.recordedAt).toBe(epoch + 5);
  const view = projectCommission(
    commission,
    store.operations(commission.id),
    persisted,
    epoch + 6,
    policy,
  );
  expect(view.freshness).toBe("fresh");
  expect(view.acceptanceGaps).toEqual(["acceptance-1"]);
  expect(view.deployment.kind).toBe("unknown");
  expect(
    projectCommission(commission, [], persisted, epoch + 60_000, policy)
      .freshness,
  ).toBe("stale");
  expect(
    projectCommission(commission, [], persisted, epoch - 1, policy).freshness,
  ).toBe("future");
  expect(
    projectCommission(
      {
        ...commission,
        specificationGeneration: 2,
        version: commission.version + 1,
      },
      [],
      persisted,
      epoch + 6,
      policy,
    ),
  ).toMatchObject({
    observationApplicable: false,
    decisionApplicable: false,
    freshness: "unavailable",
  });
});

test("HTTP and MCP expose the same authenticated operational view and bounded decision history", async () => {
  store = new CommissionStore(":memory:");
  const world = new FakeWorld();
  const application = new ApplicationService(
    store,
    world,
    world,
    world,
    "controller-1",
    policy,
  );
  application.propose(proposalInput());
  value(await application.admit("commission-1", "operator-1", epoch));
  value(await application.reconcile("commission-1", epoch + 1));
  const token = "operational-test-token-at-least-32-characters";
  const app = createDaemonApp({
    application,
    store,
    policy,
    now: () => epoch + 2,
    config: { bearerToken: token, principalId: "operator-1" },
  });
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  expect(
    (await app.request("/api/commissions/commission-1/projection")).status,
  ).toBe(401);
  expect(
    (await app.request("/api/commissions/commission-1/history")).status,
  ).toBe(401);
  expect(
    (await app.request("/api/commissions/missing/projection", { headers }))
      .status,
  ).toBe(404);
  expect(
    (
      await app.request("/api/commissions/commission-1/history?before=NaN", {
        headers,
      })
    ).status,
  ).toBe(400);
  const http = await (
    await app.request("/api/commissions/commission-1/projection", { headers })
  ).json();
  const init = await app.request("/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "operational-test", version: "1" },
      },
    }),
  });
  const sessionHeaders = {
    ...headers,
    "mcp-session-id": init.headers.get("mcp-session-id")!,
  };
  const call = async (name: string) => {
    const response = await app.request("/mcp", {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name, arguments: { commissionId: "commission-1" } },
      }),
    });
    const body = (await response.json()) as {
      result: { content: { text: string }[] };
    };
    return JSON.parse(body.result.content[0]!.text);
  };
  expect(await call("get_commission_projection")).toEqual(http);
  const history = await (
    await app.request("/api/commissions/commission-1/history", { headers })
  ).json();
  expect(await call("get_history")).toEqual(history);
  const entries = store.decisionHistory("commission-1");
  expect(store.decisionHistory("commission-1", entries[0]!.sequence)).toEqual(
    [],
  );
});
