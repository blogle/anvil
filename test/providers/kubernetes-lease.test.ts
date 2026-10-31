import { afterEach, expect, test } from "bun:test";
import {
  KubernetesLeaseClient,
  leaseName,
} from "../../src/providers/kubernetes-lease";
import { value } from "../support/fixtures";
import { LeaseApiFixture, leaseToken } from "../support/lease-api";

let api: LeaseApiFixture | undefined;
afterEach(() => {
  expect(api?.errors ?? []).toHaveLength(0);
  api?.close();
  api = undefined;
});
async function setup() {
  api = new LeaseApiFixture();
  await api.ready;
  return api;
}
function current(
  client: KubernetesLeaseClient,
  fixture: LeaseApiFixture,
  id = "commission-1",
) {
  return client.current(id, client.controllerId, fixture.now());
}

test("Lease REST acquisition, renewal, namespaced identity and CAS release retain epochs across restart", async () => {
  const fixture = await setup();
  let floor = 0;
  const first = fixture.client("pod-label", () => floor);
  const acquired = value(await current(first, fixture));
  floor = acquired.owner.epoch;
  expect(acquired.owner).toEqual({
    controllerId: first.controllerId,
    epoch: 1,
  });
  expect(acquired.validUntil).toBeLessThan(fixture.wall + 30000);
  expect(fixture.calls.map((c) => c.method)).toEqual(["GET", "POST"]);
  const original = structuredClone(fixture.get());
  expect(original.spec.acquireTime).toMatch(/\.\d{6}Z$/);
  fixture.advance(1000);
  const renewed = value(await current(first, fixture));
  expect(renewed.owner).toEqual(acquired.owner);
  expect(renewed.resourceVersion).not.toBe(acquired.resourceVersion);
  expect(fixture.get().spec.acquireTime).toBe(original.spec.acquireTime);
  expect(fixture.get().spec.renewTime).not.toBe(original.spec.renewTime);
  expect(fixture.calls.at(-1)!.body!.metadata.resourceVersion).toBe(
    acquired.resourceVersion,
  );
  expect((await first.release("commission-1")).ok).toBe(true);
  expect(fixture.get().spec.holderIdentity).toBe("");
  expect(fixture.get().spec.leaseTransitions).toBe(1);
  expect((await current(first, fixture)).ok).toBe(false);
  const restarted = fixture.client("pod-label", () => floor);
  expect(restarted.controllerId).not.toBe(first.controllerId);
  expect(
    (await restarted.current("commission-1", first.controllerId, fixture.wall))
      .ok,
  ).toBe(false);
  expect(value(await current(restarted, fixture)).owner.epoch).toBe(2);
  expect(
    fixture.calls.every(
      (c) =>
        c.path.includes("/namespaces/lease-test/leases") &&
        c.authorization === `Bearer ${leaseToken}`,
    ),
  ).toBe(true);
  expect(fixture.calls.some((c) => c.method === "DELETE")).toBe(false);
  expect(leaseName("Commission/A")).not.toBe(leaseName("commission/a"));
});

test("competing acquisition conflicts and expired foreign takeover require observed monotonic expiry", async () => {
  const fixture = await setup();
  let arrivals = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  fixture.beforeWrite = async () => {
    if (++arrivals === 2) release();
    await barrier;
  };
  const a = fixture.client("a"),
    b = fixture.client("b");
  const results = await Promise.all([current(a, fixture), current(b, fixture)]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(results.filter((r) => !r.ok)).toMatchObject([
    { error: { message: "Kubernetes Lease HTTP 409" } },
  ]);
  fixture.beforeWrite = undefined;
  const winner = results[0]!.ok ? a : b,
    successor = winner === a ? b : a;
  expect((await current(successor, fixture)).ok).toBe(false);
  fixture.advance(33999);
  expect((await current(successor, fixture)).ok).toBe(false);
  fixture.advance(1);
  expect(value(await current(successor, fixture)).owner.epoch).toBe(2);
  expect((await current(winner, fixture)).ok).toBe(false);
  expect(fixture.get().spec.holderIdentity).toBe(successor.controllerId);
});

for (const status of [401, 403, 409, 429, 500, 503])
  test(`Lease HTTP ${status} never reuses prior authority`, async () => {
    const fixture = await setup();
    const client = fixture.client();
    value(await current(client, fixture));
    fixture.status = status;
    const result = await current(client, fixture);
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: [401, 403].includes(status) ? "rejected" : "unavailable",
        message: `Kubernetes Lease HTTP ${status}`,
      },
    });
    expect(fixture.calls.at(-1)!.method).toBe("GET");
    fixture.status = undefined;
    expect((await current(client, fixture)).ok).toBe(true);
  });

