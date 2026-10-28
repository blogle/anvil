import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationService } from "../src/application";
import { evolve, evolveOperation, type OperationOutcome } from "../src/domain";
import { CommissionStore } from "../src/persistence/sqlite";
import { FakeWorld } from "./support/fake-world";
import {
  epoch,
  lease,
  observation,
  policy,
  proposal,
  value,
} from "./support/fixtures";

let directory: string | undefined;
let store: CommissionStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
  if (directory !== undefined)
    rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function openStore(): CommissionStore {
  directory ??= mkdtempSync(join(tmpdir(), "anvil-core-"));
  store = new CommissionStore(join(directory, "state.sqlite"));
  return store;
}

test("runs versioned schema migrations once and reopens the normalized Commission projection", () => {
  const repository = openStore();
  expect(repository.migrationVersion()).toBe(1);
  expect(repository.propose(proposal())).toEqual({
    ok: true,
    value: undefined,
  });
  repository.close();
  store = undefined;

  const reopened = openStore();
  expect(reopened.migrationVersion()).toBe(1);
  expect(reopened.get("commission-1")).toEqual(proposal().commission);
  expect(reopened.operations("commission-1")).toEqual([]);
});

test("only branded domain proposals and transitions can mutate durable state", () => {
  const repository = openStore();
  const initial = proposal();
  expect(repository.propose(initial)).toEqual({ ok: true, value: undefined });
  const rawWrite = Reflect.apply(repository.propose, repository, [
    { commission: { ...initial.commission, objective: "forged objective" } },
  ]);
  expect(rawWrite).toEqual({ ok: false, error: "untrusted_proposal" });
  expect("save" in repository).toBe(false);

  const rawTransition = Reflect.apply(repository.commitTransition, repository, [
    {
      beforeVersion: 0,
      commission: {
        ...initial.commission,
        lifecycle: "concluded",
        deliveryEvidence: {
          revision: "invented-merge",
          providerIdentity: "fake-pr",
          source: "fake",
          observedAt: epoch,
          expiresAt: epoch + 1_000,
          checkRunId: "fake-check",
          specificationGeneration: 1,
        },
        evidence: [
          {
            id: "forged-evidence",
            obligationId: "acceptance-1",
            specificationGeneration: 1,
            candidateRevision: "invented-merge",
            source: { kind: "worker", identity: "untrusted-json" },
            disposition: "accepted",
            observedAt: epoch,
            expiresAt: epoch + 1_000,
            claim: "forged acceptance",
            checkRunId: null,
          },
        ],
        version: 1,
      },
      newOperations: [],
      updatedOperations: [],
      decision: {
        kind: "conclude",
        deliveredRevision: "invented-merge",
        providerIdentity: "fake-pr",
        checkRunId: "fake-check",
      },
    },
  ]);
  expect(rawTransition).toEqual({ ok: false, error: "untrusted_transition" });
  expect("recordEvidence" in repository).toBe(false);
  expect(repository.get(initial.commission.id)?.objective).toBe(
    initial.commission.objective,
  );
  expect(repository.get(initial.commission.id)?.lifecycle).toBe("proposed");
});

test("generation CAS is atomic and a stale controller cannot overwrite ownership or objective", () => {
  const repository = openStore();
  repository.propose(proposal());
  const current = repository.get("commission-1");
  if (current === null) throw new Error("Proposal missing from SQLite");
  const admitted = value(
    evolve(current, {
      kind: "admit",
      actor: { kind: "approver", identity: "operator" },
      lease: lease(),
      attemptId: "attempt-1",
      assignmentId: "assignment-1",
      now: epoch,
    }),
  );
  expect(repository.commitTransition(admitted)).toEqual({ ok: true, value: 1 });

  const conflict = value(
    evolve(current, {
      kind: "takeover",
      lease: lease("controller-2", 2),
      now: epoch,
    }),
  );
  expect(repository.commitTransition(conflict)).toEqual({
    ok: false,
    error: "conflict",
  });
  expect(repository.get("commission-1")?.owner).toEqual(lease().owner);
  expect(repository.get("commission-1")?.objective).toBe(
    "Implement bounded delivery",
  );
});

