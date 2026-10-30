import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CommissionStore } from "../src/persistence/sqlite";
import { createControllerAuthority } from "../src/providers/runtime";
import { epoch, value } from "./support/fixtures";
import { LeaseApiFixture, leaseToken } from "./support/lease-api";
import { SteeringHarness } from "./support/steering-harness";

let api: LeaseApiFixture | undefined;
let harness: SteeringHarness | undefined;
afterEach(() => {
  harness?.close();
  harness = undefined;
  expect(api?.errors ?? []).toHaveLength(0);
  api?.close();
  api = undefined;
});
async function setup() {
  const h = new SteeringHarness();
  harness = h;
  const fixture = new LeaseApiFixture(() => h.now);
  api = fixture;
  await fixture.ready;
  const client = (label: string) =>
    fixture.client(label, (id) => h.store.get(id)?.owner?.epoch ?? 0, {
      monotonicNow: () => h.now - epoch,
    });
  const a = client("a");
  h.application = h.makeApplication(h.store, {
    lease: a,
    controllerId: a.controllerId,
  });
  await h.initialize();
  return { h, fixture, a, client };
}

test("a real Lease successor reopens SQLite and observes predecessor submitted steering without replay or owner forgery", async () => {
  const { h, fixture, a, client } = await setup();
  const original = value(await h.steer());
  const b = client("b");
  expect((await b.current("commission-1", b.controllerId, h.now)).ok).toBe(
    false,
  );
  h.afterPrompt = async () => {
    h.now += 34000;
    expect(
      value(await b.current("commission-1", b.controllerId, h.now)).owner.epoch,
    ).toBe(2);
  };
  expect((await h.reconcile()).ok).toBe(false); // effect accepted; A can no longer record it
  expect(h.prompts).toHaveLength(1);
  expect(
    h.store.operations("commission-1").find((o) => o.id === original.id)!
      .outcome.kind,
  ).toBe("submitted");
  h.store.close();
  h.store = new CommissionStore(h.path);
  h.application = h.makeApplication(h.store, {
    lease: b,
    controllerId: b.controllerId,
  });
  value(await h.reconcile());
  expect(h.store.get("commission-1")!.owner).toEqual({
    controllerId: b.controllerId,
    epoch: 2,
  });
  expect(
    h.store.operations("commission-1").find((o) => o.id === original.id),
  ).toMatchObject({
    id: original.id,
    controllerId: a.controllerId,
    ownerEpoch: 1,
    steering: original.steering!,
    outcome: {
      kind: "observed",
      result: "applied",
      externalIdentity: h.prompts[0]!.id,
    },
  });
  const stale = h.makeApplication(h.store, {
    lease: a,
    controllerId: a.controllerId,
  });
  expect((await stale.reconcile("commission-1", h.now)).ok).toBe(false);
  expect(h.prompts).toHaveLength(1);
  expect(fixture.get().spec.holderIdentity).toBe(b.controllerId);
});

for (const instruction of ["steer", "continue"] as const)
  test(`Lease takeover during ${instruction} model I/O prevents the prompt and preserves the submitted identity`, async () => {
    const { h, a, client } = await setup();
    if (instruction === "steer") value(await h.steer());
    const b = client("b");
    expect((await b.current("commission-1", b.controllerId, h.now)).ok).toBe(
      false,
    );
    h.beforeModel = async () => {
      h.now += 34000;
      value(await b.current("commission-1", b.controllerId, h.now));
    };
    expect((await h.reconcile()).ok).toBe(false);
    expect(h.modelSelections).toBe(1);
    expect(h.prompts).toHaveLength(0);
    const original = h.store
      .operations("commission-1")
      .find((o) => o.kind === instruction)!;
    expect(original).toMatchObject({
      controllerId: a.controllerId,
      outcome: { kind: "submitted" },
    });
    h.beforeModel = undefined;
    h.application = h.makeApplication(h.store, {
      lease: b,
      controllerId: b.controllerId,
    });
    value(await h.reconcile());
    value(await h.reconcile());
    expect(h.prompts).toHaveLength(0); // absence is not permission to retry
    expect(
      h.store.operations("commission-1").find((o) => o.id === original.id)!
        .outcome.kind,
    ).toBe("submitted");
  });

