import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { ApplicationService, type ProviderPort } from "../src/application";
import { evolve, evolveOperation, type Observation } from "../src/domain";
import { CommissionStore } from "../src/persistence/sqlite";
import {
  admittedCommission,
  epoch,
  lease,
  observation,
  policy,
  proposalInput,
  value,
} from "./support/fixtures";
import { FakeWorld } from "./support/fake-world";

let directory: string | undefined;
let store: CommissionStore | undefined;
let watcher: Database | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
  watcher?.close();
  watcher = undefined;
  if (directory !== undefined)
    rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function openStore(): CommissionStore {
  directory ??= mkdtempSync(join(tmpdir(), "anvil-lifecycle-"));
  store = new CommissionStore(join(directory, "state.sqlite"));
  return store;
}

function databasePath(): string {
  if (directory === undefined)
    throw new Error("SQLite test directory was not created");
  return join(directory, "state.sqlite");
}

function service(
  repository: CommissionStore,
  world: FakeWorld,
): ApplicationService {
  return new ApplicationService(
    repository,
    world,
    world,
    world,
    "controller-1",
    policy,
  );
}

test("one unattended lifecycle converges through SQLite, CI repair, restart recovery, queue, and authoritative merge", async () => {
  let repository = openStore();
  const world = new FakeWorld();
  let app = service(repository, world);
  const proposed = proposalInput({ id: "commission-lifecycle" });
  expect(app.propose(proposed)).toEqual({ ok: true, value: undefined });
  const admitted = await app.admit("commission-lifecycle", "operator-1", epoch);
  expect(admitted.ok).toBe(true);

  let now = epoch + 1;
  let restarted = false;
  let completed = false;
  const decisions: string[] = [];
  let integrationWaited = false;
  let checkWaited = false;
  for (let poll = 0; poll < 40; poll += 1) {
    const result = await app.reconcile("commission-lifecycle", now);
    if (!result.ok)
      throw new Error(
        `Lifecycle reconciliation failed: ${JSON.stringify(result.error)}`,
      );
    const decision = result.value.decision;
    if (decision !== null) decisions.push(decision.kind);

    const repair = repository
      .operations("commission-lifecycle")
      .find(
        (operation) =>
          operation.kind === "repair" && operation.outcome.kind === "ambiguous",
      );
    if (repair !== undefined && !restarted) {
      repository.close();
      repository = new CommissionStore(databasePath());
      store = repository;
      app = service(repository, world);
      restarted = true;
    }

    if (decision?.kind === "wait" && decision.wake.kind === "check_run") {
      checkWaited = true;
      world.completePendingCheck();
    }
    if (decision?.kind === "wait" && decision.wake.kind === "merge_queue") {
      integrationWaited = true;
      world.mergeCandidate();
    }
    if (result.value.commission.lifecycle === "concluded") {
      completed = true;
      break;
    }
    now += 1;
  }

  expect(completed).toBe(true);
  expect(restarted).toBe(true);
  expect(checkWaited).toBe(true);
  expect(integrationWaited).toBe(true);
  expect(decisions).toContain("continue");
  expect(decisions).toContain("repair");
  expect(decisions).toContain("verify");
  expect(decisions).toContain("integrate");
  expect(decisions).toContain("conclude");
  expect(
    repository.get("commission-lifecycle")?.deliveryEvidence?.revision,
  ).toBe("revision-2");
  const deliveredObjective = repository.get("commission-lifecycle")!.objective;
  const terminalAmendment = await app.amendSpecification(
    "commission-lifecycle",
    "operator-1",
    1,
    {
      objective: "Rewrite a completed Commission",
      integrationTarget: "different-branch",
      obligations: [
        {
          id: "acceptance-1",
          description: "Changed after delivery",
          independentReviewRequired: false,
        },
      ],
      independentReviewRequired: false,
    },
    now,
  );
  expect(terminalAmendment).toEqual({
    ok: false,
    error: { kind: "domain", error: "invalid_lifecycle" },
  });
  expect(repository.get("commission-lifecycle")?.objective).toBe(
    deliveredObjective,
  );
  expect(world.dispatchKinds).toContain("repair");
  expect([...world.dispatchCount.values()].every((count) => count === 1)).toBe(
    true,
  );
  expect(
    repository
      .operations("commission-lifecycle")
      .map(({ logicalKey }) => logicalKey),
  ).toHaveLength(
    new Set(
      repository
        .operations("commission-lifecycle")
        .map(({ logicalKey }) => logicalKey),
    ).size,
  );
});

