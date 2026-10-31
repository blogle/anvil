import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  evolve,
  evolveOperation,
  type Commission,
  type Operation,
  type SteeringRequest,
} from "../src/domain";
import { CommissionStore } from "../src/persistence/sqlite";
import {
  admittedCommission,
  epoch,
  lease,
  observation,
  policy,
  value,
} from "./support/fixtures";
import { SteeringHarness } from "./support/steering-harness";

let harness: SteeringHarness | undefined;
afterEach(() => {
  harness?.close();
  harness = undefined;
});
async function setup() {
  harness = new SteeringHarness();
  await harness.initialize();
  return harness;
}

function boundSession(c: Commission): Operation {
  return {
    id: "session-operation",
    logicalKey: "session-operation",
    commissionId: c.id,
    kind: "create_session",
    target: "opencode:sandbox-1",
    controllerId: "controller-1",
    ownerEpoch: 1,
    specificationGeneration: 1,
    assignmentId: "assignment-1",
    attemptId: "attempt-1",
    instructionSequence: 1,
    retryCount: 0,
    candidateRevision: null,
    findingIds: [],
    directive: "Bind Session",
    createdAt: epoch,
    outcome: {
      kind: "observed",
      observedAt: epoch,
      source: "provider",
      result: "applied",
      retrySafe: false,
      externalIdentity: "session-1",
    },
  };
}

test("pure steering reserves one instruction without amending scope; idempotency and submission gates are governed", () => {
  const current = admittedCommission();
  const before = structuredClone(current);
  const request: SteeringRequest = {
    idempotencyKey: "request-1",
    assignmentId: "assignment-1",
    expectedVersion: current.version,
    expectedGeneration: 1,
    instruction: "Investigate recovery within approved scope",
  };
  const command = {
    kind: "steer" as const,
    actor: { kind: "approver" as const, identity: "operator-1" },
    request,
    operations: [boundSession(current)],
    lease: lease(),
    now: epoch + 1,
  };
  const prepared = value(evolve(current, command));
  const operation = prepared.newOperations[0]!;
  expect(current).toEqual(before);
  expect(prepared.commission.budget.used.instructions).toBe(1);
  expect(prepared.commission.attempts[0]!.nextInstructionSequence).toBe(2);
  for (const key of [
    "objective",
    "repository",
    "integrationTarget",
    "specificationGeneration",
    "obligations",
    "independentReviewRequired",
    "owner",
    "evidence",
  ] as const)
    expect(prepared.commission[key]).toEqual(before[key]);
  expect(prepared.commission.budget.limits).toEqual(before.budget.limits);
  // A strategy Attempt can change under the same Assignment/Session. Steering
  // binds the current Attempt and the Assignment's recorded Session, not a new
  // Session invented for that Attempt.
  const successorAttempt = {
    ...current.attempts[0]!,
    id: "attempt-2",
    ordinal: 2,
  };
  const reused = value(
    evolve(
      {
        ...current,
        activeAttemptId: "attempt-2",
        attempts: [
          { ...current.attempts[0]!, lifecycle: "superseded" },
          successorAttempt,
        ],
      },
      command,
    ),
  );
  expect(reused.newOperations[0]).toMatchObject({
    attemptId: "attempt-2",
    assignmentId: "assignment-1",
    target: "session:session-1",
  });
  expect(operation).toMatchObject({
    kind: "steer",
    target: "session:session-1",
    createdAt: epoch + 1,
    steering: { ...request, principalId: "operator-1" },
    outcome: { kind: "prepared" },
  });
  expect(operation.directive).toContain("does not amend");
  const repeat = { ...command, operations: [...command.operations, operation] };
  expect(value(evolve(prepared.commission, repeat)).commission.version).toBe(
    prepared.commission.version,
  );
  expect(
    evolve(prepared.commission, {
      ...repeat,
      request: { ...request, instruction: "Changed payload" },
    }),
  ).toEqual({ ok: false, error: "idempotency_conflict" });
  const submitted = { kind: "submitted" as const, submittedAt: epoch + 2 };
  expect(
    evolveOperation(
      prepared.commission,
      operation,
      lease(),
      submitted,
      epoch + 2,
    ),
  ).toEqual({ ok: false, error: "execution_not_idle" });
  const busy = observation({
    execution: {
      kind: "running",
      sessionId: "session-1",
      safeBoundary: true,
      contextPressure: false,
      contextTokens: null,
      contextLimitTokens: null,
      repeatedToolFailures: [],
      lastProgressAt: epoch,
      observedAt: epoch,
      expiresAt: epoch + 100,
      source: "provider",
    },
  });
  for (const obs of [
    busy,
    observation({
      execution: {
        kind: "idle",
        sessionId: "foreign",
        observedAt: epoch,
        expiresAt: epoch + 100,
        source: "provider",
      },
    }),
    observation({
      execution: {
        kind: "idle",
        sessionId: "session-1",
        observedAt: epoch + 3,
        expiresAt: epoch + 100,
        source: "provider",
      },
    }),
    observation({
      execution: {
        kind: "idle",
        sessionId: "session-1",
        observedAt: epoch,
        expiresAt: epoch + 2,
        source: "provider",
      },
    }),
  ])
    expect(
      evolveOperation(
        prepared.commission,
        operation,
        lease(),
        submitted,
        epoch + 2,
        { observation: obs, policy },
      ).ok,
    ).toBe(false);
  expect(
    evolveOperation(
      prepared.commission,
      operation,
      lease(),
      submitted,
      epoch + 2,
      { observation: observation(), policy },
    ).ok,
  ).toBe(true);
  for (const [c, r, expected] of [
    [current, { ...request, expectedVersion: 0 }, "stale_version"],
    [current, { ...request, expectedGeneration: 2 }, "stale_generation"],
    [current, { ...request, assignmentId: "foreign" }, "invalid_assignment"],
    [{ ...current, lifecycle: "held" }, request, "invalid_lifecycle"],
    [{ ...current, lifecycle: "concluded" }, request, "invalid_lifecycle"],
    [
      {
        ...current,
        budget: {
          ...current.budget,
          used: { ...current.budget.used, instructions: 12 },
        },
      },
      request,
      "budget_exhausted",
    ],
  ] as const)
    expect(evolve(c, { ...command, request: r })).toEqual({
      ok: false,
      error: expected,
    });
});