test("renewal loss during status I/O denies new intent and simultaneous steering serializes with autonomous continuation", async () => {
  const { h, fixture } = await setup();
  h.beforeObserve = async () => {
    fixture.status = 403;
  };
  expect((await h.reconcile()).ok).toBe(false);
  expect(h.prompts).toHaveLength(0);
  expect(h.store.operations("commission-1")).toHaveLength(2);
  fixture.status = undefined;
  let release!: () => void;
  let entered!: () => void;
  const seen = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.beforeObserve = async () => {
    entered();
    await wait;
  };
  const autonomous = h.reconcile();
  await seen;
  const original = value(await h.steer());
  h.beforeObserve = undefined;
  release();
  value(await autonomous);
  expect(h.prompts).toHaveLength(1);
  expect(
    h.store.operations("commission-1").filter((o) => o.kind === "continue"),
  ).toHaveLength(0);
  expect(
    h.store.operations("commission-1").find((o) => o.id === original.id)!
      .outcome.kind,
  ).toBe("observed");
});

test("configured authority uses explicit credentials and rotating token files, never locally invented grants", async () => {
  const { h, fixture } = await setup();
  const tokenPath = join(h.directory, "lease-token");
  writeFileSync(tokenPath, leaseToken);
  const env = {
    ANVIL_PROVIDER_MODE: "configured",
    ANVIL_LEASE_API_URL: fixture.url,
    ANVIL_CONTROLLER_ID: "runtime-pod",
    ANVIL_LEASE_NAMESPACE: "lease-test",
    ANVIL_LEASE_TOKEN_FILE: tokenPath,
  };
  const configured = createControllerAuthority(env, h.store, {
    now: () => h.now,
    monotonicNow: () => h.now - epoch,
  });
  expect(configured.controllerId).not.toBe("runtime-pod");
  expect(
    (
      await configured.lease.current(
        "new-commission",
        configured.controllerId,
        h.now,
      )
    ).ok,
  ).toBe(true);
  writeFileSync(tokenPath, "rotated-but-not-authorized-fixture-token");
  expect(
    await configured.lease.current(
      "new-commission",
      configured.controllerId,
      h.now,
    ),
  ).toMatchObject({
    ok: false,
    error: { message: "Kubernetes Lease HTTP 401" },
  });
  writeFileSync(tokenPath, leaseToken);
  await configured.stop();
  for (const name of [
    "ANVIL_LEASE_NAMESPACE",
    "ANVIL_CONTROLLER_ID",
    "ANVIL_LEASE_TOKEN_FILE",
  ] as const) {
    const missing: NodeJS.ProcessEnv = { ...env };
    delete missing[name];
    expect(() => createControllerAuthority(missing, h.store)).toThrow();
  }
});

test("negative Workspace boundary: ownership transfer does not fence an already-running or independently credentialed remote writer", async () => {
  const { h, a, client } = await setup();
  value(await h.reconcile()); // A's accepted Continue is still running remotely.
  expect(h.prompts).toHaveLength(1);
  const b = client("b");
  expect((await b.current("commission-1", b.controllerId, h.now)).ok).toBe(
    false,
  );
  h.now += 34000;
  value(await b.current("commission-1", b.controllerId, h.now));
  expect((await a.current("commission-1", a.controllerId, h.now)).ok).toBe(
    false,
  );
  const probe = join(h.directory, "workspace-writer-probe");
  h.afterPrompt = async () => {
    writeFileSync(probe, "stale remote writer was not fenced");
  };
  const remote = await fetch(
    new URL("api/session/session-1/prompt", h.fixture.url),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "unfenced-probe",
        text: "Local negative isolation probe",
      }),
    },
  );
  expect(remote.status).toBe(200);
  expect(h.prompts).toHaveLength(2);
  expect(readFileSync(probe, "utf8")).toBe(
    "stale remote writer was not fenced",
  );
  // Deliberately demonstrates the missing provider/Workspace enforcement. A
  // passing Lease suite is not FS-05 Workspace/verifier isolation acceptance.
});