test("ambiguous outcome with no authoritative result waits and never reissues a logical Operation", async () => {
  let repository = openStore();
  const world = new FakeWorld();
  world.unknownRecovery = true;
  let app = service(repository, world);
  expect(app.propose(proposalInput({ id: "commission-unknown" })).ok).toBe(
    true,
  );
  expect((await app.admit("commission-unknown", "operator-1", epoch)).ok).toBe(
    true,
  );

  let now = epoch + 1;
  let ambiguous = false;
  for (let poll = 0; poll < 20; poll += 1) {
    const result = await app.reconcile("commission-unknown", now);
    if (!result.ok)
      throw new Error(`Recovery test failed: ${JSON.stringify(result.error)}`);
    const operation = repository
      .operations("commission-unknown")
      .find((item) => item.outcome.kind === "ambiguous");
    if (operation !== undefined) {
      ambiguous = true;
      repository.close();
      repository = new CommissionStore(databasePath());
      store = repository;
      app = service(repository, world);
      const blocked = await app.reconcile("commission-unknown", now + 1);
      expect(blocked.ok).toBe(true);
      if (blocked.ok)
        expect(blocked.value.decision).toMatchObject({
          kind: "wait",
          wake: { kind: "operation", operationId: operation.id },
        });
      break;
    }
    now += 1;
  }
  expect(ambiguous).toBe(true);
  expect([...world.dispatchCount.values()].every((count) => count === 1)).toBe(
    true,
  );
  const unresolved = repository
    .operations("commission-unknown")
    .find(({ outcome }) => outcome.kind === "ambiguous");
  expect(unresolved).toMatchObject({
    outcome: { kind: "ambiguous" },
  });
});

test("a prepared Operation is dispatched once after restart and observed outcomes are not replayed", async () => {
  let repository = openStore();
  const world = new FakeWorld();
  let app = service(repository, world);
  expect(
    app.propose(proposalInput({ id: "commission-prepared-crash" })).ok,
  ).toBe(true);
  expect(
    (await app.admit("commission-prepared-crash", "operator-1", epoch)).ok,
  ).toBe(true);
  const current = repository.get("commission-prepared-crash");
  if (current === null) throw new Error("Admitted Commission missing");
  const beforeDispatch = value(
    evolve(current, {
      kind: "reconcile",
      lease: lease(),
      observation: observation(),
      operations: [],
      policy,
      now: epoch + 1,
    }),
  );
  const original = beforeDispatch.newOperations[0];
  if (original === undefined) throw new Error("Expected prepared Operation");
  expect(repository.commitTransition(beforeDispatch).ok).toBe(true);
  expect(world.dispatchCount.size).toBe(0);

  repository.close();
  store = undefined;
  repository = openStore();
  app = service(repository, world);
  const resumed = await app.reconcile("commission-prepared-crash", epoch + 2);
  expect(resumed.ok).toBe(true);
  expect(world.dispatchCount.get(original.id)).toBe(1);
  expect(repository.operations("commission-prepared-crash")).toMatchObject([
    {
      id: original.id,
      logicalKey: original.logicalKey,
      outcome: { kind: "observed", result: "applied" },
    },
  ]);

  repository.close();
  store = undefined;
  repository = openStore();
  app = service(repository, world);
  await app.reconcile("commission-prepared-crash", epoch + 3);
  expect(world.dispatchCount.get(original.id)).toBe(1);
  expect(
    repository
      .operations("commission-prepared-crash")
      .filter(({ logicalKey }) => logicalKey === original.logicalKey),
  ).toHaveLength(1);
});

