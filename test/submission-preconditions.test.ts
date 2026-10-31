import { expect, test } from "bun:test";
import { ApplicationService } from "../src/application";
import { CommissionStore } from "../src/persistence/sqlite";
import { FakeWorld } from "./support/fake-world";
import { evolve, evolveOperation, type Commission } from "../src/domain";
import {
  admittedCommission,
  epoch,
  lease,
  observation,
  policy,
  value,
  proposalInput,
} from "./support/fixtures";

test("prepared work cannot bypass hold, amendment, Candidate, Attempt or deadline changes; outcomes remain recordable", () => {
  const prepared = value(
    evolve(admittedCommission(), {
      kind: "reconcile",
      lease: lease(),
      observation: observation(),
      operations: [],
      policy,
      now: epoch + 1,
    }),
  );
  const operation = prepared.newOperations[0]!;
  const current = prepared.commission;
  const denied: readonly Commission[] = [
    { ...current, lifecycle: "held", holdReason: "review" },
    {
      ...current,
      specificationGeneration: current.specificationGeneration + 1,
    },
    { ...current, activeAttemptId: "different-attempt" },
    {
      ...current,
      budget: {
        ...current.budget,
        limits: { ...current.budget.limits, deadlineAt: epoch + 2 },
      },
    },
    {
      ...current,
      budget: {
        ...current.budget,
        used: {
          ...current.budget.used,
          costMicros: current.budget.limits.maxCostMicros,
        },
      },
    },
  ];
  for (const commission of denied) {
    expect(
      evolveOperation(
        commission,
        operation,
        lease(),
        { kind: "submitted", submittedAt: epoch + 2 },
        epoch + 2,
      ).ok,
    ).toBe(false);
    expect(
      evolveOperation(
        commission,
        {
          ...operation,
          outcome: { kind: "submitted", submittedAt: epoch + 1 },
        },
        lease(),
        {
          kind: "observed",
          observedAt: epoch + 2,
          source: "remote-inspection",
          result: "accepted",
          retrySafe: false,
          externalIdentity: "message-original",
        },
        epoch + 2,
      ).ok,
    ).toBe(true);
  }
  expect(
    evolveOperation(
      { ...current, candidateRevision: "changed" },
      { ...operation, candidateRevision: "old" },
      lease(),
      { kind: "submitted", submittedAt: epoch + 2 },
      epoch + 2,
    ).ok,
  ).toBe(false);
  // Instruction budget was reserved at prepare time; reaching exactly the
  // limit must not strand the last authorized instruction before first dispatch.
  expect(
    evolveOperation(
      {
        ...current,
        budget: {
          ...current.budget,
          limits: {
            ...current.budget.limits,
            maxInstructions: current.budget.used.instructions,
          },
        },
      },
      operation,
      lease(),
      { kind: "submitted", submittedAt: epoch + 2 },
      epoch + 2,
    ).ok,
  ).toBe(true);
});

test("an operator hold prevents a recovered prepared instruction from dispatching until resume", async () => {
  const store = new CommissionStore(":memory:");
  try {
    const world = new FakeWorld();
    const app = new ApplicationService(
      store,
      world,
      world,
      world,
      "controller-1",
      policy,
    );
    app.propose(proposalInput());
    const admitted = value(
      await app.admit("commission-1", "operator-1", epoch),
    );
    const prepared = value(
      evolve(admitted, {
        kind: "reconcile",
        lease: lease(),
        observation: observation(),
        operations: [],
        policy,
        now: epoch + 1,
      }),
    );
    expect(store.commitTransition(prepared).ok).toBe(true);
    value(await app.hold("commission-1", "independent review", epoch + 2));
    await app.reconcile("commission-1", epoch + 3);
    expect(world.dispatchCount.size).toBe(0);
    expect(store.operations("commission-1")[0]?.outcome.kind).toBe("prepared");
    value(await app.resume("commission-1", epoch + 4));
    value(await app.reconcile("commission-1", epoch + 5));
    expect(world.dispatchCount.get(prepared.newOperations[0]!.id)).toBe(1);
  } finally {
    store.close();
  }
});