test("invalid JSON, wrong resource/epoch/owner and stale successful CAS responses fail closed", async () => {
  const fixture = await setup();
  let floor = 0;
  const client = fixture.client("a", () => floor);
  const initial = value(await current(client, fixture));
  floor = initial.owner.epoch;
  const original = structuredClone(fixture.get());
  for (const corruption of [
    "json",
    "identity",
    "epoch",
    "owner",
    "stale-cas",
    "microsecond",
    "future",
    "date",
  ] as const) {
    fixture.reply = (document) => {
      if (corruption === "json")
        return new Response("invalid JSON", {
          headers: { date: new Date(fixture.wall).toUTCString() },
        });
      if (corruption === "identity") document.metadata.namespace = "foreign";
      if (corruption === "epoch") document.spec.leaseTransitions = 0;
      if (corruption === "owner" && fixture.calls.at(-1)!.method === "PUT")
        document.spec.holderIdentity = "foreign-controller";
      if (corruption === "stale-cas" && fixture.calls.at(-1)!.method === "PUT")
        return fixture.json(original);
      if (
        corruption === "microsecond" &&
        fixture.calls.at(-1)!.method === "PUT"
      )
        document.spec.renewTime = document.spec.renewTime.replace(
          /000Z$/,
          "001Z",
        );
      if (corruption === "future")
        document.spec.renewTime = new Date(fixture.wall + 60000).toISOString();
      if (corruption === "date")
        return Response.json(document, {
          headers: { date: new Date(fixture.wall + 60000).toUTCString() },
        });
      return fixture.json(document);
    };
    expect((await current(client, fixture)).ok).toBe(false);
  }
  fixture.reply = undefined;
  expect((await current(client, fixture)).ok).toBe(true);
  fixture.records.clear();
  expect(await current(client, fixture)).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("Missing Lease history") },
  });
  expect(fixture.calls.at(-1)!.method).toBe("GET");
});

test("renewal write loss reobserves with CAS; copied holder strings without an acquisition receipt cannot authorize", async () => {
  const fixture = await setup();
  const client = fixture.client();
  value(await current(client, fixture));
  fixture.reply = (doc) =>
    fixture.calls.at(-1)!.method === "PUT"
      ? fixture.json({}, 503)
      : fixture.json(doc);
  expect((await current(client, fixture)).ok).toBe(false);
  fixture.reply = undefined;
  expect((await current(client, fixture)).ok).toBe(true);
  const impersonator = fixture.client("same-deployment-label");
  fixture.get().spec.holderIdentity = impersonator.controllerId;
  expect(await current(impersonator, fixture)).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("not acquisition proof") },
  });
});

test("timeout, unavailable transport and local backwards/forward clock jumps cannot produce a grant", async () => {
  const fixture = await setup();
  const client = fixture.client("a", () => 0, { timeoutMs: 100 });
  value(await current(client, fixture));
  fixture.beforeWrite = async () => {
    await Bun.sleep(250);
  };
  expect((await current(client, fixture)).ok).toBe(false);
  await Bun.sleep(300);
  fixture.beforeWrite = undefined;
  expect((await current(client, fixture)).ok).toBe(true);
  fixture.wall -= 10000; // monotonic time did not move backwards
  expect((await current(client, fixture)).ok).toBe(false);
  fixture.wall += 10000;
  expect((await current(client, fixture)).ok).toBe(false); // clock failure is sticky
  const forward = fixture.client("forward");
  expect((await current(forward, fixture)).ok).toBe(false); // foreign holder
  fixture.wall += 60000;
  expect((await current(forward, fixture)).ok).toBe(false);
  const unavailable = fixture.client("offline");
  fixture.close();
  expect(await current(unavailable, fixture)).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("transport") },
  });
});

test("scope, timing, TLS trust and durable epoch regression cannot be silently bypassed", async () => {
  const fixture = await setup();
  expect(() =>
    fixture.client("a", () => 0, { apiServerUrl: "http://cluster.invalid" }),
  ).toThrow();
  expect(() =>
    fixture.client("a", () => 0, { apiServerUrl: "https://cluster.invalid" }),
  ).toThrow();
  expect(() =>
    fixture.client("a", () => 0, { namespace: "../foreign" }),
  ).toThrow();
  expect(() =>
    fixture.client("a", () => 0, { durationSeconds: 10, timeoutMs: 9000 }),
  ).toThrow();
  const first = fixture.client();
  value(await current(first, fixture));
  const successor = fixture.client("successor", () => 9);
  expect((await current(successor, fixture)).ok).toBe(false);
  expect(fixture.get().spec.leaseTransitions).toBe(1);
});

test("stale GET resourceVersion cannot renew and a late successful CAS cannot authorize new effects", async () => {
  const fixture = await setup();
  const client = fixture.client();
  value(await current(client, fixture));
  const stale = structuredClone(fixture.get());
  fixture.advance(1000);
  value(await current(client, fixture));
  fixture.reply = (doc) =>
    fixture.json(fixture.calls.at(-1)!.method === "GET" ? stale : doc);
  expect(await current(client, fixture)).toMatchObject({
    ok: false,
    error: { message: "Kubernetes Lease HTTP 409" },
  });
  expect(fixture.calls.at(-1)!.method).toBe("PUT");
  fixture.reply = undefined;
  fixture.beforeWrite = async () => {
    fixture.advance(25000);
  };
  expect(await current(client, fixture)).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("safe authority window") },
  });
});