test("two SQLite controller connections cannot both mutate one Commission version", () => {
  const first = openStore();
  if (directory === undefined) throw new Error("Store directory missing");
  const second = new CommissionStore(join(directory, "state.sqlite"));
  first.propose(proposal());
  const proposed = first.get("commission-1");
  if (proposed === null)
    throw new Error("Proposal missing from first connection");
  const admitted = value(
    evolve(proposed, {
      kind: "admit",
      actor: { kind: "approver", identity: "operator" },
      lease: lease(),
      attemptId: "attempt-1",
      assignmentId: "assignment-1",
      now: epoch,
    }),
  );
  expect(first.commitTransition(admitted).ok).toBe(true);

  const left = first.get("commission-1");
  const right = second.get("commission-1");
  if (left === null || right === null)
    throw new Error("Commission missing from second connection");
  const held = value(
    evolve(left, {
      kind: "hold",
      lease: lease(),
      reason: "operator request",
      now: epoch,
    }),
  );
  const usage = value(
    evolve(right, {
      kind: "record_usage",
      lease: lease(),
      costMicros: 10,
      now: epoch,
    }),
  );
  expect(first.commitTransition(held)).toEqual({ ok: true, value: 2 });
  expect(second.commitTransition(usage)).toEqual({
    ok: false,
    error: "conflict",
  });
  expect(second.get("commission-1")?.lifecycle).toBe("held");
  expect(second.get("commission-1")?.budget.used.costMicros).toBe(0);
  second.close();
});

test("a successor Lease holder resolves a predecessor Operation without replaying it", () => {
  const repository = openStore();
  repository.propose(proposal());
  const proposed = repository.get("commission-1");
  if (proposed === null) throw new Error("Proposal missing");
  const admitted = value(
    evolve(proposed, {
      kind: "admit",
      actor: { kind: "approver", identity: "operator" },
      lease: lease(),
      attemptId: "attempt-1",
      assignmentId: "assignment-1",
      now: epoch,
    }),
  );
  repository.commitTransition(admitted);

  const state = repository.get("commission-1");
  if (state === null) throw new Error("Admitted Commission missing");
  const prepared = value(
    evolve(state, {
      kind: "reconcile",
      lease: lease(),
      observation: observation(),
      operations: [],
      policy,
      now: epoch,
    }),
  );
  const operation = prepared.newOperations[0];
  if (operation === undefined)
    throw new Error("Expected an instruction Operation");
  expect(repository.commitTransition(prepared).ok).toBe(true);

  const ambiguousOutcome: OperationOutcome = {
    kind: "ambiguous",
    observedAt: epoch + 1,
    reason: "controller A acknowledgement lost",
  };
  const ambiguous = value(
    evolveOperation(
      prepared.commission,
      operation,
      lease(),
      ambiguousOutcome,
      epoch + 1,
    ),
  );
  expect(repository.commitTransition(ambiguous).ok).toBe(true);

  const beforeTakeover = repository.get("commission-1");
  if (beforeTakeover === null)
    throw new Error("Commission missing before takeover");
  const successorLease = lease("controller-2", 2);
  const takeover = value(
    evolve(beforeTakeover, {
      kind: "takeover",
      lease: successorLease,
      now: epoch + 2,
    }),
  );
  expect(repository.commitTransition(takeover).ok).toBe(true);
  const recovered = repository.get("commission-1");
  const predecessorOperation = repository.operations("commission-1")[0];
  if (recovered === null || predecessorOperation === undefined)
    throw new Error("Recovery records missing");

  const observedOutcome: OperationOutcome = {
    kind: "observed",
    observedAt: epoch + 3,
    source: "OpenCode session inspection",
    result: "applied",
    retrySafe: false,
    externalIdentity: null,
  };
  const resolution = evolveOperation(
    recovered,
    predecessorOperation,
    successorLease,
    observedOutcome,
    epoch + 3,
  );
  expect(resolution.ok).toBe(true);
  if (!resolution.ok)
    throw new Error(
      `Successor could not resolve predecessor Operation: ${resolution.error}`,
    );
  expect(repository.commitTransition(resolution.value).ok).toBe(true);
  expect(repository.operations("commission-1")[0]).toMatchObject({
    controllerId: "controller-1",
    ownerEpoch: 1,
    outcome: observedOutcome,
  });

  const staleController = evolveOperation(
    resolution.value.commission,
    predecessorOperation,
    lease(),
    { kind: "rejected", observedAt: epoch + 4, reason: "stale actor" },
    epoch + 4,
  );
  expect(staleController).toEqual({ ok: false, error: "owner_mismatch" });
});

