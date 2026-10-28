import { expect, test } from "bun:test";
import fc, { type Command } from "fast-check";
import {
  decide,
  evolve,
  evolveOperation,
  type Commission,
  type LeaseGrant,
  type Observation,
  type Operation,
} from "../src/domain";
import {
  admittedCommission,
  epoch,
  lease,
  observation,
  policy,
  proposal,
  value,
} from "./support/fixtures";

type Reference = {
  lifecycle: Commission["lifecycle"];
  ownerEpoch: number | null;
  leaseLive: boolean;
  costUsed: number;
  maximumCost: number;
  candidate: string | null;
  workerReportFor: string | null;
  checkRevision: string | null;
  checkPassing: boolean;
  mergedRevision: string | null;
};
type System = {
  commission: Commission;
  lease: LeaseGrant;
  world: Observation;
  operations: Operation[];
};
type Action =
  | { kind: "admit" }
  | { kind: "spend"; amount: number }
  | { kind: "candidate"; revision: number }
  | { kind: "report" }
  | { kind: "check"; passing: boolean }
  | { kind: "execution"; state: "running" | "idle" | "active_tool_failure" }
  | { kind: "queue" }
  | { kind: "continue" }
  | { kind: "merge"; matching: boolean }
  | { kind: "ack_lost" | "ack_seen" | "duplicate" }
  | { kind: "expire" }
  | { kind: "takeover" }
  | { kind: "reconcile" };

function started(): { model: Reference; real: System } {
  const initial = proposal({ id: "property-commission" }).commission;
  return {
    model: {
      lifecycle: "proposed",
      ownerEpoch: null,
      leaseLive: true,
      costUsed: 0,
      maximumCost: initial.budget.limits.maxCostMicros,
      candidate: null,
      workerReportFor: null,
      checkRevision: null,
      checkPassing: false,
      mergedRevision: null,
    },
    real: {
      commission: initial,
      lease: lease(),
      world: observation(),
      operations: [],
    },
  };
}

function mayConclude(model: Reference): boolean {
  return (
    model.candidate !== null &&
    model.workerReportFor === model.candidate &&
    model.checkRevision === model.candidate &&
    model.checkPassing &&
    model.mergedRevision === model.candidate
  );
}

class ActionCommand implements Command<Reference, System> {
  constructor(readonly action: Action) {}
  check(model: Readonly<Reference>): boolean {
    if (this.action.kind === "admit") return model.lifecycle === "proposed";
    if (this.action.kind === "takeover") return true;
    if (this.action.kind === "expire")
      return model.ownerEpoch !== null && model.leaseLive;
    return model.ownerEpoch !== null && model.leaseLive;
  }