test("steering survives SQLite reopen, defers an active turn, dispatches once when idle and excludes autonomous Continue", async () => {
  const h = await setup();
  h.active = true;
  const request = h.request();
  const accepted = value(await h.steer(request));
  h.reopen();
  expect(
    h.store.operations("commission-1").find((o) => o.id === accepted.id),
  ).toEqual(accepted);
  const deferred = value(await h.reconcile());
  expect(deferred.decision?.kind).toBe("wait");
  expect(h.prompts).toHaveLength(0);
  expect(h.modelSelections).toBe(0);
  expect(h.interrupts).toBe(0);
  h.active = false;
  h.beforeModel = async () => {
    const persisted = h.store
      .operations("commission-1")
      .find((o) => o.id === accepted.id)!;
    expect(persisted.outcome.kind).toBe("submitted");
    expect(persisted.steering).toEqual({
      ...request,
      principalId: "operator-1",
    });
  };
  const concurrent = await Promise.all([h.reconcile(), h.reconcile()]);
  expect(concurrent.some((result) => result.ok)).toBe(true);
  expect(h.prompts).toHaveLength(1);
  expect(h.prompts[0]!.text).toContain(request.instruction);
  expect(
    h.store.operations("commission-1").filter((o) => o.kind === "continue"),
  ).toHaveLength(0);
  const next = value(await h.reconcile());
  expect(next.decision?.kind).toBe("wait");
  expect(h.prompts).toHaveLength(1); // cached pre-steer idle must not create Continue
  expect(value(await h.steer(request)).id).toBe(accepted.id);
  expect(h.store.get("commission-1")!.budget.used.instructions).toBe(1);
  const db = new Database(h.path, { readonly: true });
  const rows = db
    .query(
      "SELECT steering_request, outcome_kind FROM operations WHERE kind = 'steer'",
    )
    .all() as { steering_request: string; outcome_kind: string }[];
  expect(rows).toHaveLength(1);
  expect(JSON.parse(rows[0]!.steering_request)).toEqual({
    ...request,
    principalId: "operator-1",
  });
  expect(rows[0]!.outcome_kind).toBe("observed");
  db.close();
});

