import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommissionStore } from "../src-ts/persistence/sqlite";
import type { Commission, Operation } from "../src-ts/domain";

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
  directory ??= mkdtempSync(join(tmpdir(), "anvil-store-"));
  store = new CommissionStore(join(directory, "state.sqlite"));
  return store;
}

function freshCommission(): Commission {
  return {
    id: "commission-1",
    campaignId: "campaign-1",
    objective: "Deliver the approved objective",
    repository: "https://github.com/example/repository",
    integrationTarget: "main",
    generation: 1,
    lifecycle: "active",
    owner: { controllerId: "controller-1", leaseExpiresAt: 1_900_000_000_000 },
    assignmentId: "assignment-1",
    attempt: {
      id: "attempt-1",
      ordinal: 1,
      disposition: "active",
      strategy: "implementation",
    },
    budget: {
      maxAttempts: 3,
      maxRepairs: 2,
      attemptsUsed: 1,
      repairsUsed: 0,
      costLimitMicros: 100_000,
      costUsedMicros: 1_000,
      deadlineAt: 1_900_000_000_000,
    },
    candidate: null,
    obligations: [{ id: "acceptance-1", description: "A required outcome" }],
    evidence: [],
    execution: {
      kind: "idle",
      sessionId: "session-1",
      observedAt: 1_800_000_000_000,
      expiresAt: 1_900_000_000_000,
    },
    checks: null,
    integration: { kind: "none" },
    operations: [],
    findings: [],
  };
}

test("persists Commission intent and prepared Operations across SQLite reopen", () => {
  const initial = freshCommission();
  expect(openStore().create(initial)).toBe(true);
  store?.close();
  store = undefined;

  const reopened = openStore();
  const operation: Operation = {
    id: "stable-instruction-identity",
    kind: "instruction",
    target: "opencode:session-1",
    authorizedGeneration: 1,
    assignmentId: "assignment-1",
    attemptId: "attempt-1",
    candidateRevision: null,
    findingIds: [],
    state: { kind: "prepared" },
    createdAt: 1_800_000_000_000,
  };
  const prepared = reopened.prepareOperation(
    initial.id,
    initial.generation,
    operation,
    1_800_000_000_000,
  );
  expect(prepared?.generation).toBe(2);
  expect(prepared?.operations).toEqual([operation]);
  expect(
    reopened.prepareOperation(
      initial.id,
      initial.generation,
      operation,
      1_800_000_000_000,
    ),
  ).toEqual(prepared);
  reopened.close();
  store = undefined;

  const recovered = openStore().get(initial.id);
  expect(recovered?.operations).toEqual([operation]);
  expect(recovered?.budget.attemptsUsed).toBe(1);
});

test("generation compare-and-swap allows a single writer and rejects stale mutations", () => {
  const initial = freshCommission();
  const repository = openStore();
  expect(repository.create(initial)).toBe(true);
  expect(repository.create(initial)).toBe(false);

  const next: Commission = {
    ...initial,
    generation: 2,
    budget: { ...initial.budget, attemptsUsed: 2 },
  };
  expect(repository.save(next, 1)).toBe(true);
  expect(repository.save({ ...next, generation: 2 }, 1)).toBe(false);
  expect(repository.get(initial.id)?.budget.attemptsUsed).toBe(2);
  expect(() =>
    repository.save(
      { ...next, generation: 3, budget: { ...next.budget, attemptsUsed: 1 } },
      2,
    ),
  ).toThrow("budget limits are immutable and usage cannot decrease");
});

test("independent SQLite connections cannot both commit from one Commission generation", () => {
  directory = mkdtempSync(join(tmpdir(), "anvil-writers-"));
  const path = join(directory, "state.sqlite");
  const first = new CommissionStore(path);
  const second = new CommissionStore(path);
  store = first;
  const initial = freshCommission();
  expect(first.create(initial)).toBe(true);

  const update: Commission = {
    ...initial,
    generation: 2,
    budget: { ...initial.budget, attemptsUsed: 2 },
  };
  expect(first.save(update, 1)).toBe(true);
  expect(
    second.save(
      {
        ...initial,
        generation: 2,
        budget: { ...initial.budget, attemptsUsed: 3 },
      },
      1,
    ),
  ).toBe(false);
  expect(second.get(initial.id)?.budget.attemptsUsed).toBe(2);
  second.close();
});

test("prepares an external operation only under current ownership and never changes its stable identity", () => {
  const initial = freshCommission();
  const repository = openStore();
  repository.create(initial);
  const operation: Operation = {
    id: "one-logical-instruction",
    kind: "instruction",
    target: "opencode:session-1",
    authorizedGeneration: 1,
    assignmentId: "assignment-1",
    attemptId: "attempt-1",
    candidateRevision: null,
    findingIds: [],
    state: { kind: "prepared" },
    createdAt: 1_800_000_000_000,
  };
  const first = repository.prepareOperation(
    initial.id,
    1,
    operation,
    1_800_000_000_000,
  );
  expect(first?.operations[0]?.id).toBe(operation.id);
  expect(
    repository.prepareOperation(initial.id, 2, operation, 1_800_000_000_000)
      ?.operations[0]?.id,
  ).toBe(operation.id);
  expect(
    repository.prepareOperation(
      initial.id,
      1,
      {
        ...operation,
        id: "duplicate",
      },
      1_800_000_000_000,
    ),
  ).toBeNull();
});

