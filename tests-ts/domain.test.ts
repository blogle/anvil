import { describe, expect, test } from "bun:test";
import fc, { type Command } from "fast-check";
import {
  decideCommission,
  type Commission,
  type Evidence,
} from "../src-ts/domain";

const now = 1_800_000_000_000;

function commission(): Commission {
  return {
    id: "commission-1",
    campaignId: "campaign-1",
    objective: "Deliver the approved objective",
    repository: "https://github.com/example/repository",
    integrationTarget: "main",
    generation: 1,
    lifecycle: "active",
    owner: { controllerId: "controller-1", leaseExpiresAt: now + 60_000 },
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
      costLimitMicros: 1_000_000,
      costUsedMicros: 10,
      deadlineAt: now + 3_600_000,
    },
    candidate: { revision: "revision-1", observedAt: now },
    obligations: [
      { id: "obligation-1", description: "A meaningful acceptance condition" },
    ],
    evidence: [],
    execution: {
      kind: "idle",
      sessionId: "session-1",
      observedAt: now,
      expiresAt: now + 10_000,
    },
    checks: null,
    integration: { kind: "none" },
    operations: [],
    findings: [],
  };
}

function acceptedEvidence(
  source: Evidence["source"] = { kind: "controller", identity: "review-1" },
): Evidence {
  return {
    id: "evidence-1",
    obligationId: "obligation-1",
    candidateRevision: "revision-1",
    source,
    disposition: "accepted",
    observedAt: now,
    expiresAt: now + 10_000,
  };
}

function finding(id: string, summary: string, candidateRevision?: string) {
  return {
    id,
    summary,
    source: { kind: "controller" as const, identity: "reconciler" },
    observedAt: now,
    expiresAt: now + 10_000,
    ...(candidateRevision === undefined ? {} : { candidateRevision }),
  };
}