test("submitted Operation survives a provider effect followed by lost controller acknowledgement", async () => {
  let repository = openStore();
  const world = new FakeWorld();
  const crashingProvider: ProviderPort = {
    observe: (commission, now, operations) =>
      world.observe(commission, now, operations),
    dispatch: async (commission, operation) => {
      await world.dispatch(commission, operation);
      throw new Error("simulated controller crash after remote effect");
    },
    inspectOperation: (commission, operation) =>
      world.inspectOperation(commission, operation),
  };
  const app = new ApplicationService(
    repository,
    world,
    crashingProvider,
    world,
    "controller-1",
    policy,
  );
  expect(app.propose(proposalInput({ id: "commission-after-effect" })).ok).toBe(
    true,
  );
  expect(
    (await app.admit("commission-after-effect", "operator-1", epoch)).ok,
  ).toBe(true);
  await expect(
    app.reconcile("commission-after-effect", epoch + 1),
  ).rejects.toThrow("simulated controller crash after remote effect");
  const submitted = repository.operations("commission-after-effect")[0];
  if (submitted === undefined) throw new Error("Submitted Operation missing");
  expect(submitted.outcome).toEqual({
    kind: "submitted",
    submittedAt: epoch + 1,
  });
  expect(world.dispatchCount.get(submitted.id)).toBe(1);

  repository.close();
  store = undefined;
  repository = openStore();
  const recovered = service(repository, world);
  const inspected = await recovered.reconcile(
    "commission-after-effect",
    epoch + 2,
  );
  expect(inspected.ok).toBe(true);
  expect(world.dispatchCount.get(submitted.id)).toBe(1);
  expect(repository.operations("commission-after-effect")).toMatchObject([
    {
      id: submitted.id,
      logicalKey: submitted.logicalKey,
      outcome: { kind: "observed", result: "applied" },
    },
  ]);
});

test("a retry follows provider proof, reuses the same Operation identity, and is bounded", async () => {
  const repository = openStore();
  const world = new FakeWorld();
  world.reportFirstInstructionNotApplied = true;
  const app = service(repository, world);
  expect(app.propose(proposalInput({ id: "commission-safe-retry" })).ok).toBe(
    true,
  );
  expect(
    (await app.admit("commission-safe-retry", "operator-1", epoch)).ok,
  ).toBe(true);

  const first = await app.reconcile("commission-safe-retry", epoch + 1);
  expect(first.ok).toBe(true);
  const operation = repository.operations("commission-safe-retry")[0];
  if (operation === undefined)
    throw new Error("Initial instruction was not journaled");
  expect(operation.outcome).toMatchObject({
    kind: "observed",
    result: "not_applied",
    retrySafe: true,
  });

  const retry = await app.reconcile("commission-safe-retry", epoch + 2);
  expect(retry.ok).toBe(true);
  const recovered = repository.operations("commission-safe-retry");
  expect(recovered).toHaveLength(1);
  expect(recovered[0]?.id).toBe(operation.id);
  expect(recovered[0]?.logicalKey).toBe(operation.logicalKey);
  expect(recovered[0]?.retryCount).toBe(1);
  expect(recovered[0]?.outcome).toMatchObject({
    kind: "observed",
    result: "applied",
  });
  expect(world.dispatchCount.get(operation.id)).toBe(2);
});

test("an unverified or mismatched merge observation is not completion evidence", async () => {
  const repository = openStore();
  const world = new FakeWorld();
  const app = service(repository, world);
  expect(app.propose(proposalInput({ id: "commission-fake-merge" })).ok).toBe(
    true,
  );
  expect(
    (await app.admit("commission-fake-merge", "operator-1", epoch)).ok,
  ).toBe(true);

  world.revision = "unverified-revision";
  world.checks = {
    runId: "green-check",
    revision: "unverified-revision",
    state: "passing",
    failureIds: [],
    observedAt: epoch,
    expiresAt: epoch + 30_000,
    source: "fake-ci",
  };
  world.integration = {
    kind: "merged",
    revision: "different-revision",
    providerIdentity: "fake-github:pr/7",
    repository: "https://github.com/example/repository",
    target: "main",
    observedAt: epoch,
    expiresAt: epoch + 30_000,
    source: "fake-github",
  };
  const observation = await app.reconcile("commission-fake-merge", epoch + 1);
  expect(observation.ok).toBe(true);
  if (observation.ok) {
    expect(observation.value.decision?.kind).not.toBe("conclude");
    expect(observation.value.commission.lifecycle).not.toBe("concluded");
  }
});

