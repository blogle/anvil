import { expect, test } from "bun:test";
import fc, { type Command } from "fast-check";
import {
  decide,
  evolve,
  evolveOperation,
  proposeCommission,
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
  proposalInput,
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
                  contextTokens: null,
                  contextLimitTokens: null,
                  repeatedToolFailures:
                    this.action.state === "active_tool_failure"
                      ? ["tool-1", "tool-2", "tool-3"]
                      : [],
                  lastProgressAt: now,
                  safeBoundary: this.action.state === "active_tool_failure",
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
      contextTokens: null,
      contextLimitTokens: null,
      repeatedToolFailures: [],
      lastProgressAt: epoch,
      safeBoundary: false,
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
        contextTokens: null,
        contextLimitTokens: null,
        repeatedToolFailures: [],
        lastProgressAt: epoch,
        safeBoundary: false,
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

test("proposal rejects zero Attempt and instruction limits", () => {
  const input = proposalInput();
  expect(
    proposeCommission({
      ...input,
      budget: { ...input.budget, maxAttempts: 0 },
    }),
  ).toEqual({ ok: false, error: "invalid_proposal" });
  expect(
    proposeCommission({
      ...input,
      budget: { ...input.budget, maxInstructions: 0 },
    }),
  ).toEqual({ ok: false, error: "invalid_proposal" });
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

test("runtime provisioning must persist an external identity before the next effect", () => {
  const current = admittedCommission();
  const prepared = value(
    evolve(current, {
      kind: "reconcile",
      lease: lease(),
      observation: observation(),
      operations: [],
      policy: { ...policy, runtimeProvisioning: true },
      now: epoch,
    }),
  );
  expect(prepared.decision?.kind).toBe("provision_sandbox");
  const operation = prepared.newOperations[0];
  if (operation === undefined)
    throw new Error("Sandbox intent was not journaled");
  expect(
    evolveOperation(
      prepared.commission,
      operation,
      lease(),
      {
        kind: "observed",
        observedAt: epoch + 1,
        source: "sandbox fixture",
        result: "applied",
        retrySafe: false,
        externalIdentity: null,
      },
      epoch + 1,
    ),
  ).toEqual({ ok: false, error: "invalid_observation" });
});

test("instruction, repair, cost, and deadline budgets stop only the constrained work", () => {
  const oneInstruction = admittedCommission({
    budget: {
      maxAttempts: 3,
      maxInstructions: 1,
      maxRepairs: 3,
      maxCostMicros: 100,
      deadlineAt: epoch + 10_000,
    },
  });
  const firstTurn = value(
    evolve(oneInstruction, {
      kind: "reconcile",
      lease: lease(),
      observation: observation(),
      operations: [],
      policy,
      now: epoch,
    }),
  );
  expect(firstTurn.decision?.kind).toBe("continue");
  expect(firstTurn.commission.budget.used.instructions).toBe(1);
  expect(
    decide(firstTurn.commission, observation(), [], policy, epoch).kind,
  ).toBe("hold");

  const noCost = admittedCommission({
    budget: {
      maxAttempts: 3,
      maxInstructions: 12,
      maxRepairs: 3,
      maxCostMicros: 0,
      deadlineAt: epoch + 10_000,
    },
  });
  expect(decide(noCost, observation(), [], policy, epoch)).toMatchObject({
    kind: "hold",
    reason: "budget_exhausted",
  });

  const deadline = admittedCommission({
    budget: {
      maxAttempts: 3,
      maxInstructions: 12,
      maxRepairs: 3,
      maxCostMicros: 100,
      deadlineAt: epoch + 10,
    },
  });
  expect(decide(deadline, observation(), [], policy, epoch + 10)).toMatchObject(
    {
      kind: "hold",
      reason: "budget_exhausted",
    },
  );

  const noRepairs = admittedCommission({
    budget: {
      maxAttempts: 3,
      maxInstructions: 12,
      maxRepairs: 0,
      maxCostMicros: 100,
      deadlineAt: epoch + 10_000,
    },
  });
  const failureObservation = observation({
    candidateRevision: "candidate-1",
    workerClaims: [
      {
        id: "worker-1",
        obligationId: "acceptance-1",
        claim: "implemented",
        observedAt: epoch,
        expiresAt: epoch + 10_000,
        sourceIdentity: "session-1",
      },
    ],
    checks: {
      runId: "failed-check",
      revision: "candidate-1",
      state: "failing",
      failureIds: ["lint:1"],
      observedAt: epoch,
      expiresAt: epoch + 10_000,
      source: "ci",
    },
  });
  const withWorkerEvidence = value(
    evolve(noRepairs, {
      kind: "reconcile",
      lease: lease(),
      observation: failureObservation,
      operations: [],
      policy,
      now: epoch,
    }),
  ).commission;
  expect(
    decide(withWorkerEvidence, failureObservation, [], policy, epoch).kind,
  ).toBe("change_strategy");
});

test("over-limit instructions, cost, and deadline hold without preparing effects", () => {
  const base = admittedCommission();
  const cases: { name: string; commission: Commission; now?: number }[] = [
    {
      name: "instructions",
      commission: {
        ...base,
        budget: {
          ...base.budget,
          used: {
            ...base.budget.used,
            instructions: base.budget.limits.maxInstructions + 1,
          },
        },
      },
    },
    {
      name: "cost",
      commission: {
        ...base,
        budget: {
          ...base.budget,
          used: {
            ...base.budget.used,
            costMicros: base.budget.limits.maxCostMicros + 1,
          },
        },
      },
    },
    {
      name: "deadline",
      commission: {
        ...base,
        budget: {
          ...base.budget,
          limits: { ...base.budget.limits, deadlineAt: epoch + 1 },
        },
      },
      now: epoch + 2,
    },
  ];
  for (const testCase of cases) {
    const now = testCase.now ?? epoch;
    const beforeVersion = testCase.commission.version;
    const result = value(
      evolve(testCase.commission, {
        kind: "reconcile",
        lease: lease(),
        observation: observation(),
        operations: [],
        policy,
        now,
      }),
    );
    expect(result.decision, testCase.name).toMatchObject({
      kind: "hold",
      reason: "budget_exhausted",
    });
    expect(result.newOperations, testCase.name).toHaveLength(0);
    expect(result.commission.version, testCase.name).toBe(beforeVersion);
  }
});

test("attempt and repair overlimits block only another strategy or repair", () => {
  const base = admittedCommission({
    budget: {
      maxAttempts: 3,
      maxInstructions: 12,
      maxRepairs: 3,
      maxCostMicros: 1_000,
      deadlineAt: epoch + 10_000,
    },
  });
  const failedCandidate = observation({
    candidateRevision: "revision-1",
    workerClaims: [
      {
        id: "attempt-repair-claim",
        obligationId: "acceptance-1",
        claim: "Candidate implemented",
        observedAt: epoch,
        expiresAt: epoch + 10_000,
        sourceIdentity: "worker",
      },
    ],
    checks: {
      runId: "failing-check",
      revision: "revision-1",
      state: "failing",
      failureIds: ["lint:E1"],
      observedAt: epoch,
      expiresAt: epoch + 10_000,
      source: "ci",
    },
  });
  const evidenced = value(
    evolve(base, {
      kind: "reconcile",
      lease: lease(),
      observation: failedCandidate,
      operations: [],
      policy,
      now: epoch,
    }),
  ).commission;
  const noRepairs = {
    ...evidenced,
    budget: {
      ...evidenced.budget,
      limits: { ...evidenced.budget.limits, maxRepairs: 0 },
      used: { ...evidenced.budget.used, repairs: 1 },
    },
  };
  expect(decide(noRepairs, failedCandidate, [], policy, epoch)).toMatchObject({
    kind: "change_strategy",
  });
  expect(
    decide(noRepairs, failedCandidate, [], policy, epoch),
  ).not.toMatchObject({
    kind: "repair",
  });

  const attemptsExhausted = {
    ...noRepairs,
    budget: {
      ...noRepairs.budget,
      used: {
        ...noRepairs.budget.used,
        attempts: noRepairs.budget.limits.maxAttempts + 1,
      },
    },
  };
  expect(
    decide(attemptsExhausted, failedCandidate, [], policy, epoch),
  ).toMatchObject({ kind: "hold", reason: "budget_exhausted" });
});

test("recording measured usage may cross the cost limit but blocks the next instruction", () => {
  const base = admittedCommission({
    budget: {
      maxAttempts: 3,
      maxInstructions: 12,
      maxRepairs: 3,
      maxCostMicros: 10,
      deadlineAt: epoch + 10_000,
    },
  });
  const nearLimit = {
    ...base,
    budget: {
      ...base.budget,
      used: { ...base.budget.used, costMicros: 9 },
    },
  };
  const charged = value(
    evolve(nearLimit, {
      kind: "record_usage",
      lease: lease(),
      costMicros: 2,
      now: epoch,
    }),
  );
  expect(charged.commission.budget.used.costMicros).toBe(11);
  const stopped = value(
    evolve(charged.commission, {
      kind: "reconcile",
      lease: lease(),
      observation: observation(),
      operations: [],
      policy,
      now: epoch + 1,
    }),
  );
  expect(stopped.decision).toMatchObject({
    kind: "hold",
    reason: "budget_exhausted",
  });
  expect(stopped.newOperations).toHaveLength(0);
});

test("watchdog waits for a safe boundary, then reacts to context pressure, tool failures, and an active stall", () => {
  const base = admittedCommission();
  const busy = observation({
    execution: {
      kind: "running",
      sessionId: "session-watchdog",
      contextPressure: true,
      contextTokens: 9_000,
      contextLimitTokens: 10_000,
      repeatedToolFailures: [],
      lastProgressAt: epoch,
      safeBoundary: false,
      observedAt: epoch,
      expiresAt: epoch + 30_000,
      source: "opencode-v2",
    },
  });
  if (busy.execution.kind !== "running")
    throw new Error("Expected active watchdog observation");
  expect(decide(base, busy, [], policy, epoch)).toMatchObject({
    kind: "wait",
    reason:
      "watchdog finding observed while provider reports no safe execution boundary",
  });
  const pressureAtBoundary = {
    ...busy,
    execution: { ...busy.execution, safeBoundary: true },
  };
  const pressureTransition = value(
    evolve(base, {
      kind: "reconcile",
      lease: lease(),
      observation: pressureAtBoundary,
      operations: [],
      policy,
      now: epoch,
    }),
  );
  expect(pressureTransition.decision).toMatchObject({
    kind: "interrupt",
    directive: "Watchdog interrupt cause: context-pressure",
  });
  const pressureInterrupt = pressureTransition.newOperations[0];
  if (pressureInterrupt === undefined)
    throw new Error("Safe watchdog boundary was not journaled");
  expect(pressureInterrupt).toMatchObject({
    kind: "interrupt",
    target: "session:session-watchdog",
    outcome: { kind: "prepared" },
  });
  const pressureResolved = value(
    evolveOperation(
      pressureTransition.commission,
      pressureInterrupt,
      lease(),
      {
        kind: "observed",
        observedAt: epoch,
        source: "local OpenCode interrupt fixture",
        result: "applied",
        retrySafe: false,
        externalIdentity: "session-watchdog",
      },
      epoch,
    ),
  );
  const resumedAfterPressure = value(
    evolve(pressureResolved.commission, {
      kind: "reconcile",
      lease: lease(),
      observation: {
        ...pressureAtBoundary,
        execution: {
          kind: "idle",
          sessionId: "session-watchdog",
          observedAt: epoch,
          expiresAt: epoch + 30_000,
          source: "opencode-v2",
        },
      },
      operations: pressureResolved.updatedOperations,
      policy,
      now: epoch,
    }),
  );
  expect(resumedAfterPressure.decision).toMatchObject({
    kind: "refresh_context",
  });

  const candidate = observation({
    candidateRevision: "revision-watchdog",
    execution: {
      kind: "running",
      sessionId: "session-watchdog",
      contextPressure: false,
      contextTokens: 2_000,
      contextLimitTokens: 10_000,
      repeatedToolFailures: [
        "tool:test:error",
        "tool:test:error",
        "tool:lint:error",
      ],
      lastProgressAt: epoch,
      safeBoundary: true,
      observedAt: epoch,
      expiresAt: epoch + 30_000,
      source: "opencode-v2",
    },
  });
  expect(decide(base, candidate, [], policy, epoch)).toMatchObject({
    kind: "interrupt",
    directive: "Watchdog interrupt cause: repeated-tool-failures",
    findingIds: ["tool:test:error", "tool:test:error", "tool:lint:error"],
  });
  const toolInterruption = value(
    evolve(base, {
      kind: "reconcile",
      lease: lease(),
      observation: candidate,
      operations: [],
      policy,
      now: epoch,
    }),
  );
  const toolInterrupt = toolInterruption.newOperations[0];
  if (toolInterrupt === undefined)
    throw new Error("Tool-failure interrupt was not journaled");
  const toolResolved = value(
    evolveOperation(
      toolInterruption.commission,
      toolInterrupt,
      lease(),
      {
        kind: "observed",
        observedAt: epoch,
        source: "local OpenCode interrupt fixture",
        result: "applied",
        retrySafe: false,
        externalIdentity: "session-watchdog",
      },
      epoch,
    ),
  );
  const afterToolInterrupt = value(
    evolve(toolResolved.commission, {
      kind: "reconcile",
      lease: lease(),
      observation: {
        ...candidate,
        execution: {
          kind: "idle",
          sessionId: "session-watchdog",
          observedAt: epoch,
          expiresAt: epoch + 30_000,
          source: "opencode-v2",
        },
      },
      operations: toolResolved.updatedOperations,
      policy,
      now: epoch,
    }),
  );
  expect(afterToolInterrupt.decision).toMatchObject({
    kind: "repair",
    findingIds: ["tool:test:error", "tool:test:error", "tool:lint:error"],
  });
  const stalled = observation({
    execution: {
      kind: "running",
      sessionId: "session-watchdog",
      contextPressure: false,
      contextTokens: null,
      contextLimitTokens: null,
      repeatedToolFailures: [],
      lastProgressAt: epoch - policy.activeTurnStuckAfterMs,
      safeBoundary: true,
      observedAt: epoch,
      expiresAt: epoch + 30_000,
      source: "opencode-v2",
    },
  });
  if (stalled.execution.kind !== "running")
    throw new Error("Expected active stalled observation");
  expect(decide(base, stalled, [], policy, epoch)).toMatchObject({
    kind: "interrupt",
    directive: "Watchdog interrupt cause: stuck-active-turn",
  });
  expect(
    decide(
      base,
      { ...stalled, execution: { ...stalled.execution, safeBoundary: false } },
      [],
      policy,
      epoch,
    ).kind,
  ).toBe("wait");
  const stalledTransition = value(
    evolve(base, {
      kind: "reconcile",
      lease: lease(),
      observation: stalled,
      operations: [],
      policy,
      now: epoch,
    }),
  );
  const stalledInterrupt = stalledTransition.newOperations[0];
  if (stalledInterrupt === undefined)
    throw new Error("Stuck-turn watchdog interrupt was not journaled");
  const stalledResolved = value(
    evolveOperation(
      stalledTransition.commission,
      stalledInterrupt,
      lease(),
      {
        kind: "observed",
        observedAt: epoch,
        source: "local OpenCode interrupt fixture",
        result: "applied",
        retrySafe: false,
        externalIdentity: "session-watchdog",
      },
      epoch,
    ),
  );
  const changedStrategy = value(
    evolve(stalledResolved.commission, {
      kind: "reconcile",
      lease: lease(),
      observation: {
        ...stalled,
        execution: {
          kind: "idle",
          sessionId: "session-watchdog",
          observedAt: epoch,
          expiresAt: epoch + 30_000,
          source: "opencode-v2",
        },
      },
      operations: stalledResolved.updatedOperations,
      policy,
      now: epoch,
    }),
  );
  expect(changedStrategy.decision).toMatchObject({
    kind: "change_strategy",
    nextStrategy: "recover-stuck-active-turn",
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

test("amendments invalidate changed criteria and retain only version-matched evidence", () => {
  const base = admittedCommission({
    obligations: [
      {
        id: "criterion-a",
        description: "Preserve the approved API behavior",
        independentReviewRequired: false,
      },
      {
        id: "criterion-b",
        description: "Keep the existing contract stable",
        independentReviewRequired: false,
      },
    ],
  });
  const originalEvidence = value(
    evolve(base, {
      kind: "reconcile",
      lease: lease(),
      observation: observation({
        candidateRevision: "revision-1",
        workerClaims: [
          {
            id: "worker-a-v1",
            obligationId: "criterion-a",
            claim: "criterion A done",
            observedAt: epoch,
            expiresAt: epoch + 30_000,
            sourceIdentity: "worker-session",
          },
          {
            id: "worker-b-v1",
            obligationId: "criterion-b",
            claim: "criterion B done",
            observedAt: epoch,
            expiresAt: epoch + 30_000,
            sourceIdentity: "worker-session",
          },
        ],
      }),
      operations: [],
      policy,
      now: epoch,
    }),
  ).commission;
  const amended = value(
    evolve(originalEvidence, {
      kind: "amend_specification",
      actor: { kind: "approver", identity: "operator-1" },
      expectedGeneration: 1,
      objective: base.objective,
      integrationTarget: base.integrationTarget,
      independentReviewRequired: false,
      obligations: [
        {
          id: "criterion-a",
          description: "Preserve the API behavior and backward compatibility",
          independentReviewRequired: true,
        },
        base.obligations[1]!,
      ],
      now: epoch + 1,
    }),
  ).commission;
  expect(amended.specificationGeneration).toBe(2);
  expect(
    amended.evidence.map(({ criterionVersion }) => criterionVersion),
  ).toEqual(
    originalEvidence.evidence.map(({ criterionVersion }) => criterionVersion),
  );

  const merged = observation({
    candidateRevision: "revision-1",
    candidateObservedAt: epoch,
    candidateExpiresAt: epoch + 30_000,
    candidateSource: "git",
    checks: {
      runId: "check-green",
      revision: "revision-1",
      state: "passing",
      failureIds: [],
      observedAt: epoch,
      expiresAt: epoch + 30_000,
      source: "ci",
    },
    integration: {
      kind: "merged",
      revision: "revision-1",
      providerIdentity: "github:repo/pull/1",
      repository: base.repository,
      target: base.integrationTarget,
      observedAt: epoch,
      expiresAt: epoch + 30_000,
      source: "github",
    },
  });
  const registered = {
    ...amended,
    registeredPullRequestId: "github:repo/pull/1",
  };
  expect(decide(registered, merged, [], policy, epoch).kind).not.toBe(
    "conclude",
  );
  const pressureTransition = value(
    evolve(registered, {
      kind: "reconcile",
      lease: lease(),
      observation: {
        ...merged,
        execution: {
          kind: "running",
          sessionId: "session-1",
          contextPressure: true,
          contextTokens: 9_000,
          contextLimitTokens: 10_000,
          repeatedToolFailures: [],
          lastProgressAt: epoch,
          safeBoundary: true,
          observedAt: epoch,
          expiresAt: epoch + 30_000,
          source: "opencode-v2",
        },
      },
      operations: [],
      policy,
      now: epoch,
    }),
  );
  expect(pressureTransition.decision?.kind).toBe("interrupt");
  const interrupt = pressureTransition.newOperations[0];
  if (interrupt === undefined) throw new Error("Watchdog Operation missing");
  const resolvedInterrupt = value(
    evolveOperation(
      pressureTransition.commission,
      interrupt,
      lease(),
      {
        kind: "observed",
        observedAt: epoch,
        source: "local OpenCode interrupt fixture",
        result: "applied",
        retrySafe: false,
        externalIdentity: "session-1",
      },
      epoch,
    ),
  );
  const followup = value(
    evolve(resolvedInterrupt.commission, {
      kind: "reconcile",
      lease: lease(),
      observation: {
        ...merged,
        execution: {
          kind: "idle",
          sessionId: "session-1",
          observedAt: epoch,
          expiresAt: epoch + 30_000,
          source: "opencode-v2",
        },
      },
      operations: resolvedInterrupt.updatedOperations,
      policy,
      now: epoch,
    }),
  );
  const refresh = followup.decision;
  expect(refresh).toMatchObject({ kind: "refresh_context" });
  if (refresh === null || refresh.kind !== "refresh_context")
    throw new Error("Expected watchdog context refresh");
  expect(refresh.directive).toContain(
    "Outstanding obligations: criterion-a: Preserve the API behavior and backward compatibility",
  );
  expect(refresh.directive).not.toContain("criterion-b:");
  const refreshOperation = followup.newOperations[0];
  if (refreshOperation === undefined)
    throw new Error("Watchdog context refresh was not journaled");
  const refreshResolved = value(
    evolveOperation(
      followup.commission,
      refreshOperation,
      lease(),
      {
        kind: "observed",
        observedAt: epoch,
        source: "local OpenCode context fixture",
        result: "applied",
        retrySafe: false,
        externalIdentity: "message-after-refresh",
      },
      epoch,
    ),
  );
  expect(
    decide(
      refreshResolved.commission,
      {
        ...merged,
        execution: {
          kind: "running",
          sessionId: "session-1",
          contextPressure: true,
          contextTokens: 9_000,
          contextLimitTokens: 10_000,
          repeatedToolFailures: [],
          lastProgressAt: epoch,
          safeBoundary: true,
          observedAt: epoch,
          expiresAt: epoch + 30_000,
          source: "opencode-v2",
        },
      },
      [
        ...resolvedInterrupt.updatedOperations,
        ...refreshResolved.updatedOperations,
      ],
      policy,
      epoch,
    ),
  ).toMatchObject({ kind: "wait" });

  const workerOnly = value(
    evolve(registered, {
      kind: "reconcile",
      lease: lease(),
      observation: {
        ...merged,
        workerClaims: [
          {
            id: "worker-a-v2",
            obligationId: "criterion-a",
            claim: "updated criterion A done",
            observedAt: epoch + 2,
            expiresAt: epoch + 30_000,
            sourceIdentity: "worker-session",
          },
        ],
      },
      operations: [],
      policy,
      now: epoch + 2,
    }),
  ).commission;
  expect(workerOnly.evidence).toContainEqual(
    expect.objectContaining({
      id: "worker-a-v2",
      source: { kind: "worker", identity: "worker-session" },
      disposition: "submitted",
    }),
  );
  expect(decide(workerOnly, merged, [], policy, epoch + 2).kind).not.toBe(
    "conclude",
  );

  const independentlyReviewed = value(
    evolve(workerOnly, {
      kind: "reconcile",
      lease: lease(),
      observation: {
        ...merged,
        integration: { kind: "none" },
        workerClaims: [],
        independentReviews: [
          {
            id: "review-a-v2",
            obligationId: "criterion-a",
            candidateRevision: "revision-1",
            specificationGeneration: 2,
            result: "accepted",
            checkRunId: "check-green",
            claim: "Updated API behavior verified",
            observedAt: epoch + 3,
            expiresAt: epoch + 30_000,
            sourceIdentity: "reviewer-1",
          },
        ],
      },
      operations: [],
      policy,
      now: epoch + 3,
    }),
  ).commission;
  expect(
    independentlyReviewed.evidence.find(({ id }) => id === "review-a-v2"),
  ).toMatchObject({
    source: { kind: "independent", identity: "reviewer-1" },
    disposition: "accepted",
    checkRunId: "check-green",
  });
  expect(
    decide(independentlyReviewed, merged, [], policy, epoch + 3).kind,
  ).toBe("conclude");
  expect(
    decide(
      independentlyReviewed,
      {
        ...merged,
        checks: { ...merged.checks!, runId: "different-check-run" },
      },
      [],
      policy,
      epoch + 3,
    ).kind,
  ).not.toBe("conclude");

  const changedSharedDependency = value(
    evolve(workerOnly, {
      kind: "amend_specification",
      actor: { kind: "approver", identity: "operator-1" },
      expectedGeneration: 2,
      objective: "Change the objective that scopes all criteria",
      integrationTarget: base.integrationTarget,
      independentReviewRequired: false,
      obligations: workerOnly.obligations,
      now: epoch + 4,
    }),
  ).commission;
  expect(
    decide(
      {
        ...changedSharedDependency,
        registeredPullRequestId: "github:repo/pull/1",
      },
      merged,
      [],
      policy,
      epoch + 4,
    ).kind,
  ).not.toBe("conclude");
});

test("an identical amendment is a no-op and a stale generation is rejected", () => {
  const base = admittedCommission({
    obligations: [
      {
        id: "first",
        description: "First criterion",
        independentReviewRequired: false,
      },
      {
        id: "second",
        description: "Second criterion",
        independentReviewRequired: true,
      },
    ],
  });
  const unchanged = value(
    evolve(base, {
      kind: "amend_specification",
      actor: { kind: "approver", identity: "operator-1" },
      expectedGeneration: 1,
      objective: base.objective,
      integrationTarget: base.integrationTarget,
      obligations: [...base.obligations].reverse(),
      independentReviewRequired: base.independentReviewRequired,
      now: epoch + 1,
    }),
  );
  expect(unchanged.commission).toBe(base);
  expect(unchanged.commission.version).toBe(base.version);
  expect(
    evolve(unchanged.commission, {
      kind: "amend_specification",
      actor: { kind: "approver", identity: "operator-1" },
      expectedGeneration: 0,
      objective: "Stale objective",
      integrationTarget: base.integrationTarget,
      obligations: base.obligations,
      independentReviewRequired: base.independentReviewRequired,
      now: epoch + 2,
    }),
  ).toEqual({ ok: false, error: "stale_generation" });
});

test("an unchanged unknown check snapshot waits after one Verify Operation instead of dispatching repeatedly", () => {
  const commission = admittedCommission();
  const revision = "candidate-unknown-checks";
  const world = observation({
    candidateRevision: revision,
    checks: {
      runId: "github-checkset:candidate-unknown-checks:",
      revision,
      state: "unknown",
      failureIds: [],
      observedAt: epoch,
      expiresAt: epoch + 60_000,
      source: "github-check-runs-rest",
    },
    workerClaims: [
      {
        id: "worker-claim-unknown-checks",
        obligationId: "acceptance-1",
        claim: "Candidate work is ready for verification",
        observedAt: epoch,
        expiresAt: epoch + 60_000,
        sourceIdentity: "session-1",
      },
    ],
  });
  const first = evolve(commission, {
    kind: "reconcile",
    lease: lease(),
    observation: world,
    operations: [],
    policy,
    now: epoch + 1,
  });
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error("Initial Verify decision was rejected");
  expect(first.value.decision).toEqual({
    kind: "verify",
    candidateRevision: revision,
  });
  const prepared = first.value.newOperations[0];
  expect(prepared?.kind).toBe("verify");
  if (prepared === undefined)
    throw new Error("Verify Operation was not prepared");
  const completed = evolveOperation(
    first.value.commission,
    prepared,
    lease(),
    {
      kind: "observed",
      observedAt: epoch + 1,
      source: "github-check-runs-rest",
      result: "applied",
      retrySafe: false,
      externalIdentity: "github-checkset:candidate-unknown-checks:",
    },
    epoch + 1,
  );
  expect(completed.ok).toBe(true);
  if (!completed.ok) throw new Error("Verify outcome was rejected");
  const second = evolve(completed.value.commission, {
    kind: "reconcile",
    lease: lease(),
    observation: world,
    operations: completed.value.updatedOperations,
    policy,
    now: epoch + 2,
  });
  expect(second.ok).toBe(true);
  if (!second.ok) throw new Error("Repeated check observation was rejected");
  expect(second.value.decision).toMatchObject({
    kind: "wait",
    reason: "the same check evidence remains unknown after verification",
  });
  expect(second.value.updatedOperations).toHaveLength(0);
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