test("rejects effects not selected by reconciliation and expired authority", () => {
  const initial = freshCommission();
  const repository = openStore();
  repository.create(initial);
  const bypass: Operation = {
    id: "bypass-authorization",
    kind: "instruction",
    target: "opencode:session-1",
    authorizedGeneration: 1,
    assignmentId: "assignment-1",
    attemptId: "attempt-1",
    candidateRevision: null,
    findingIds: [],
    state: { kind: "prepared" },
    createdAt: 1_800_000_000_000,
  };
  expect(() =>
    repository.save({ ...initial, generation: 2, operations: [bypass] }, 1),
  ).toThrow("must pass through authorization and preparation");
  const forbidden: Operation = {
    id: "unauthorized-merge",
    kind: "integrate",
    target: "github:repo/pr/1",
    authorizedGeneration: 1,
    assignmentId: "assignment-1",
    attemptId: "attempt-1",
    candidateRevision: "revision-1",
    findingIds: [],
    state: { kind: "prepared" },
    createdAt: 1_800_000_000_000,
  };
  expect(() =>
    repository.prepareOperation(initial.id, 1, forbidden, 1_800_000_000_000),
  ).toThrow("is not authorized by the current continue decision");

  const expired: Operation = {
    ...forbidden,
    id: "expired-owner",
    kind: "instruction",
    candidateRevision: null,
  };
  expect(() =>
    repository.prepareOperation(initial.id, 1, expired, 1_900_000_000_000),
  ).toThrow("current Commission ownership");
  expect(repository.get(initial.id)?.operations).toEqual([]);
});

test("retains operation identity and allows only forward outcome transitions", () => {
  const initial = freshCommission();
  const repository = openStore();
  repository.create(initial);
  const prepared = repository.prepareOperation(
    initial.id,
    1,
    {
      id: "instruction-1",
      kind: "instruction",
      target: "opencode:session-1",
      authorizedGeneration: 1,
      assignmentId: "assignment-1",
      attemptId: "attempt-1",
      candidateRevision: null,
      findingIds: [],
      state: { kind: "prepared" },
      createdAt: 1_800_000_000_000,
    },
    1_800_000_000_000,
  );
  if (prepared === null) throw new Error("Expected operation authorization");
  const firstOperation = prepared.operations[0];
  if (firstOperation === undefined)
    throw new Error("Prepared Operation was not stored");

  const submittedOperation = {
    ...firstOperation,
    state: { kind: "submitted" as const, submittedAt: 1_800_000_000_001 },
  };
  const submitted: Commission = {
    ...prepared,
    generation: 3,
    operations: [submittedOperation],
  };
  expect(repository.save(submitted, 2)).toBe(true);

  const observedOperation = {
    ...submittedOperation,
    state: {
      kind: "observed" as const,
      observedAt: 1_800_000_000_002,
      source: "opencode-session-inspection",
      postcondition: "satisfied" as const,
    },
  };
  const observed: Commission = {
    ...submitted,
    generation: 4,
    operations: [observedOperation],
  };
  expect(repository.save(observed, 3)).toBe(true);

  expect(() =>
    repository.save(
      {
        ...observed,
        generation: 5,
        operations: [submittedOperation],
      },
      4,
    ),
  ).toThrow("Invalid Operation state transition");
  expect(() =>
    repository.save({ ...observed, generation: 5, operations: [] }, 4),
  ).toThrow("cannot be removed");
});

test("persists conclusion only when current evidence and authoritative delivery select Conclude", () => {
  const initial = freshCommission();
  const repository = openStore();
  repository.create(initial);
  expect(repository.conclude(initial.id, 1, 1_800_000_000_000)).toBeNull();
  expect(() =>
    repository.save({ ...initial, generation: 2, lifecycle: "concluded" }, 1),
  ).toThrow("lifecycle changes require");

  const ready: Commission = {
    ...initial,
    generation: 2,
    evidence: [
      {
        id: "verified-evidence",
        obligationId: "acceptance-1",
        candidateRevision: "revision-1",
        source: { kind: "controller", identity: "independent-check" },
        disposition: "accepted",
        observedAt: 1_800_000_000_000,
        expiresAt: 1_900_000_000_000,
      },
    ],
    candidate: { revision: "revision-1", observedAt: 1_800_000_000_000 },
    checks: {
      candidateRevision: "revision-1",
      state: "passing",
      observedAt: 1_800_000_000_000,
      expiresAt: 1_900_000_000_000,
    },
    integration: {
      kind: "merged",
      revision: "revision-1",
      observedAt: 1_800_000_000_000,
      expiresAt: 1_900_000_000_000,
      providerIdentity: "github:repo/pr/1",
    },
  };
  expect(repository.save(ready, 1)).toBe(true);
  expect(repository.conclude(initial.id, 2, 1_800_000_000_000)?.lifecycle).toBe(
    "concluded",
  );
  expect(repository.get(initial.id)?.lifecycle).toBe("concluded");
});