test("a logical Operation and its resolution have one append-only SQL source of truth", () => {
  let repository = openStore();
  repository.propose(proposal());
  const initial = repository.get("commission-1");
  if (initial === null) throw new Error("Proposal missing from SQLite");
  const admitted = value(
    evolve(initial, {
      kind: "admit",
      actor: { kind: "approver", identity: "operator" },
      lease: lease(),
      attemptId: "attempt-1",
      assignmentId: "assignment-1",
      now: epoch,
    }),
  );
  repository.commitTransition(admitted);

  const state = repository.get("commission-1");
  if (state === null)
    throw new Error("Admitted Commission missing from SQLite");
  const prepared = value(
    evolve(state, {
      kind: "reconcile",
      lease: lease(),
      observation: observation(),
      operations: [],
      policy,
      now: epoch,
    }),
  );
  expect(prepared.decision?.kind).toBe("continue");
  expect(prepared.newOperations).toHaveLength(1);
  expect(repository.commitTransition(prepared).ok).toBe(true);
  repository.close();
  store = undefined;
  repository = openStore();
  const recoveredCommission = repository.get("commission-1");
  if (recoveredCommission === null)
    throw new Error("Commission intent did not survive restart");
  const operation = repository.operations("commission-1")[0];
  if (operation === undefined)
    throw new Error("Prepared Operation missing from SQL journal");
  expect(operation.outcome).toEqual({ kind: "prepared" });

  const outcome: OperationOutcome = {
    kind: "observed",
    observedAt: epoch + 1,
    source: "fake-opencode",
    result: "applied",
    retrySafe: false,
    externalIdentity: null,
  };
  const resolved = value(
    evolveOperation(
      recoveredCommission,
      operation,
      lease(),
      outcome,
      epoch + 1,
    ),
  );
  expect(repository.commitTransition(resolved).ok).toBe(true);
  expect(repository.operations("commission-1")).toHaveLength(1);
  expect(repository.operations("commission-1")[0]?.outcome).toEqual(outcome);
  repository.close();
  store = undefined;

  const reopened = openStore();
  expect(reopened.operations("commission-1")).toHaveLength(1);
  expect(reopened.operations("commission-1")[0]?.logicalKey).toBe(
    operation.logicalKey,
  );
});

test("submitted Operation survives restart and is inspected instead of replayed", async () => {
  let repository = openStore();
  repository.propose(proposal());
  const proposed = repository.get("commission-1");
  if (proposed === null) throw new Error("Proposal missing");
  const admitted = value(
    evolve(proposed, {
      kind: "admit",
      actor: { kind: "approver", identity: "operator" },
      lease: lease(),
      attemptId: "attempt-1",
      assignmentId: "assignment-1",
      now: epoch,
    }),
  );
  repository.commitTransition(admitted);
  const current = repository.get("commission-1");
  if (current === null) throw new Error("Admitted Commission missing");
  const prepared = value(
    evolve(current, {
      kind: "reconcile",
      lease: lease(),
      observation: observation(),
      operations: [],
      policy,
      now: epoch,
    }),
  );
  const operation = prepared.newOperations[0];
  if (operation === undefined) throw new Error("Prepared Operation missing");
  repository.commitTransition(prepared);
  const submitted = value(
    evolveOperation(
      prepared.commission,
      operation,
      lease(),
      { kind: "submitted", submittedAt: epoch + 1 },
      epoch + 1,
    ),
  );
  repository.commitTransition(submitted);
  repository.close();
  store = undefined;

  repository = openStore();
  const recovered = repository.operations("commission-1");
  expect(recovered).toHaveLength(1);
  expect(recovered[0]).toMatchObject({
    id: operation.id,
    logicalKey: operation.logicalKey,
    outcome: { kind: "submitted", submittedAt: epoch + 1 },
  });
  const world = new FakeWorld();
  world.unknownRecovery = true;
  const app = new ApplicationService(
    repository,
    world,
    world,
    world,
    "controller-1",
    policy,
  );
  const result = await app.reconcile("commission-1", epoch + 2);
  expect(result.ok).toBe(true);
  if (result.ok)
    expect(result.value.decision).toMatchObject({
      kind: "wait",
      wake: { kind: "operation", operationId: operation.id },
    });
  expect(world.dispatchCount.get(operation.id)).toBeUndefined();
  expect(repository.operations("commission-1")).toHaveLength(1);
});