  run(model: Reference, system: System): void {
    const now = epoch + system.commission.version * 2 + 1;
    switch (this.action.kind) {
      case "admit": {
        const transition = evolve(system.commission, {
          kind: "admit",
          actor: { kind: "approver", identity: "authorized-model-operator" },
          lease: system.lease,
          attemptId: "attempt_1",
          assignmentId: "assignment_1",
          now,
        });
        if (!transition.ok)
          throw new Error(`Admission was rejected: ${transition.error}`);
        system.commission = transition.value.commission;
        model.lifecycle = "active";
        model.ownerEpoch = system.lease.owner.epoch;
        model.costUsed = system.commission.budget.used.costMicros;
        break;
      }
      case "spend": {
        const amount = Math.max(
          0,
          Math.min(this.action.amount, model.maximumCost - model.costUsed),
        );
        if (amount > 0) {
          const transition = evolve(system.commission, {
            kind: "record_usage",
            lease: system.lease,
            costMicros: amount,
            now,
          });
          if (!transition.ok)
            throw new Error(`Usage rejected: ${transition.error}`);
          system.commission = transition.value.commission;
          model.costUsed += amount;
        }
        break;
      }
      case "candidate": {
        const revision = `candidate-${this.action.revision}`;
        model.candidate = revision;
        model.workerReportFor = null;
        model.checkRevision = null;
        model.mergedRevision = null;
        model.checkPassing = false;
        system.world = {
          ...system.world,
          candidateRevision: revision,
          candidateObservedAt: now,
          candidateExpiresAt: now + 60_000,
          candidateSource: "model-git",
          workerClaims: [],
          checks: null,
          integration: { kind: "none" },
        };
        this.#reconcile(model, system, now);
        break;
      }
      case "report":
        if (model.candidate !== null) {
          model.workerReportFor = model.candidate;
          system.world = {
            ...system.world,
            workerClaims: [
              {
                id: `claim-${model.candidate}`,
                obligationId: "acceptance-1",
                claim: "reported",
                observedAt: now,
                expiresAt: now + 60_000,
                sourceIdentity: "session-1",
              },
            ],
          };
          this.#reconcile(model, system, now);
        }
        break;
      case "check":
        if (model.candidate !== null) {
          model.checkRevision = model.candidate;
          model.checkPassing = this.action.passing;
          system.world = {
            ...system.world,
            checks: {
              runId: `check-${this.action.passing}`,
              revision: model.candidate,
              state: this.action.passing ? "passing" : "failing",
              failureIds: this.action.passing ? [] : ["lint:E1"],
              observedAt: now,
              expiresAt: now + 60_000,
              source: "ci",
            },
          };
          this.#reconcile(model, system, now);
        }
        break;
      case "execution":
        system.world = {
          ...system.world,
          execution:
            this.action.state === "idle"
              ? {
                  kind: "idle",
                  sessionId: "session-1",
                  observedAt: now,
                  expiresAt: now + 60_000,
                  source: "opencode",
                }
              : {
                  kind: "running",
                  sessionId: "session-1",
                  contextPressure: false,
                  repeatedToolFailures:
                    this.action.state === "active_tool_failure"
                      ? ["tool-1", "tool-2", "tool-3"]
                      : [],
                  observedAt: now,
                  expiresAt: now + 60_000,
                  source: "opencode",
                },
        };
        this.#reconcile(model, system, now);
        break;
      case "queue":
        if (model.candidate !== null) {
          system.world = {
            ...system.world,
            integration: {
              kind: "queued",
              revision: model.candidate,
              providerIdentity: "model-pr/1",
              repository: "https://github.com/example/repository",
              target: "main",
              observedAt: now,
              expiresAt: now + 60_000,
              source: "mergify",
            },
          };
          this.#reconcile(model, system, now);
        }
        break;
      case "merge":
        if (model.candidate !== null) {
          model.mergedRevision = this.action.matching
            ? model.candidate
            : `${model.candidate}-wrong`;
          system.world = {
            ...system.world,
            integration: {
              kind: "merged",
              revision: model.mergedRevision,
              providerIdentity: "model-pr/1",
              repository: "https://github.com/example/repository",
              target: "main",
              observedAt: now,
              expiresAt: now + 60_000,
              source: "github",
            },
          };
          this.#reconcile(model, system, now);
        }
        break;
      case "expire":
        model.leaseLive = false;
        system.lease = { ...system.lease, validUntil: now };
        this.#reconcile(model, system, now);
        break;
      case "ack_lost": {
        if (model.candidate === null) {
          model.candidate = "ack-candidate";
          system.world = {
            ...system.world,
            candidateRevision: model.candidate,
            candidateObservedAt: now,
            candidateExpiresAt: now + 60_000,
            candidateSource: "model-git",
          };
        }
        this.#reconcile(model, system, now, "ambiguous");
        break;
      }
      case "ack_seen": {
        const pending = system.operations.find(
          (operation) => operation.outcome.kind === "ambiguous",
        );
        if (pending !== undefined) {
          const outcome: Operation["outcome"] = {
            kind: "observed",
            observedAt: now,
            source: "model-provider",
            result: "applied",
            retrySafe: false,
            externalIdentity: null,
          };
          const transition = evolveOperation(
            system.commission,
            pending,
            system.lease,
            outcome,
            now,
          );
          if (!transition.ok)
            throw new Error(
              `Ambiguous Operation resolution rejected: ${transition.error}`,
            );
          system.commission = transition.value.commission;
          system.operations = system.operations.map((operation) =>
            operation.id === pending.id ? { ...operation, outcome } : operation,
          );
        }
        break;
      }
      case "duplicate": {
        if (model.candidate === null) {
          model.candidate = "duplicate-candidate";
          system.world = {
            ...system.world,
            candidateRevision: model.candidate,
            candidateObservedAt: now,
            candidateExpiresAt: now + 60_000,
            candidateSource: "model-git",
          };
        }
        const first = this.#reconcile(model, system, now, "leave_prepared");
        const second = this.#reconcile(model, system, now, "leave_prepared");
        expect(second).toHaveLength(0);
        for (const operation of first) {
          const outcome: Operation["outcome"] = {
            kind: "observed",
            observedAt: now,
            source: "model-provider",
            result: "applied",
            retrySafe: false,
            externalIdentity: null,
          };
          const transition = evolveOperation(
            system.commission,
            operation,
            system.lease,
            outcome,
            now,
          );
          if (!transition.ok)
            throw new Error(
              `Duplicate notification recovery failed: ${transition.error}`,
            );
          system.commission = transition.value.commission;
          system.operations = system.operations.map((item) =>
            item.id === operation.id ? { ...item, outcome } : item,
          );
        }
        break;
      }
      case "takeover": {
        const next = lease(
          `controller-${(model.ownerEpoch ?? 0) + 1}`,
          (model.ownerEpoch ?? 0) + 1,
        );
        const transition = evolve(system.commission, {
          kind: "takeover",
          lease: next,
          now,
        });
        if (!transition.ok)
          throw new Error(`Takeover rejected: ${transition.error}`);
        system.commission = transition.value.commission;
        system.lease = next;
        model.ownerEpoch = next.owner.epoch;
        model.leaseLive = true;
        break;
      }
      case "reconcile":
        this.#reconcile(model, system, now);
        break;
      case "continue":
        this.#reconcile(model, system, now);
        break;
    }
    expect(system.commission.budget.used.costMicros).toBe(model.costUsed);
    expect(system.commission.owner?.epoch ?? null).toBe(model.ownerEpoch);
    expect(
      new Set(system.operations.map(({ logicalKey }) => logicalKey)).size,
    ).toBe(system.operations.length);
    if (system.commission.lifecycle === "concluded")
      expect(mayConclude(model)).toBe(true);
  }