test("a stale owner cannot resolve another controller epoch Operation", () => {
  const state = admittedCommission();
  const operation = {
    id: "operation-1",
    logicalKey: "operation-1",
    commissionId: state.id,
    kind: "continue" as const,
    target: "assignment:assignment-1",
    controllerId: "controller-1",
    ownerEpoch: 1,
    specificationGeneration: 1,
    assignmentId: "assignment-1",
    attemptId: "attempt-1",
    instructionSequence: 1,
    retryCount: 0,
    candidateRevision: null,
    findingIds: [],
    directive: "continue",
    createdAt: epoch,
    outcome: { kind: "ambiguous" as const, observedAt: epoch, reason: "lost" },
  };
  expect(
    evolveOperation(
      state,
      operation,
      {
        owner: { controllerId: "controller-1", epoch: 2 },
        resourceVersion: "lease-new",
        observedAt: epoch,
        validUntil: epoch + 1000,
      },
      {
        kind: "observed",
        observedAt: epoch,
        source: "fake",
        result: "applied",
        retrySafe: false,
        externalIdentity: null,
      },
      epoch,
    ),
  ).toEqual({ ok: false, error: "owner_mismatch" });
});

test("a successor ApplicationService observes a predecessor's accepted turn after lost acknowledgement", async () => {
  let repository = openStore();
  const world = new FakeWorld();
  world.loseFirstInstructionAcknowledgement = true;
  const predecessor = service(repository, world);
  expect(
    predecessor.propose(proposalInput({ id: "commission-successor-recovery" }))
      .ok,
  ).toBe(true);
  expect(
    (
      await predecessor.admit(
        "commission-successor-recovery",
        "operator-1",
        epoch,
      )
    ).ok,
  ).toBe(true);
  const sent = await predecessor.reconcile(
    "commission-successor-recovery",
    epoch + 1,
  );
  expect(sent.ok).toBe(true);
  const prior = repository.operations("commission-successor-recovery")[0];
  if (prior === undefined) throw new Error("Predecessor Operation missing");
  expect(prior.outcome.kind).toBe("ambiguous");
  expect(world.dispatchCount.get(prior.id)).toBe(1);

  repository.close();
  store = undefined;
  repository = openStore();
  expect(repository.operations("commission-successor-recovery")).toMatchObject([
    {
      id: prior.id,
      logicalKey: prior.logicalKey,
      outcome: { kind: "ambiguous" },
    },
  ]);

  world.grant = {
    owner: { controllerId: "controller-2", epoch: 2 },
    resourceVersion: "lease-rv-2",
    observedAt: epoch + 2,
    validUntil: epoch + 60_000,
  };
  const successor = new ApplicationService(
    repository,
    world,
    world,
    world,
    "controller-2",
    policy,
  );
  const recovered = await successor.reconcile(
    "commission-successor-recovery",
    epoch + 2,
  );
  expect(recovered.ok).toBe(true);
  expect(repository.get("commission-successor-recovery")?.owner).toEqual({
    controllerId: "controller-2",
    epoch: 2,
  });
  expect(
    repository.operations("commission-successor-recovery")[0],
  ).toMatchObject({
    id: prior.id,
    controllerId: "controller-1",
    ownerEpoch: 1,
    outcome: { kind: "observed", result: "applied" },
  });
  expect(world.dispatchCount.get(prior.id)).toBe(1);

  const stalePredecessor = service(repository, world);
  const stale = await stalePredecessor.reconcile(
    "commission-successor-recovery",
    epoch + 3,
  );
  expect(stale.ok).toBe(false);
  expect(repository.operations("commission-successor-recovery")[0]?.id).toBe(
    prior.id,
  );
  expect(world.dispatchCount.get(prior.id)).toBe(1);
});