test("lost steering acknowledgement reopens and reobserves the original message without replay; absence remains unknown", async () => {
  const h = await setup();
  h.loseAcknowledgement = true;
  const request = h.request();
  const accepted = value(await h.steer(request));
  value(await h.reconcile());
  expect(
    h.store.operations("commission-1").find((o) => o.id === accepted.id)!
      .outcome.kind,
  ).toBe("ambiguous");
  expect(h.prompts).toHaveLength(1);
  h.hideMessages = true;
  h.reopen();
  value(await h.reconcile());
  value(await h.reconcile());
  expect(h.prompts).toHaveLength(1);
  expect(h.modelSelections).toBe(1);
  expect(value(await h.steer(request)).outcome.kind).toBe("ambiguous");
  h.hideMessages = false;
  value(await h.reconcile());
  const resolved = h.store
    .operations("commission-1")
    .find((o) => o.id === accepted.id)!;
  expect(resolved.outcome).toMatchObject({
    kind: "observed",
    result: "applied",
    externalIdentity: h.prompts[0]!.id,
  });
  expect(resolved.steering).toEqual(accepted.steering!);
  expect(h.prompts).toHaveLength(1);
});

test("operator authorization, strict payloads, generations, held state, budget and expired Lease reject steering without writes", async () => {
  const h = await setup();
  const request = h.request();
  const before = h.store.get("commission-1")!;
  expect(await h.steer(request, "worker-forgery")).toMatchObject({
    ok: false,
    error: { kind: "unauthorized" },
  });
  for (const [change, reason] of [
    [{ expectedGeneration: 99 }, "stale_generation"],
    [{ expectedVersion: 0 }, "stale_version"],
    [{ assignmentId: "foreign" }, "invalid_assignment"],
    [{ instruction: " " }, "invalid_steering"],
    [{ objective: "waive requirements" }, "invalid_steering"],
  ] as const)
    expect(await h.steer({ ...request, ...change })).toMatchObject({
      ok: false,
      error: { kind: "domain", error: reason },
    });
  expect(h.store.get("commission-1")).toEqual(before);
  h.world.grant = { ...h.world.grant, validUntil: h.now };
  expect(await h.steer()).toMatchObject({
    ok: false,
    error: { kind: "ownership_unavailable" },
  });
  h.world.grant = { ...h.world.grant, validUntil: h.now + 60000 };
  value(await h.application.hold("commission-1", "review", h.now));
  expect(await h.steer()).toMatchObject({
    ok: false,
    error: { kind: "domain", error: "invalid_lifecycle" },
  });
  value(await h.application.resume("commission-1", h.now));
  value(
    await h.application.recordUsage(
      "commission-1",
      before.budget.limits.maxCostMicros,
      h.now,
    ),
  );
  expect(await h.steer()).toMatchObject({
    ok: false,
    error: { kind: "domain", error: "budget_exhausted" },
  });
  expect(
    h.store.operations("commission-1").filter((o) => o.kind === "steer"),
  ).toHaveLength(0);
  expect(h.prompts).toHaveLength(0);
});

test("two SQLite writers admit one identical request; changed/reordered commands cannot duplicate or overtake it", async () => {
  const h = await setup();
  const otherStore = new CommissionStore(h.path);
  try {
    const other = h.makeApplication(otherStore);
    const request = h.request();
    const results = await Promise.all([
      h.steer(request),
      other.steerAssignment("commission-1", "operator-1", request, h.now),
    ]);
    expect(results.map((r) => value(r).id)).toEqual([
      value(results[0]!).id,
      value(results[0]!).id,
    ]);
    expect(
      h.store.operations("commission-1").filter((o) => o.kind === "steer"),
    ).toHaveLength(1);
    expect(h.store.get("commission-1")!.budget.used.instructions).toBe(1);
    expect(
      await h.steer({ ...request, instruction: "Different instruction" }),
    ).toMatchObject({ ok: false, error: { error: "idempotency_conflict" } });
    expect(
      await h.steer(h.request({ idempotencyKey: "second" })),
    ).toMatchObject({ ok: false, error: { error: "unresolved_operation" } });
    value(await h.reconcile());
    expect(h.prompts).toHaveLength(1);
  } finally {
    otherStore.close();
  }
});

test("steering admitted during an autonomous observation wins CAS rather than racing a Continue", async () => {
  const h = await setup();
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.beforeObserve = async () => {
    started();
    await blocked;
  };
  const autonomous = h.reconcile();
  await entered;
  value(await h.steer());
  h.beforeObserve = undefined;
  release();
  value(await autonomous);
  expect(h.prompts).toHaveLength(1);
  expect(
    h.store.operations("commission-1").filter((o) => o.kind === "continue"),
  ).toHaveLength(0);
});