  #reconcile(
    model: Reference,
    system: System,
    now: number,
    resolution: "applied" | "ambiguous" | "leave_prepared" = "applied",
  ): readonly Operation[] {
    const decision = evolve(system.commission, {
      kind: "reconcile",
      lease: system.lease,
      observation: system.world,
      operations: system.operations,
      policy,
      now,
    });
    if (!model.leaseLive) {
      expect(decision).toEqual({ ok: false, error: "owner_mismatch" });
      return [];
    }
    if (!decision.ok)
      throw new Error(`Reconciliation rejected: ${decision.error}`);
    if (decision.value.decision?.kind === "conclude")
      expect(mayConclude(model)).toBe(true);
    system.commission = decision.value.commission;
    for (const operation of decision.value.newOperations) {
      system.operations.push(operation);
      if (resolution === "leave_prepared") continue;
      const outcome: Operation["outcome"] =
        resolution === "ambiguous"
          ? {
              kind: "ambiguous",
              observedAt: now,
              reason: "lost acknowledgement",
            }
          : {
              kind: "observed",
              observedAt: now,
              source: "model",
              result: operation.kind === "integrate" ? "accepted" : "applied",
              retrySafe: false,
              externalIdentity: null,
            };
      const resolved = evolveOperation(
        system.commission,
        operation,
        system.lease,
        outcome,
        now,
      );
      if (!resolved.ok)
        throw new Error(`Operation resolution rejected: ${resolved.error}`);
      system.commission = resolved.value.commission;
      system.operations = system.operations.map((item) =>
        item.id === operation.id ? { ...item, outcome } : item,
      );
    }
    return decision.value.newOperations;
  }
  toString(): string {
    return JSON.stringify(this.action);
  }
}

test("unchanged Wait and repeated Hold transitions do not advance the durable version", () => {
  const state = admittedCommission();
  const running = observation({
    execution: {
      kind: "running",
      sessionId: "session-1",
      contextPressure: false,
      repeatedToolFailures: [],
      observedAt: epoch,
      expiresAt: epoch + 10_000,
      source: "opencode",
    },
  });
  const wait = value(
    evolve(state, {
      kind: "reconcile",
      lease: lease(),
      observation: running,
      operations: [],
      policy,
      now: epoch,
    }),
  );
  expect(wait.decision?.kind).toBe("wait");
  expect(wait.commission.version).toBe(state.version);

  const held = value(
    evolve(state, {
      kind: "hold",
      lease: lease(),
      reason: "operator",
      now: epoch,
    }),
  );
  const sameHold = value(
    evolve(held.commission, {
      kind: "hold",
      lease: lease(),
      reason: "operator",
      now: epoch,
    }),
  );
  expect(sameHold.commission.version).toBe(held.commission.version);
});

