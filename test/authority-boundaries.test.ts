import { afterEach, expect, test } from "bun:test";
import {
  ApplicationService,
  type LeasePort,
  type ProviderPort,
} from "../src/application";
import { CommissionStore } from "../src/persistence/sqlite";
import { epoch, policy, proposalInput } from "./support/fixtures";
import { FakeWorld } from "./support/fake-world";

let store: CommissionStore | undefined;
afterEach(() => store?.close());

for (const failure of ["takeover", "expiry", "unavailable"] as const) {
  test(`authority ${failure} during provider observation prevents preparing or dispatching work`, async () => {
    store = new CommissionStore(":memory:");
    const world = new FakeWorld();
    let now = epoch;
    let unavailable = false;
    const lease: LeasePort = {
      current: (...args) =>
        unavailable
          ? Promise.resolve({
              ok: false,
              error: { kind: "unavailable", message: "lease service offline" },
            })
          : world.current(...args),
    };
    const provider: ProviderPort = {
      observe: async (...args) => {
        const observation = await world.observe(...args);
        if (failure === "takeover")
          world.grant = {
            ...world.grant,
            owner: { controllerId: "controller-2", epoch: 2 },
          };
        if (failure === "expiry") now = world.grant.validUntil;
        if (failure === "unavailable") unavailable = true;
        return observation;
      },
      dispatch: (commission, operation) =>
        world.dispatch(commission, operation),
      inspectOperation: (commission, operation) =>
        world.inspectOperation(commission, operation),
    };
    const app = new ApplicationService(
      store,
      lease,
      provider,
      world,
      "controller-1",
      policy,
      () => now,
    );
    expect(app.propose(proposalInput()).ok).toBe(true);
    expect((await app.admit("commission-1", "operator-1", now)).ok).toBe(true);
    const before = store.get("commission-1");
    const result = await app.reconcile("commission-1", now);
    expect(result.ok).toBe(false);
    expect(store.get("commission-1")).toEqual(before);
    expect(store.operations("commission-1")).toHaveLength(0);
    expect(world.dispatchCount.size).toBe(0);
  });
}

test("Lease loss at the submission boundary leaves prepared intent recoverable without an external effect", async () => {
  store = new CommissionStore(":memory:");
  const world = new FakeWorld();
  let reads = 0;
  let loseAt = Infinity;
  const lease: LeasePort = {
    current: async (...args) => {
      reads += 1;
      if (reads === loseAt)
        world.grant = {
          ...world.grant,
          owner: { controllerId: "controller-2", epoch: 2 },
        };
      return world.current(...args);
    },
  };
  const app = new ApplicationService(
    store,
    lease,
    world,
    world,
    "controller-1",
    policy,
  );
  expect(app.propose(proposalInput()).ok).toBe(true);
  expect((await app.admit("commission-1", "operator-1", epoch)).ok).toBe(true);
  loseAt = reads + 3; // initial, post-observation, then submission authority
  expect((await app.reconcile("commission-1", epoch + 1)).ok).toBe(false);
  const original = store.operations("commission-1")[0]!;
  expect(original.outcome.kind).toBe("prepared");
  expect(world.dispatchCount.size).toBe(0);
  const successor = new ApplicationService(
    store,
    world,
    world,
    world,
    "controller-2",
    policy,
  );
  expect((await successor.reconcile("commission-1", epoch + 2)).ok).toBe(true);
  expect(world.dispatchCount.get(original.id)).toBe(1);
  expect(store.operations("commission-1")[0]).toMatchObject({
    id: original.id,
    controllerId: "controller-1",
    ownerEpoch: 1,
    outcome: { kind: "observed", result: "applied" },
  });
  expect((await app.reconcile("commission-1", epoch + 3)).ok).toBe(false);
  expect(world.dispatchCount.get(original.id)).toBe(1);
});

test("authority loss after remote acceptance leaves submitted intent for successor inspection, never replay", async () => {
  store = new CommissionStore(":memory:");
  const world = new FakeWorld();
  const provider: ProviderPort = {
    observe: (...args) => world.observe(...args),
    dispatch: async (commission, operation) => {
      const result = await world.dispatch(commission, operation);
      world.grant = {
        ...world.grant,
        owner: { controllerId: "controller-2", epoch: 2 },
      };
      return result;
    },
    inspectOperation: (commission, operation) =>
      world.inspectOperation(commission, operation),
  };
  const app = new ApplicationService(
    store,
    world,
    provider,
    world,
    "controller-1",
    policy,
  );
  expect(app.propose(proposalInput()).ok).toBe(true);
  expect((await app.admit("commission-1", "operator-1", epoch)).ok).toBe(true);
  expect((await app.reconcile("commission-1", epoch + 1)).ok).toBe(false);
  const original = store.operations("commission-1")[0]!;
  expect(original.outcome.kind).toBe("submitted");
  expect(world.dispatchCount.get(original.id)).toBe(1);
  const successor = new ApplicationService(
    store,
    world,
    world,
    world,
    "controller-2",
    policy,
  );
  expect((await successor.reconcile("commission-1", epoch + 2)).ok).toBe(true);
  expect(store.operations("commission-1")[0]).toMatchObject({
    id: original.id,
    controllerId: "controller-1",
    outcome: { kind: "observed", result: "applied" },
  });
  expect(world.dispatchCount.get(original.id)).toBe(1);
});