test("a hold during model I/O prevents a prompt and records the rejected intent without overwriting the hold", async () => {
  const h = new SteeringHarness();
  harness = h;
  await h.initialize({
    ...admittedCommission().budget.limits,
    maxInstructions: 1,
  });
  value(await h.steer());
  h.beforeModel = async () => {
    value(
      await h.application.hold("commission-1", "hold during model I/O", h.now),
    );
  };
  value(await h.reconcile());
  expect(h.prompts).toHaveLength(0);
  expect(
    h.store.operations("commission-1").find((o) => o.kind === "steer")!.outcome,
  ).toMatchObject({
    kind: "rejected",
    reason: expect.stringContaining("preconditions changed"),
  });
  value(await h.application.resume("commission-1", h.now));
  expect(
    await h.steer(h.request({ idempotencyKey: "cannot-exceed-budget" })),
  ).toMatchObject({ ok: false, error: { error: "budget_exhausted" } });
});

test("the final reserved instruction dispatches at the exact limit and cannot admit another steering request", async () => {
  const h = new SteeringHarness();
  harness = h;
  await h.initialize({
    ...admittedCommission().budget.limits,
    maxInstructions: 1,
  });
  value(await h.steer());
  value(await h.reconcile());
  expect(h.prompts).toHaveLength(1);
  expect(h.store.get("commission-1")!.budget.used.instructions).toBe(1);
  expect(
    await h.steer(h.request({ idempotencyKey: "over-limit" })),
  ).toMatchObject({ ok: false, error: { error: "budget_exhausted" } });
});

test("Lease expiry during model I/O prevents the prompt; the submitted identity remains unresolved without safe retry proof", async () => {
  const h = await setup();
  const accepted = value(await h.steer());
  h.beforeModel = async () => {
    h.world.grant = { ...h.world.grant, validUntil: h.now };
  };
  expect(await h.reconcile()).toMatchObject({
    ok: false,
    error: { kind: "ownership_unavailable" },
  });
  expect(h.prompts).toHaveLength(0);
  h.world.grant = { ...h.world.grant, validUntil: h.now + 60000 };
  h.beforeModel = undefined;
  h.reopen();
  value(await h.reconcile());
  expect(
    h.store.operations("commission-1").find((o) => o.id === accepted.id)!
      .outcome.kind,
  ).toBe("submitted");
  expect(h.prompts).toHaveLength(0);
});

test("a Session becoming busy during model I/O is rejected before prompt submission", async () => {
  const h = await setup();
  value(await h.steer());
  h.beforeModel = async () => {
    h.active = true;
  };
  value(await h.reconcile());
  expect(h.prompts).toHaveLength(0);
  expect(h.interrupts).toBe(0);
  expect(
    h.store.operations("commission-1").find((o) => o.kind === "steer")!.outcome,
  ).toMatchObject({
    kind: "rejected",
    reason: expect.stringContaining("not idle"),
  });
});

test("another composition cannot reuse an idle cache from before the journaled steering dispatch", async () => {
  const h = await setup();
  const other = h.composition();
  value(
    await other.observe(
      h.store.get("commission-1")!,
      h.now,
      h.store.operations("commission-1"),
    ),
  );
  value(await h.steer());
  value(await h.reconcile());
  const read = value(
    await other.observe(
      h.store.get("commission-1")!,
      h.now,
      h.store.operations("commission-1"),
    ),
  );
  expect(read.execution.kind).toBe("running");
  expect(h.prompts).toHaveLength(1);
});

test("Lease loss and deadline expiry after admission do not dispatch prepared steering", async () => {
  const h = await setup();
  value(await h.steer());
  h.beforeObserve = async () => {
    h.world.grant = { ...h.world.grant, validUntil: h.now };
  };
  expect(await h.reconcile()).toMatchObject({
    ok: false,
    error: { kind: "ownership_unavailable" },
  });
  expect(h.prompts).toHaveLength(0);
  h.beforeObserve = undefined;
  h.now = h.store.get("commission-1")!.budget.limits.deadlineAt;
  h.world.grant = { ...h.world.grant, validUntil: h.now + 60000 };
  expect(await h.reconcile()).toMatchObject({
    ok: false,
    error: { error: "budget_exhausted" },
  });
  expect(h.prompts).toHaveLength(0);
  expect(
    h.store.operations("commission-1").find((o) => o.kind === "steer")!.outcome
      .kind,
  ).toBe("prepared");
});