test("domain decisions do not mutate frozen Commission or observation input", () => {
  const commission = deepFreeze(admittedCommission());
  const world = deepFreeze(
    observation({
      execution: {
        kind: "running",
        sessionId: "session-1",
        contextPressure: false,
        repeatedToolFailures: [],
        observedAt: epoch,
        expiresAt: epoch + 10_000,
        source: "opencode",
      },
    }),
  );
  const beforeCommission = structuredClone(commission);
  const beforeWorld = structuredClone(world);
  const result = evolve(commission, {
    kind: "reconcile",
    lease: lease(),
    observation: world,
    operations: [],
    policy,
    now: epoch,
  });
  expect(result.ok).toBe(true);
  expect(commission).toEqual(beforeCommission);
  expect(world).toEqual(beforeWorld);
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

test("maxAttempts one admits its first Attempt but blocks a second strategy Attempt", () => {
  const oneAttempt = admittedCommission({
    budget: {
      maxAttempts: 1,
      maxInstructions: 4,
      maxRepairs: 0,
      maxCostMicros: 100,
      deadlineAt: epoch + 10_000,
    },
  });
  expect(decide(oneAttempt, observation(), [], policy, epoch).kind).toBe(
    "continue",
  );
  const failingCandidate = observation({
    candidateRevision: "revision-1",
    workerClaims: [
      {
        id: "claim",
        obligationId: "acceptance-1",
        claim: "reported",
        observedAt: epoch,
        expiresAt: epoch + 10_000,
        sourceIdentity: "session",
      },
    ],
    checks: {
      runId: "failed",
      revision: "revision-1",
      state: "failing",
      failureIds: ["lint:E1"],
      observedAt: epoch,
      expiresAt: epoch + 10_000,
      source: "ci",
    },
  });
  const state = value(
    evolve(oneAttempt, {
      kind: "reconcile",
      lease: lease(),
      observation: failingCandidate,
      operations: [],
      policy,
      now: epoch,
    }),
  ).commission;
  expect(decide(state, failingCandidate, [], policy, epoch)).toEqual({
    kind: "hold",
    reason: "budget_exhausted",
  });
});

test("budget exhaustion blocks new work but not recording authoritative delivery", () => {
  const state = admittedCommission();
  const exhausted: Commission = {
    ...state,
    budget: {
      limits: state.budget.limits,
      used: {
        attempts: state.budget.limits.maxAttempts,
        instructions: state.budget.limits.maxInstructions,
        repairs: state.budget.limits.maxRepairs,
        costMicros: state.budget.limits.maxCostMicros,
      },
    },
  };
  expect(decide(exhausted, observation(), [], policy, epoch)).toMatchObject({
    kind: "hold",
    reason: "budget_exhausted",
  });
});

test("seeded fast-check state-machine commands preserve owner, budget, revision evidence, and completion invariants", () => {
  const actions: fc.Arbitrary<Action> = fc.oneof(
    fc
      .integer({ min: 0, max: 1_000_000 })
      .map((amount): Action => ({ kind: "spend", amount })),
    fc
      .integer({ min: 1, max: 20 })
      .map((revision): Action => ({ kind: "candidate", revision })),
    fc.constant<Action>({ kind: "report" }),
    fc.constantFrom<Action>(
      { kind: "check", passing: true },
      { kind: "check", passing: false },
    ),
    fc.constantFrom<Action>(
      { kind: "execution", state: "running" },
      { kind: "execution", state: "idle" },
      { kind: "execution", state: "active_tool_failure" },
    ),
    fc.constant<Action>({ kind: "queue" }),
    fc.constant<Action>({ kind: "continue" }),
    fc.constantFrom<Action>(
      { kind: "merge", matching: true },
      { kind: "merge", matching: false },
    ),
    fc.constant<Action>({ kind: "expire" }),
    fc.constant<Action>({ kind: "takeover" }),
    fc.constant<Action>({ kind: "ack_lost" }),
    fc.constant<Action>({ kind: "ack_seen" }),
    fc.constant<Action>({ kind: "duplicate" }),
    fc.constant<Action>({ kind: "reconcile" }),
  );
  const commands = fc.commands<Reference, System>(
    [actions.map((action) => new ActionCommand(action))],
    { maxCommands: 30 },
  );
  fc.assert(
    fc.property(commands, (sequence) => fc.modelRun(started, sequence)),
    { seed: 0x51a7e, numRuns: 100 },
  );
});

test("a fresh authoritative merge resolves its matching unresolved integration Operation", () => {
  const base = admittedCommission();
  const worker = observation({
    candidateRevision: "revision-1",
    workerClaims: [
      {
        id: "worker-1",
        obligationId: "acceptance-1",
        claim: "done",
        observedAt: epoch,
        expiresAt: epoch + 10_000,
        sourceIdentity: "session-1",
      },
    ],
  });
  const evidenced = value(
    evolve(base, {
      kind: "reconcile",
      lease: lease(),
      observation: worker,
      operations: [],
      policy,
      now: epoch,
    }),
  ).commission;
  const evidenceState: Commission = {
    ...evidenced,
    registeredPullRequestId: "github:repo/pr/1",
  };
  const integration: Operation = {
    id: "integration-operation",
    logicalKey: "integration-operation",
    commissionId: base.id,
    kind: "integrate",
    target: "delivery:repository:main",
    controllerId: "controller-1",
    ownerEpoch: 1,
    specificationGeneration: 1,
    assignmentId: "assignment-1",
    attemptId: "attempt-1",
    instructionSequence: 1,
    retryCount: 0,
    candidateRevision: "revision-1",
    findingIds: [],
    directive: "integrate revision-1",
    createdAt: epoch,
    outcome: { kind: "ambiguous", observedAt: epoch, reason: "ack lost" },
  };
  const merged = observation({
    candidateRevision: "revision-1",
    workerClaims: worker.workerClaims,
    checks: {
      runId: "green",
      revision: "revision-1",
      state: "passing",
      failureIds: [],
      observedAt: epoch,
      expiresAt: epoch + 10_000,
      source: "ci",
    },
    integration: {
      kind: "merged",
      revision: "revision-1",
      providerIdentity: "github:repo/pr/1",
      repository: "https://github.com/example/repository",
      target: "main",
      observedAt: epoch,
      expiresAt: epoch + 10_000,
      source: "github",
    },
  });
  const transition = value(
    evolve(evidenceState, {
      kind: "reconcile",
      lease: lease(),
      observation: merged,
      operations: [integration],
      policy,
      now: epoch,
    }),
  );
  expect(transition.decision?.kind).toBe("conclude");
  expect(transition.updatedOperations).toHaveLength(1);
  expect(transition.updatedOperations[0]?.outcome).toMatchObject({
    kind: "observed",
    result: "accepted",
    source: "github",
  });
  const exhaustedDeliveryState: Commission = {
    ...evidenceState,
    budget: {
      limits: evidenceState.budget.limits,
      used: {
        attempts: evidenceState.budget.limits.maxAttempts,
        instructions: evidenceState.budget.limits.maxInstructions,
        repairs: evidenceState.budget.limits.maxRepairs,
        costMicros: evidenceState.budget.limits.maxCostMicros,
      },
    },
  };
  expect(
    decide(exhaustedDeliveryState, merged, [integration], policy, epoch).kind,
  ).toBe("conclude");
  const matchingIntegration = merged.integration;
  if (matchingIntegration.kind !== "merged")
    throw new Error("Expected merged provider observation");
  for (const mismatch of [
    {
      ...matchingIntegration,
      repository: "https://github.com/other/repository",
    },
    { ...matchingIntegration, target: "release" },
    { ...matchingIntegration, providerIdentity: "github:repo/pr/2" },
    { ...matchingIntegration, revision: "other-revision" },
    {
      ...matchingIntegration,
      observedAt: epoch - 70_000,
      expiresAt: epoch - 1,
    },
    { ...matchingIntegration, observedAt: epoch + 1 },
  ]) {
    expect(
      decide(
        evidenceState,
        { ...merged, integration: mismatch },
        [integration],
        policy,
        epoch,
      ).kind,
    ).not.toBe("conclude");
  }
  for (const kind of ["pr_open", "queued"] as const) {
    expect(
      decide(
        evidenceState,
        {
          ...merged,
          integration: { ...matchingIntegration, kind },
        },
        [integration],
        policy,
        epoch,
      ).kind,
    ).not.toBe("conclude");
  }
  for (const state of ["pending", "failing"] as const) {
    expect(
      decide(
        evidenceState,
        { ...merged, checks: { ...merged.checks!, state } },
        [integration],
        policy,
        epoch,
      ).kind,
    ).not.toBe("conclude");
  }
  expect(
    decide(
      { ...evidenceState, independentReviewRequired: true },
      merged,
      [integration],
      policy,
      epoch,
    ).kind,
  ).not.toBe("conclude");
});
