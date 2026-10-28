import {
  evolve,
  proposeCommission,
  type Commission,
  type CommissionProposalInput,
  type LeaseGrant,
  type Observation,
  type Policy,
  type Result,
  type Transition,
} from "../../src/domain";

export const epoch = 1_800_000_000_000;
export const policy: Policy = {
  maxObservationAgeMs: 60_000,
  repeatedToolFailureThreshold: 3,
  runtimeProvisioning: false,
};

export function lease(
  controllerId = "controller-1",
  ownerEpoch = 1,
): LeaseGrant {
  return {
    owner: { controllerId, epoch: ownerEpoch },
    resourceVersion: `rv-${ownerEpoch}`,
    observedAt: epoch,
    validUntil: epoch + 600_000,
  };
}

export function proposalInput(
  overrides: Partial<CommissionProposalInput> = {},
): CommissionProposalInput {
  return {
    id: "commission-1",
    campaignId: "campaign-1",
    objective: "Implement bounded delivery",
    repository: "https://github.com/example/repository",
    integrationTarget: "main",
    obligations: [
      {
        id: "acceptance-1",
        description: "Deliver the required behavior",
        independentReviewRequired: false,
      },
    ],
    independentReviewRequired: false,
    budget: {
      maxAttempts: 3,
      maxInstructions: 12,
      maxRepairs: 3,
      maxCostMicros: 1_000_000,
      deadlineAt: epoch + 3_600_000,
    },
    ...overrides,
  };
}

export function proposal(overrides: Partial<CommissionProposalInput> = {}) {
  const result = proposeCommission(proposalInput(overrides));
  return value(result);
}

export function admittedCommission(
  overrides: Partial<Parameters<typeof proposeCommission>[0]> = {},
): Commission {
  const initial = proposal(overrides).commission;
  return value(
    evolve(initial, {
      kind: "admit",
      actor: { kind: "approver", identity: "operator-1" },
      lease: lease(),
      attemptId: "attempt-1",
      assignmentId: "assignment-1",
      now: epoch,
    }),
  ).commission;
}

export function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    candidateRevision: null,
    candidateObservedAt: epoch,
    candidateExpiresAt: epoch + 60_000,
    candidateSource: "git-provider",
    execution: {
      kind: "idle",
      sessionId: "session-1",
      observedAt: epoch,
      expiresAt: epoch + 60_000,
      source: "opencode-provider",
    },
    checks: null,
    integration: { kind: "none" },
    workerClaims: [],
    independentReviews: [],
    ...overrides,
  };
}

export function value<T, E>(result: Result<T, E>): T {
  if (!result.ok)
    throw new Error(`Fixture setup failed: ${String(result.error)}`);
  return result.value;
}

export function transitionValue(
  result: Result<Transition, string>,
): Transition {
  if (!result.ok) throw new Error(`Fixture transition failed: ${result.error}`);
  return result.value;
}