test("runtime provisioning and Session binding are journaled before the first instruction", async () => {
  const repository = openStore();
  const world = new FakeWorld();
  const runtimePolicy = { ...policy, runtimeProvisioning: true };
  const app = new ApplicationService(
    repository,
    world,
    world,
    world,
    "controller-1",
    runtimePolicy,
  );
  expect(
    app.propose(proposalInput({ id: "commission-runtime-bootstrap" })).ok,
  ).toBe(true);
  expect(
    (await app.admit("commission-runtime-bootstrap", "operator-1", epoch)).ok,
  ).toBe(true);

  const decisions: ("provision_sandbox" | "create_session" | "continue")[] = [];
  for (let step = 1; step <= 3; step += 1) {
    const result = await app.reconcile(
      "commission-runtime-bootstrap",
      epoch + step,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Runtime bootstrap reconciliation failed");
    expect(result.value.decision).not.toBeNull();
    const kind = result.value.decision?.kind;
    if (
      kind !== "provision_sandbox" &&
      kind !== "create_session" &&
      kind !== "continue"
    ) {
      throw new Error(`Unexpected runtime bootstrap decision: ${kind}`);
    }
    decisions.push(kind);
  }

  const operations = repository.operations("commission-runtime-bootstrap");
  expect(decisions).toEqual([
    "provision_sandbox",
    "create_session",
    "continue",
  ]);
  expect(operations.map(({ kind }) => kind)).toEqual(decisions);
  expect(operations[0]?.outcome).toMatchObject({
    kind: "observed",
    result: "applied",
    externalIdentity: "fake-sandbox:commission-runtime-bootstrap",
  });
  expect(operations[1]).toMatchObject({
    target: "opencode:fake-sandbox:commission-runtime-bootstrap",
    outcome: {
      kind: "observed",
      result: "applied",
      externalIdentity: "fake-session:commission-runtime-bootstrap",
    },
  });
  expect(world.dispatchKinds).toEqual(decisions);
  expect(
    repository.get("commission-runtime-bootstrap")?.budget.used.instructions,
  ).toBe(1);
});

test("repeated identical Wait and Hold calls leave the durable Commission version unchanged", async () => {
  const repository = openStore();
  const world = new FakeWorld();
  world.executionKind = "running";
  const app = service(repository, world);
  expect(app.propose(proposalInput({ id: "commission-noop" })).ok).toBe(true);
  expect((await app.admit("commission-noop", "operator-1", epoch)).ok).toBe(
    true,
  );
  const admittedVersion = repository.get("commission-noop")?.version;

  const firstWait = await app.reconcile("commission-noop", epoch + 10);
  const secondWait = await app.reconcile("commission-noop", epoch + 10);
  expect(firstWait.ok && firstWait.value.decision?.kind).toBe("wait");
  expect(secondWait.ok && secondWait.value.decision?.kind).toBe("wait");
  expect(repository.get("commission-noop")?.version).toBe(admittedVersion!);

  const held = await app.hold("commission-noop", "operator hold", epoch + 10);
  expect(held.ok).toBe(true);
  const heldVersion = repository.get("commission-noop")?.version;
  const repeatedHold = await app.hold(
    "commission-noop",
    "operator hold",
    epoch + 10,
  );
  expect(repeatedHold.ok).toBe(true);
  expect(repository.get("commission-noop")?.version).toBe(heldVersion!);
});

test("repeated identical Escalate decisions leave the durable proposed Commission unchanged", async () => {
  const repository = openStore();
  const world = new FakeWorld();
  const app = service(repository, world);
  expect(app.propose(proposalInput({ id: "commission-escalate" })).ok).toBe(
    true,
  );
  const first = await app.reconcile("commission-escalate", epoch + 1);
  if (!first.ok) throw new Error("First escalation reconciliation failed");
  expect(first.value.decision?.kind).toBe("escalate");
  const version = repository.get("commission-escalate")?.version;
  const second = await app.reconcile("commission-escalate", epoch + 1);
  if (!second.ok) throw new Error("Repeated escalation reconciliation failed");
  expect(second.value.decision?.kind).toBe("escalate");
  expect(repository.get("commission-escalate")?.version).toBe(version!);
});

test("identical healthy Wait polling does not execute a durable SQL update", async () => {
  const repository = openStore();
  const world = new FakeWorld();
  world.executionKind = "running";
  const app = service(repository, world);
  expect(app.propose(proposalInput({ id: "commission-sql-noop" })).ok).toBe(
    true,
  );
  expect((await app.admit("commission-sql-noop", "operator-1", epoch)).ok).toBe(
    true,
  );
  watcher = new Database(databasePath());
  watcher.exec(`
    CREATE TABLE commission_update_count (count INTEGER NOT NULL);
    INSERT INTO commission_update_count VALUES (0);
    CREATE TRIGGER count_commission_updates
    AFTER UPDATE ON commissions
    BEGIN
      UPDATE commission_update_count SET count = count + 1;
    END;
  `);

  const first = await app.reconcile("commission-sql-noop", epoch + 10);
  const second = await app.reconcile("commission-sql-noop", epoch + 10);
  expect(first.ok && first.value.decision?.kind).toBe("wait");
  expect(second.ok && second.value.decision?.kind).toBe("wait");
  const updates = watcher
    .query("SELECT count FROM commission_update_count")
    .get() as { count: number };
  expect(updates.count).toBe(0);

  const held = await app.hold("commission-sql-noop", "pause", epoch + 11);
  if (!held.ok)
    throw new Error(
      `First SQL-audited Hold failed: ${JSON.stringify({ current: repository.get("commission-sql-noop"), error: held.error })}`,
    );
  expect(held).toEqual({ ok: true, value: expect.any(Object) });
  watcher.query("UPDATE commission_update_count SET count = 0").run();
  expect((await app.hold("commission-sql-noop", "pause", epoch + 12)).ok).toBe(
    true,
  );
  const holdUpdates = watcher
    .query("SELECT count FROM commission_update_count")
    .get() as { count: number };
  expect(holdUpdates.count).toBe(0);

  expect(
    app.propose(proposalInput({ id: "commission-escalate-sql-noop" })).ok,
  ).toBe(true);
  const firstEscalation = await app.reconcile(
    "commission-escalate-sql-noop",
    epoch + 20,
  );
  expect(firstEscalation.ok).toBe(true);
  watcher.query("UPDATE commission_update_count SET count = 0").run();
  const secondEscalation = await app.reconcile(
    "commission-escalate-sql-noop",
    epoch + 20,
  );
  expect(secondEscalation.ok).toBe(true);
  const escalationUpdates = watcher
    .query("SELECT count FROM commission_update_count")
    .get() as { count: number };
  expect(escalationUpdates.count).toBe(0);
});

test("a worker observation cannot waive or replace an approved obligation", async () => {
  const repository = openStore();
  const world = new FakeWorld();
  const attemptedWaiver = {
    ...observation(),
    obligations: [],
  } as unknown as Observation;
  const provider: ProviderPort = {
    observe: async () => ({ ok: true, value: attemptedWaiver }),
    dispatch: (commission, operation) => world.dispatch(commission, operation),
    inspectOperation: (commission, operation) =>
      world.inspectOperation(commission, operation),
  };
  const app = new ApplicationService(
    repository,
    world,
    provider,
    world,
    "controller-1",
    policy,
  );
  expect(
    app.propose(proposalInput({ id: "commission-worker-waiver" })).ok,
  ).toBe(true);
  expect(
    (await app.admit("commission-worker-waiver", "operator-1", epoch)).ok,
  ).toBe(true);
  const result = await app.reconcile("commission-worker-waiver", epoch + 1);
  expect(result).toEqual({
    ok: false,
    error: { kind: "invalid_provider_observation" },
  });
  expect(repository.get("commission-worker-waiver")?.obligations).toEqual(
    proposalInput().obligations,
  );
});