describe("Commission reconciliation", () => {
  test("holds when the lease has expired or the controller does not own the Commission", () => {
    const expired = commission();
    expired.owner = { controllerId: "controller-1", leaseExpiresAt: now };
    expect(decideCommission(expired, now)).toEqual({
      kind: "hold",
      reason: "authority_lost",
    });

    const unowned = commission();
    unowned.owner = null;
    expect(decideCommission(unowned, now)).toEqual({
      kind: "hold",
      reason: "authority_lost",
    });
  });

  test("does not select a new effect while an operation outcome is ambiguous", () => {
    const state = commission();
    state.operations.push({
      id: "operation-1",
      kind: "instruction",
      target: "session-1",
      authorizedGeneration: 1,
      assignmentId: "assignment-1",
      attemptId: "attempt-1",
      candidateRevision: null,
      findingIds: [],
      state: {
        kind: "ambiguous",
        observedAt: now,
        reason: "lost acknowledgement",
      },
      createdAt: now,
    });
    expect(decideCommission(state, now)).toEqual({
      kind: "wait",
      reason: "operation_outcome",
    });
  });

  test("observes active execution, refreshing context or repairing a known failure", () => {
    const active = commission();
    active.execution = {
      kind: "running",
      sessionId: "session-1",
      observedAt: now,
      expiresAt: now + 10_000,
      contextPressure: false,
      toolFailures: [],
    };
    expect(decideCommission(active, now)).toEqual({
      kind: "wait",
      reason: "active_execution",
    });

    active.execution = { ...active.execution, contextPressure: true };
    expect(decideCommission(active, now)).toEqual({
      kind: "refresh_context",
      attemptId: "attempt-1",
    });

    active.execution = {
      ...active.execution,
      contextPressure: false,
      toolFailures: ["tool timeout"],
    };
    active.findings.push(finding("finding-1", "Repeated tool timeout"));
    expect(decideCommission(active, now)).toEqual({
      kind: "repair",
      findingIds: ["finding-1"],
      candidateRevision: "revision-1",
    });
  });

  test("continues bounded work and does not treat worker self-report as accepted evidence", () => {
    const state = commission();
    state.candidate = null;
    expect(decideCommission(state, now)).toEqual({
      kind: "continue",
      assignmentId: "assignment-1",
      attemptId: "attempt-1",
      reason: "no_candidate",
    });

    state.candidate = { revision: "revision-1", observedAt: now };
    state.evidence = [
      acceptedEvidence({ kind: "worker", identity: "session-1" }),
    ];
    expect(decideCommission(state, now)).toEqual({
      kind: "verify",
      candidateRevision: "revision-1",
    });
  });

  test("repairs failing current checks and verifies stale candidate-bound checks", () => {
    const state = commission();
    state.evidence = [acceptedEvidence()];
    state.checks = {
      candidateRevision: "revision-1",
      state: "failing",
      observedAt: now,
      expiresAt: now + 1_000,
    };
    state.findings.push(
      finding("finding-1", "CI reports lint failure", "revision-1"),
    );
    expect(decideCommission(state, now)).toEqual({
      kind: "repair",
      findingIds: ["finding-1"],
      candidateRevision: "revision-1",
    });

    state.checks = { ...state.checks, candidateRevision: "old-revision" };
    state.findings[0] = finding(
      "finding-1",
      "CI reports lint failure",
      "old-revision",
    );
    expect(decideCommission(state, now)).toEqual({
      kind: "verify",
      candidateRevision: "revision-1",
    });
  });

  test("requires current authoritative evidence, healthy checks, and exact merged revision to conclude", () => {
    const state = commission();
    state.evidence = [acceptedEvidence()];
    state.checks = {
      candidateRevision: "revision-1",
      state: "passing",
      observedAt: now,
      expiresAt: now + 1_000,
    };
    state.integration = {
      kind: "pr_open",
      revision: "revision-1",
      observedAt: now,
      expiresAt: now + 1_000,
    };
    expect(decideCommission(state, now)).toEqual({
      kind: "integrate",
      candidateRevision: "revision-1",
    });

    state.integration = {
      kind: "queued",
      revision: "revision-1",
      observedAt: now,
      expiresAt: now + 1_000,
    };
    expect(decideCommission(state, now)).toEqual({
      kind: "wait",
      reason: "integration_queue",
    });

    state.integration = {
      kind: "merged",
      revision: "different-revision",
      observedAt: now,
      expiresAt: now + 1_000,
      providerIdentity: "github:repo/pr/1",
    };
    expect(decideCommission(state, now).kind).toBe("change_strategy");

    state.integration = {
      kind: "merged",
      revision: "revision-1",
      observedAt: now,
      expiresAt: now + 1_000,
      providerIdentity: "github:repo/pr/1",
    };
    expect(decideCommission(state, now)).toEqual({
      kind: "conclude",
      deliveredRevision: "revision-1",
    });
    state.integration.expiresAt = now;
    expect(decideCommission(state, now)).toEqual({
      kind: "wait",
      reason: "provider_observation",
    });
  });

  test("has no progress decision after an attempt, repair, cost, or time budget is exhausted", () => {
    const budget = fc.record({
      maxAttempts: fc.integer({ min: 0, max: 10 }),
      costLimit: fc.integer({ min: 0, max: 1_000_000 }),
      expired: fc.boolean(),
    });
    fc.assert(
      fc.property(budget, ({ maxAttempts, costLimit, expired }) => {
        const state = commission();
        state.budget.maxAttempts = maxAttempts;
        state.budget.attemptsUsed = maxAttempts;
        state.budget.costLimitMicros = costLimit;
        state.budget.costUsedMicros = costLimit;
        if (expired) state.budget.deadlineAt = now;
        const result = decideCommission(state, now);
        expect(result.kind).toBe("hold");
        expect(result).not.toHaveProperty("assignmentId");
      }),
      { seed: 0xa11ce, numRuns: 250 },
    );
  });

  test("stale worker evidence, stale check results, and green checks alone never complete delivery", () => {
    const input = fc.record({
      revision: fc.string({ minLength: 1, maxLength: 12 }),
      source: fc.constantFrom<Evidence["source"]>(
        { kind: "worker", identity: "agent" },
        { kind: "check", identity: "CI" },
        { kind: "github", identity: "GitHub" },
      ),
    });
    fc.assert(
      fc.property(input, ({ revision, source }) => {
        const state = commission();
        state.evidence = [
          {
            ...acceptedEvidence(source),
            candidateRevision: revision,
            expiresAt: now,
          },
        ];
        state.checks = {
          candidateRevision: "revision-1",
          state: "passing",
          observedAt: now,
          expiresAt: now + 1_000,
        };
        state.integration = {
          kind: "pr_open",
          revision: "revision-1",
          observedAt: now,
          expiresAt: now + 1_000,
        };
        const result = decideCommission(state, now);
        expect(result.kind).not.toBe("conclude");
      }),
      { seed: 0xc0ffee, numRuns: 250 },
    );
  });

  test("does not act on expired or future-dated provider observations", () => {
    const expiredExecution = commission();
    expiredExecution.execution = {
      kind: "idle",
      sessionId: "session-1",
      observedAt: now - 10_000,
      expiresAt: now,
    };
    expect(decideCommission(expiredExecution, now)).toEqual({
      kind: "wait",
      reason: "provider_observation",
    });

    const futureCandidate = commission();
    futureCandidate.candidate = { revision: "revision-1", observedAt: now + 1 };
    expect(decideCommission(futureCandidate, now)).toEqual({
      kind: "wait",
      reason: "provider_observation",
    });

    const futureEvidence = commission();
    futureEvidence.evidence = [
      {
        ...acceptedEvidence(),
        observedAt: now + 1,
        expiresAt: now + 10_000,
      },
    ];
    futureEvidence.checks = {
      candidateRevision: "revision-1",
      state: "passing",
      observedAt: now,
      expiresAt: now + 10_000,
    };
    futureEvidence.integration = {
      kind: "merged",
      revision: "revision-1",
      observedAt: now,
      expiresAt: now + 10_000,
      providerIdentity: "github:repo/pr/1",
    };
    expect(decideCommission(futureEvidence, now).kind).not.toBe("conclude");
  });

  test("state-machine commands preserve authority, budget, and Candidate invalidation invariants", () => {
    type Model = { ownerValid: boolean; budgetAvailable: boolean };
    type Real = { commission: Commission };

    class ExpireLease implements Command<Model, Real> {
      check = () => true;
      run(model: Model, real: Real): void {
        model.ownerValid = false;
        real.commission.owner = {
          controllerId: "controller-1",
          leaseExpiresAt: now,
        };
        expect(decideCommission(real.commission, now)).toEqual({
          kind: "hold",
          reason: "authority_lost",
        });
      }
      toString = () => "ExpireLease";
    }

    class ExhaustBudget implements Command<Model, Real> {
      check = () => true;
      run(model: Model, real: Real): void {
        model.budgetAvailable = false;
        real.commission.budget.attemptsUsed =
          real.commission.budget.maxAttempts;
        const result = decideCommission(real.commission, now);
        expect(result.kind).toBe("hold");
        if (model.ownerValid)
          expect(result).toEqual({ kind: "hold", reason: "budget_exhausted" });
      }
      toString = () => "ExhaustBudget";
    }

    class PublishCandidate implements Command<Model, Real> {
      constructor(readonly revision: number) {}
      check = () => true;
      run(model: Model, real: Real): void {
        real.commission.candidate = {
          revision: `revision-${this.revision}`,
          observedAt: now,
        };
        const result = decideCommission(real.commission, now);
        if (model.ownerValid && model.budgetAvailable)
          expect(result.kind).not.toBe("conclude");
      }
      toString = () => `PublishCandidate(${this.revision})`;
    }

    const delivered = commission();
    delivered.evidence = [acceptedEvidence()];
    delivered.checks = {
      candidateRevision: "revision-1",
      state: "passing",
      observedAt: now,
      expiresAt: now + 1_000,
    };
    delivered.integration = {
      kind: "merged",
      revision: "revision-1",
      observedAt: now,
      expiresAt: now + 1_000,
      providerIdentity: "github:repo/pr/1",
    };
    const commands = fc.commands<Model, Real>(
      [
        fc.constant(new ExpireLease()),
        fc.constant(new ExhaustBudget()),
        fc
          .integer({ min: 2, max: 100 })
          .map((revision) => new PublishCandidate(revision)),
      ],
      { maxCommands: 25 },
    );
    fc.assert(
      fc.property(commands, (sequence) => {
        fc.modelRun(
          () => ({
            model: { ownerValid: true, budgetAvailable: true },
            real: { commission: structuredClone(delivered) },
          }),
          sequence,
        );
      }),
      { seed: 0x51a7e, numRuns: 100 },
    );
  });
});