test("retry_authorized survives restart and replays the original Operation identity", async () => {
  let repository = openStore();
  repository.propose(proposal());
  const proposed = repository.get("commission-1");
  if (proposed === null) throw new Error("Proposal missing");
  const admitted = value(
    evolve(proposed, {
      kind: "admit",
      actor: { kind: "approver", identity: "operator" },
      lease: lease(),
      attemptId: "attempt-1",
      assignmentId: "assignment-1",
      now: epoch,
    }),
  );
  repository.commitTransition(admitted);

  const current = repository.get("commission-1");
  if (current === null) throw new Error("Admitted Commission missing");
  const prepared = value(
    evolve(current, {
      kind: "reconcile",
      lease: lease(),
      observation: observation(),
      operations: [],
      policy,
      now: epoch,
    }),
  );
  const original = prepared.newOperations[0];
  if (original === undefined) throw new Error("Continuation Operation missing");
  repository.commitTransition(prepared);
  const notApplied: OperationOutcome = {
    kind: "observed",
    observedAt: epoch + 1,
    source: "provider idempotency lookup",
    result: "not_applied",
    retrySafe: true,
    externalIdentity: null,
  };
  const observed = value(
    evolveOperation(
      prepared.commission,
      original,
      lease(),
      notApplied,
      epoch + 1,
    ),
  );
  repository.commitTransition(observed);

  const retryState = repository.get("commission-1");
  if (retryState === null)
    throw new Error("Commission missing before retry authorization");
  const authorizeRetry = value(
    evolve(retryState, {
      kind: "reconcile",
      lease: lease(),
      observation: observation(),
      operations: repository.operations("commission-1"),
      policy,
      now: epoch + 2,
    }),
  );
  expect(authorizeRetry.decision?.kind).toBe("retry_operation");
  expect(authorizeRetry.updatedOperations[0]?.id).toBe(original.id);
  repository.commitTransition(authorizeRetry);
  repository.close();
  store = undefined;
  repository = openStore();
  expect(repository.operations("commission-1")[0]).toMatchObject({
    id: original.id,
    logicalKey: original.logicalKey,
    retryCount: 1,
    outcome: {
      kind: "retry_authorized",
      observation: { result: "not_applied", retrySafe: true },
    },
  });

  const world = new FakeWorld();
  world.loseRetryAcknowledgement = true;
  const app = new ApplicationService(
    repository,
    world,
    world,
    world,
    "controller-1",
    policy,
  );
  const recovered = await app.reconcile("commission-1", epoch + 3);
  expect(recovered.ok).toBe(true);
  const ambiguousRetry = repository.operations("commission-1")[0];
  expect(ambiguousRetry?.id).toBe(original.id);
  expect(ambiguousRetry?.logicalKey).toBe(original.logicalKey);
  expect(ambiguousRetry?.retryCount).toBe(1);
  expect(ambiguousRetry?.outcome).toMatchObject({
    kind: "ambiguous",
  });
  expect(world.dispatchCount.get(original.id)).toBe(1);

  repository.close();
  store = undefined;
  repository = openStore();
  const afterRetryRestart = new ApplicationService(
    repository,
    world,
    world,
    world,
    "controller-1",
    policy,
  );
  const resolvedRetry = await afterRetryRestart.reconcile(
    "commission-1",
    epoch + 4,
  );
  expect(resolvedRetry.ok).toBe(true);
  const finalOperation = repository.operations("commission-1")[0];
  expect(finalOperation?.id).toBe(original.id);
  expect(finalOperation?.logicalKey).toBe(original.logicalKey);
  expect(finalOperation?.retryCount).toBe(1);
  expect(finalOperation?.outcome).toMatchObject({
    kind: "observed",
    result: "applied",
  });
  expect(world.dispatchCount.get(original.id)).toBe(1);
});

test("the application authorization port rejects objective/criterion replacement by an unapproved principal", async () => {
  const repository = openStore();
  repository.propose(proposal());
  const denied = new ApplicationService(
    repository,
    { current: async () => ({ ok: true, value: lease() }) },
    {
      observe: async () => ({ ok: true, value: observation() }),
      dispatch: async () => ({
        ok: false,
        error: { kind: "unavailable", message: "unused" },
      }),
      inspectOperation: async () => ({ ok: true, value: null }),
    },
    { approve: async () => false },
    "controller-1",
    policy,
  );
  const amendment = await denied.amendSpecification(
    "commission-1",
    "attacker",
    1,
    {
      objective: "Replace the approved objective",
      integrationTarget: "unprotected-branch",
      obligations: [
        {
          id: "acceptance-1",
          description: "Waive delivery",
          independentReviewRequired: false,
        },
      ],
      independentReviewRequired: false,
    },
    epoch,
  );
  expect(amendment).toEqual({ ok: false, error: { kind: "unauthorized" } });
  expect(repository.get("commission-1")?.objective).toBe(
    "Implement bounded delivery",
  );
  expect(repository.get("commission-1")?.integrationTarget).toBe("main");
});
