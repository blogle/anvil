export type Owner = Readonly<{
  controllerId: string;
  epoch: number;
}>;

export type LeaseGrant = Readonly<{
  owner: Owner;
  resourceVersion: string;
  observedAt: number;
  validUntil: number;
}>;

export type Obligation = Readonly<{
  id: string;
  description: string;
  independentReviewRequired: boolean;
}>;

export type Evidence = Readonly<{
  id: string;
  obligationId: string;
  specificationGeneration: number;
  criterionVersion: string;
  candidateRevision: string;
  source: Readonly<{ kind: "worker" | "independent"; identity: string }>;
  disposition: "submitted" | "accepted" | "challenged";
  observedAt: number;
  expiresAt: number;
  claim: string;
  checkRunId: string | null;
}>;

export type DeliveryEvidence = Readonly<{
  revision: string;
  repository: string;
  integrationTarget: string;
  providerIdentity: string;
  source: string;
  observedAt: number;
  expiresAt: number;
  checkRunId: string;
  specificationGeneration: number;
}>;

export type Attempt = Readonly<{
  id: string;
  assignmentId: string;
  ordinal: number;
  strategy: string;
  lifecycle: "active" | "superseded" | "completed";
  nextInstructionSequence: number;
}>;

export type Budget = Readonly<{
  limits: Readonly<{
    maxAttempts: number;
    maxInstructions: number;
    maxRepairs: number;
    maxCostMicros: number;
    deadlineAt: number;
  }>;
  used: Readonly<{
    attempts: number;
    instructions: number;
    repairs: number;
    costMicros: number;
  }>;
}>;

export type Commission = Readonly<{
  id: string;
  campaignId: string;
  objective: string;
  repository: string;
  integrationTarget: string;
  specificationGeneration: number;
  obligations: readonly Obligation[];
  independentReviewRequired: boolean;
  lifecycle: "proposed" | "admitted" | "active" | "held" | "concluded";
  holdReason: string | null;
  owner: Owner | null;
  version: number;
  attempts: readonly Attempt[];
  activeAttemptId: string | null;
  budget: Budget;
  candidateRevision: string | null;
  candidateObservedAt: number | null;
  candidateExpiresAt: number | null;
  candidateSource: string | null;
  deliveryEvidence: DeliveryEvidence | null;
  registeredPullRequestId: string | null;
  evidence: readonly Evidence[];
}>;

export type OperationKind =
  | "provision_sandbox"
  | "create_session"
  | "interrupt"
  | "continue"
  | "repair"
  | "refresh_context"
  | "change_strategy"
  | "verify"
  | "integrate";

export type OperationOutcome =
  | Readonly<{ kind: "prepared" }>
  | Readonly<{ kind: "submitted"; submittedAt: number }>
  | Readonly<{ kind: "ambiguous"; observedAt: number; reason: string }>
  | Readonly<{
      kind: "observed";
      observedAt: number;
      source: string;
      result: "accepted" | "rejected" | "applied" | "not_applied";
      retrySafe: boolean;
      externalIdentity: string | null;
    }>
  | Readonly<{
      kind: "retry_authorized";
      authorizedAt: number;
      observation: Readonly<{
        observedAt: number;
        source: string;
        result: "not_applied";
        retrySafe: true;
      }>;
    }>
  | Readonly<{ kind: "rejected"; observedAt: number; reason: string }>;

export type Operation = Readonly<{
  id: string;
  logicalKey: string;
  commissionId: string;
  kind: OperationKind;
  target: string;
  controllerId: string;
  ownerEpoch: number;
  specificationGeneration: number;
  assignmentId: string;
  attemptId: string;
  instructionSequence: number;
  retryCount: number;
  candidateRevision: string | null;
  findingIds: readonly string[];
  directive: string;
  createdAt: number;
  outcome: OperationOutcome;
}>;

export type ExecutionObservation =
  | Readonly<{
      kind: "running";
      sessionId: string;
      contextPressure: boolean;
      contextTokens: number | null;
      contextLimitTokens: number | null;
      repeatedToolFailures: readonly string[];
      lastProgressAt: number | null;
      safeBoundary: boolean;
      observedAt: number;
      expiresAt: number;
      source: string;
    }>
  | Readonly<{
      kind: "idle";
      sessionId: string;
      observedAt: number;
      expiresAt: number;
      source: string;
    }>
  | Readonly<{
      kind: "unavailable" | "unknown";
      reason: string;
      observedAt: number;
      expiresAt: number;
      source: string;
    }>;

export type CheckObservation = Readonly<{
  runId: string;
  revision: string;
  state: "missing" | "pending" | "failing" | "passing" | "unknown";
  failureIds: readonly string[];
  observedAt: number;
  expiresAt: number;
  source: string;
}>;

export type IntegrationObservation =
  | Readonly<{ kind: "none" }>
  | Readonly<{
      kind: "pr_open" | "queued" | "merged";
      revision: string;
      providerIdentity: string;
      repository: string;
      target: string;
      observedAt: number;
      expiresAt: number;
      source: string;
    }>;

export type WorkerClaim = Readonly<{
  id: string;
  obligationId: string;
  claim: string;
  observedAt: number;
  expiresAt: number;
  sourceIdentity: string;
}>;

export type IndependentReview = Readonly<{
  id: string;
  obligationId: string;
  candidateRevision: string;
  specificationGeneration: number;
  result: "accepted" | "challenged";
  checkRunId: string | null;
  claim: string;
  observedAt: number;
  expiresAt: number;
  sourceIdentity: string;
}>;

export type Observation = Readonly<{
  candidateRevision: string | null;
  candidateObservedAt: number;
  candidateExpiresAt: number;
  candidateSource: string;
  execution: ExecutionObservation;
  checks: CheckObservation | null;
  integration: IntegrationObservation;
  workerClaims: readonly WorkerClaim[];
  independentReviews: readonly IndependentReview[];
}>;

export type Policy = Readonly<{
  maxObservationAgeMs: number;
  repeatedToolFailureThreshold: number;
  activeTurnStuckAfterMs: number;
  runtimeProvisioning: boolean;
}>;

export type WakeCondition =
  | Readonly<{ kind: "execution"; sessionId: string }>
  | Readonly<{ kind: "check_run"; runId: string }>
  | Readonly<{ kind: "merge_queue"; pullRequest: string }>
  | Readonly<{ kind: "operation"; operationId: string }>
  | Readonly<{ kind: "provider_refresh"; provider: string }>;

export type Decision =
  | Readonly<{ kind: "provision_sandbox"; attemptId: string }>
  | Readonly<{ kind: "create_session"; attemptId: string; sandboxId: string }>
  | Readonly<{ kind: "wait"; reason: string; wake: WakeCondition }>
  | Readonly<{ kind: "continue"; attemptId: string; directive: string }>
  | Readonly<{
      kind: "repair";
      attemptId: string;
      candidateRevision: string;
      findingIds: readonly string[];
      directive: string;
    }>
  | Readonly<{ kind: "refresh_context"; attemptId: string; directive: string }>
  | Readonly<{
      kind: "interrupt";
      attemptId: string;
      sessionId: string;
      candidateRevision: string | null;
      findingIds: readonly string[];
      directive: string;
    }>
  | Readonly<{
      kind: "change_strategy";
      attemptId: string;
      nextStrategy: string;
      directive: string;
    }>
  | Readonly<{ kind: "verify"; candidateRevision: string }>
  | Readonly<{ kind: "integrate"; candidateRevision: string }>
  | Readonly<{ kind: "retry_operation"; operationId: string }>
  | Readonly<{ kind: "hold"; reason: "operator_hold" | "budget_exhausted" }>
  | Readonly<{ kind: "escalate"; reason: string }>
  | Readonly<{
      kind: "conclude";
      deliveredRevision: string;
      repository: string;
      integrationTarget: string;
      providerIdentity: string;
      checkRunId: string;
    }>;

export type ReconcileInput = Readonly<{
  kind: "reconcile";
  lease: LeaseGrant;
  observation: Observation;
  operations: readonly Operation[];
  policy: Policy;
  now: number;
}>;

export type AuthorizedInput =
  | ReconcileInput
  | Readonly<{
      kind: "takeover";
      lease: LeaseGrant;
      now: number;
    }>
  | Readonly<{
      kind: "admit";
      actor: Readonly<{ kind: "approver"; identity: string }>;
      lease: LeaseGrant;
      attemptId: string;
      assignmentId: string;
      now: number;
    }>
  | Readonly<{
      kind: "hold";
      lease: LeaseGrant;
      reason: string;
      now: number;
    }>
  | Readonly<{
      kind: "resume";
      lease: LeaseGrant;
      now: number;
    }>
  | Readonly<{
      kind: "amend_specification";
      actor: Readonly<{ kind: "approver"; identity: string }>;
      expectedGeneration: number;
      objective: string;
      integrationTarget: string;
      obligations: readonly Obligation[];
      independentReviewRequired: boolean;
      now: number;
    }>
  | Readonly<{
      kind: "record_usage";
      lease: LeaseGrant;
      costMicros: number;
      now: number;
    }>;

const transitionBrand: unique symbol = Symbol("authorized-domain-transition");
const proposalBrand: unique symbol = Symbol("approved-commission-proposal");

export type Transition = Readonly<{
  readonly [transitionBrand]: true;
  beforeVersion: number;
  commission: Commission;
  newOperations: readonly Operation[];
  updatedOperations: readonly Operation[];
  decision: Decision | null;
}>;

export type DomainError =
  | "invalid_proposal"
  | "not_admitted"
  | "already_admitted"
  | "owner_mismatch"
  | "lease_expired"
  | "stale_generation"
  | "invalid_lifecycle"
  | "budget_exhausted"
  | "invalid_observation"
  | "invalid_operation_transition"
  | "unresolved_operation"
  | "invalid_usage"
  | "invalid_amendment";

export type Result<T, E> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: E }>;

export type Proposal = Readonly<{
  readonly [proposalBrand]: true;
  commission: Commission;
}>;

export type CommissionProposalInput = Readonly<{
  id: string;
  campaignId: string;
  objective: string;
  repository: string;
  integrationTarget: string;
  obligations: readonly Obligation[];
  independentReviewRequired: boolean;
  budget: Budget["limits"];
}>;

function ok<T>(value: T): Result<T, DomainError> {
  return { ok: true, value };
}

function err<T = never>(error: DomainError): Result<T, DomainError> {
  return { ok: false, error };
}

function transition(
  beforeVersion: number,
  commission: Commission,
  newOperations: readonly Operation[] = [],
  updatedOperations: readonly Operation[] = [],
  decision: Decision | null = null,
): Transition {
  return {
    [transitionBrand]: true,
    beforeVersion,
    commission,
    newOperations,
    updatedOperations,
    decision,
  };
}

export function isDomainTransition(value: unknown): value is Transition {
  return (
    typeof value === "object" &&
    value !== null &&
    transitionBrand in value &&
    value[transitionBrand] === true
  );
}

export function isCommissionProposal(value: unknown): value is Proposal {
  return (
    typeof value === "object" &&
    value !== null &&
    proposalBrand in value &&
    value[proposalBrand] === true
  );
}

export function proposeCommission(
  input: CommissionProposalInput,
): Result<Proposal, DomainError> {
  if (
    !input.id ||
    !input.campaignId ||
    !input.objective.trim() ||
    !input.repository.trim() ||
    !input.integrationTarget.trim() ||
    input.obligations.length === 0 ||
    new Set(input.obligations.map(({ id }) => id)).size !==
      input.obligations.length ||
    input.budget.maxAttempts < 1 ||
    input.budget.maxInstructions < 1 ||
    input.budget.maxRepairs < 0 ||
    input.budget.maxCostMicros < 0
  )
    return err("invalid_proposal");

  return ok({
    [proposalBrand]: true,
    commission: {
      id: input.id,
      campaignId: input.campaignId,
      objective: input.objective,
      repository: input.repository,
      integrationTarget: input.integrationTarget,
      specificationGeneration: 1,
      obligations: [...input.obligations],
      independentReviewRequired: input.independentReviewRequired,
      lifecycle: "proposed",
      holdReason: null,
      owner: null,
      version: 0,
      attempts: [],
      activeAttemptId: null,
      budget: {
        limits: input.budget,
        used: { attempts: 0, instructions: 0, repairs: 0, costMicros: 0 },
      },
      candidateRevision: null,
      candidateObservedAt: null,
      candidateExpiresAt: null,
      candidateSource: null,
      deliveryEvidence: null,
      registeredPullRequestId: null,
      evidence: [],
    },
  });
}

export function decide(
  commission: Commission,
  observation: Observation,
  operations: readonly Operation[],
  policy: Policy,
  now: number,
): Decision {
  if (commission.lifecycle === "held")
    return { kind: "hold", reason: "operator_hold" };
  if (
    commission.lifecycle === "concluded" &&
    commission.deliveryEvidence !== null
  ) {
    return {
      kind: "conclude",
      deliveredRevision: commission.deliveryEvidence.revision,
      repository: commission.deliveryEvidence.repository,
      integrationTarget: commission.deliveryEvidence.integrationTarget,
      providerIdentity: commission.deliveryEvidence.providerIdentity,
      checkRunId: commission.deliveryEvidence.checkRunId,
    };
  }

  const candidate = observation.candidateRevision;
  const integration = observation.integration;
  const mergeObservedForCandidate =
    candidate !== null &&
    integration.kind === "merged" &&
    integration.revision === candidate &&
    matchesRegisteredDelivery(commission, integration) &&
    isCurrent(integration.observedAt, integration.expiresAt, policy, now);
  const pendingOperation = operations.find(
    (operation) =>
      isUnresolved(operation) &&
      !(
        mergeObservedForCandidate &&
        operation.kind === "integrate" &&
        operation.candidateRevision === candidate
      ),
  );
  if (
    candidate !== null &&
    mergeObservedForCandidate &&
    pendingOperation === undefined &&
    isCurrent(
      observation.candidateObservedAt,
      observation.candidateExpiresAt,
      policy,
      now,
    ) &&
    isCurrent(integration.observedAt, integration.expiresAt, policy, now) &&
    obligationsSatisfied(commission, candidate, now, observation.checks) &&
    currentChecks(observation.checks, candidate, policy, now)?.state ===
      "passing"
  ) {
    const checks = currentChecks(observation.checks, candidate, policy, now);
    if (checks !== null && integration.kind === "merged") {
      return {
        kind: "conclude",
        deliveredRevision: candidate,
        repository: integration.repository,
        integrationTarget: integration.target,
        providerIdentity: integration.providerIdentity,
        checkRunId: checks.runId,
      };
    }
  }

  if (pendingOperation !== undefined) {
    return {
      kind: "wait",
      reason: "operation outcome requires observation",
      wake: { kind: "operation", operationId: pendingOperation.id },
    };
  }
  if (budgetExhausted(commission, now))
    return { kind: "hold", reason: "budget_exhausted" };
  const unapplied = operations.find(
    (operation) =>
      operation.outcome.kind === "observed" &&
      operation.outcome.result === "not_applied",
  );
  if (unapplied !== undefined) {
    if (
      unapplied.outcome.kind === "observed" &&
      unapplied.outcome.retrySafe &&
      unapplied.retryCount < 1
    ) {
      return { kind: "retry_operation", operationId: unapplied.id };
    }
    return {
      kind: "escalate",
      reason: `Operation ${unapplied.id} is not safe to retry`,
    };
  }

  if (commission.lifecycle === "proposed")
    return { kind: "escalate", reason: "Commission has not been admitted" };
  if (
    commission.lifecycle !== "active" &&
    commission.lifecycle !== "admitted"
  ) {
    return { kind: "hold", reason: "operator_hold" };
  }
  if (
    integration.kind !== "none" &&
    !matchesRegisteredDelivery(commission, integration)
  ) {
    return {
      kind: "escalate",
      reason:
        "Observed pull request does not match the registered repository, integration target, and pull request identity",
    };
  }
  if (
    !isCurrent(
      observation.execution.observedAt,
      observation.execution.expiresAt,
      policy,
      now,
    )
  ) {
    return {
      kind: "wait",
      reason: "execution observation is stale",
      wake: { kind: "provider_refresh", provider: "execution" },
    };
  }
  if (
    observation.candidateRevision !== null &&
    !isCurrent(
      observation.candidateObservedAt,
      observation.candidateExpiresAt,
      policy,
      now,
    )
  ) {
    return {
      kind: "wait",
      reason: "Candidate observation is stale",
      wake: { kind: "provider_refresh", provider: "git" },
    };
  }
  if (
    observation.integration.kind !== "none" &&
    !isCurrent(
      observation.integration.observedAt,
      observation.integration.expiresAt,
      policy,
      now,
    )
  ) {
    return {
      kind: "wait",
      reason: "delivery observation is stale",
      wake: { kind: "provider_refresh", provider: "delivery" },
    };
  }

  const attempt = activeAttempt(commission);
  if (attempt === null)
    return { kind: "escalate", reason: "No active Attempt is assigned" };
  if (policy.runtimeProvisioning) {
    const provisionedSandbox = operations.find(
      (operation) =>
        operation.commissionId === commission.id &&
        operation.kind === "provision_sandbox" &&
        operation.specificationGeneration ===
          commission.specificationGeneration &&
        operation.outcome.kind === "observed" &&
        operation.outcome.result === "applied" &&
        operation.outcome.externalIdentity !== null,
    );
    if (provisionedSandbox === undefined)
      return { kind: "provision_sandbox", attemptId: attempt.id };
    if (
      provisionedSandbox.outcome.kind !== "observed" ||
      provisionedSandbox.outcome.externalIdentity === null
    )
      return {
        kind: "escalate",
        reason: "Sandbox Operation has no external identity",
      };
    const sandboxId = provisionedSandbox.outcome.externalIdentity;
    const session = operations.find(
      (operation) =>
        operation.commissionId === commission.id &&
        operation.kind === "create_session" &&
        operation.specificationGeneration ===
          commission.specificationGeneration &&
        operation.target === `opencode:${sandboxId}` &&
        operation.outcome.kind === "observed" &&
        operation.outcome.result === "applied" &&
        operation.outcome.externalIdentity !== null,
    );
    if (session === undefined && observation.execution.kind !== "idle")
      return {
        kind: "wait",
        reason: "Sandbox is not ready for OpenCode Session creation",
        wake: { kind: "provider_refresh", provider: "sandbox" },
      };
    if (session === undefined)
      return {
        kind: "create_session",
        attemptId: attempt.id,
        sandboxId,
      };
  }
  const priorInterrupt = operations
    .filter(
      (operation) =>
        operation.kind === "interrupt" &&
        operation.attemptId === attempt.id &&
        operation.specificationGeneration ===
          commission.specificationGeneration &&
        operation.candidateRevision === candidate &&
        operation.outcome.kind === "observed" &&
        operation.outcome.result === "applied",
    )
    .sort((left, right) => right.createdAt - left.createdAt)[0];
  if (priorInterrupt !== undefined) {
    const hasFollowup = operations.some(
      (operation) =>
        operation.attemptId === attempt.id &&
        operation.instructionSequence > priorInterrupt.instructionSequence &&
        operation.specificationGeneration ===
          commission.specificationGeneration &&
        operation.candidateRevision === candidate &&
        (operation.kind === "refresh_context" ||
          operation.kind === "repair" ||
          operation.kind === "change_strategy"),
    );
    if (
      observation.execution.kind === "unknown" ||
      observation.execution.kind === "unavailable" ||
      (observation.execution.kind === "running" && !hasFollowup)
    ) {
      return {
        kind: "wait",
        reason:
          "watchdog interrupt recorded; awaiting a fresh execution boundary",
        wake: { kind: "provider_refresh", provider: "execution" },
      };
    }
    if (!hasFollowup) {
      if (priorInterrupt.directive.includes("context-pressure"))
        return {
          kind: "refresh_context",
          attemptId: attempt.id,
          directive: contextPacket(
            commission,
            candidate,
            operations,
            now,
            observation.checks,
          ),
        };
      if (priorInterrupt.directive.includes("repeated-tool-failures")) {
        const findingIds = priorInterrupt.findingIds;
        const revision = candidate ?? commission.candidateRevision;
        if (
          revision !== null &&
          commission.budget.used.repairs < commission.budget.limits.maxRepairs
        )
          return {
            kind: "repair",
            attemptId: attempt.id,
            candidateRevision: revision,
            findingIds,
            directive: `Repair repeated OpenCode tool failures on ${revision}: ${findingIds.join("; ")}`,
          };
        return strategyOrHold(
          commission,
          attempt,
          "recover-repeated-tool-failures",
          `Select a bounded strategy after repeated OpenCode tool failures: ${findingIds.join("; ")}`,
        );
      }
      return strategyOrHold(
        commission,
        attempt,
        "recover-stuck-active-turn",
        "Choose a bounded strategy after the watchdog interrupted an active stall",
      );
    }
  }
  const refusedOperation = operations.find(
    (operation) =>
      operation.attemptId === attempt.id &&
      operation.specificationGeneration ===
        commission.specificationGeneration &&
      (operation.candidateRevision === candidate ||
        operation.candidateRevision === null) &&
      (operation.outcome.kind === "rejected" ||
        (operation.outcome.kind === "observed" &&
          operation.outcome.result === "rejected")),
  );
  if (refusedOperation !== undefined) {
    if (refusedOperation.kind === "change_strategy") {
      return {
        kind: "escalate",
        reason: `Strategy change Operation ${refusedOperation.id} was rejected`,
      };
    }
    return strategyOrHold(
      commission,
      attempt,
      "recover-rejected-operation",
      `Choose a bounded alternative after ${refusedOperation.kind} Operation ${refusedOperation.id} was rejected`,
    );
  }
  if (observation.execution.kind === "running") {
    const execution = observation.execution;
    const stuckForMs =
      execution.lastProgressAt === null
        ? 0
        : Math.max(0, now - execution.lastProgressAt);
    const repeatedToolFailures =
      execution.repeatedToolFailures.length >=
        policy.repeatedToolFailureThreshold &&
      execution.repeatedToolFailures.length > 0;
    const watchdogFinding =
      execution.contextPressure ||
      repeatedToolFailures ||
      stuckForMs >= policy.activeTurnStuckAfterMs;
    if (watchdogFinding) {
      if (!execution.safeBoundary) {
        return {
          kind: "wait",
          reason:
            "watchdog finding observed while provider reports no safe execution boundary",
          wake: {
            kind: "execution",
            sessionId: execution.sessionId,
          },
        };
      }
      const priorWatchdogAction = operations.find(
        (operation) =>
          operation.attemptId === attempt.id &&
          operation.specificationGeneration ===
            commission.specificationGeneration &&
          operation.candidateRevision === candidate &&
          (operation.kind === "refresh_context" ||
            operation.kind === "repair") &&
          operation.outcome.kind === "observed" &&
          operation.outcome.result === "applied" &&
          (execution.lastProgressAt === null ||
            execution.lastProgressAt <= operation.outcome.observedAt) &&
          (!repeatedToolFailures ||
            operation.kind !== "repair" ||
            sameStrings(operation.findingIds, execution.repeatedToolFailures)),
      );
      if (priorWatchdogAction !== undefined) {
        return {
          kind: "wait",
          reason: "watchdog action is awaiting new OpenCode progress",
          wake: { kind: "execution", sessionId: execution.sessionId },
        };
      }
      const cause = execution.contextPressure
        ? "context-pressure"
        : repeatedToolFailures
          ? "repeated-tool-failures"
          : "stuck-active-turn";
      return {
        kind: "interrupt",
        attemptId: attempt.id,
        sessionId: execution.sessionId,
        candidateRevision: candidate,
        findingIds: [
          ...(repeatedToolFailures ? [...execution.repeatedToolFailures] : []),
        ],
        directive: `Watchdog interrupt cause: ${cause}`,
      };
    }
    return {
      kind: "wait",
      reason: "OpenCode execution is active",
      wake: { kind: "execution", sessionId: execution.sessionId },
    };
  }
  if (
    observation.execution.kind === "unavailable" ||
    observation.execution.kind === "unknown"
  ) {
    return {
      kind: "wait",
      reason: observation.execution.reason,
      wake: { kind: "provider_refresh", provider: "execution" },
    };
  }

  if (candidate === null) {
    const priorContinue = operations.find(
      (operation) =>
        operation.kind === "continue" &&
        operation.attemptId === attempt.id &&
        operation.candidateRevision === null &&
        operation.outcome.kind === "observed" &&
        operation.outcome.result === "applied",
    );
    if (priorContinue !== undefined) {
      return {
        kind: "wait",
        reason: "instruction completed without a new Candidate",
        wake: {
          kind: "execution",
          sessionId:
            observation.execution.kind === "idle"
              ? observation.execution.sessionId
              : "unknown",
        },
      };
    }
    return {
      kind: "continue",
      attemptId: attempt.id,
      directive: contextPacket(
        commission,
        null,
        operations,
        now,
        observation.checks,
      ),
    };
  }
  const accepted = obligationsSatisfied(
    commission,
    candidate,
    now,
    observation.checks,
  );
  if (!accepted) {
    if (hasCurrentWorkerEvidence(commission, candidate, now)) {
      const priorVerify = operations.find(
        (operation) =>
          operation.kind === "verify" &&
          operation.candidateRevision === candidate &&
          operation.specificationGeneration ===
            commission.specificationGeneration &&
          operation.outcome.kind === "observed" &&
          operation.outcome.result === "applied",
      );
      if (priorVerify !== undefined) {
        return {
          kind: "wait",
          reason: "independent evidence has not arrived",
          wake: { kind: "provider_refresh", provider: "review" },
        };
      }
      return { kind: "verify", candidateRevision: candidate };
    }
    const previousInstruction = operations.find(
      (operation) =>
        operation.kind === "continue" &&
        operation.attemptId === attempt.id &&
        operation.specificationGeneration ===
          commission.specificationGeneration &&
        operation.candidateRevision === candidate &&
        operation.outcome.kind === "observed" &&
        operation.outcome.result === "applied",
    );
    if (previousInstruction !== undefined) {
      return {
        kind: "wait",
        reason:
          "the same continuation was already applied without new evidence",
        wake: {
          kind: "execution",
          sessionId:
            observation.execution.kind === "idle"
              ? observation.execution.sessionId
              : "unknown",
        },
      };
    }
    return {
      kind: "continue",
      attemptId: attempt.id,
      directive: contextPacket(
        commission,
        candidate,
        operations,
        now,
        observation.checks,
      ),
    };
  }

  const checks = currentChecks(observation.checks, candidate, policy, now);
  if (checks === null) {
    const priorVerify = operations.find(
      (operation) =>
        operation.kind === "verify" &&
        operation.candidateRevision === candidate &&
        operation.specificationGeneration ===
          commission.specificationGeneration &&
        operation.outcome.kind === "observed" &&
        operation.outcome.result === "applied",
    );
    if (priorVerify !== undefined) {
      return {
        kind: "wait",
        reason:
          "verification operation completed; awaiting current check evidence",
        wake: { kind: "provider_refresh", provider: "checks" },
      };
    }
    return { kind: "verify", candidateRevision: candidate };
  }
  if (checks.state === "pending") {
    return {
      kind: "wait",
      reason: "required CI check is pending",
      wake: { kind: "check_run", runId: checks.runId },
    };
  }
  if (checks.state === "missing") {
    return {
      kind: "wait",
      reason:
        "required status checks have not been reported for this Candidate",
      wake: { kind: "check_run", runId: checks.runId },
    };
  }
  if (checks.state === "unknown") {
    const priorVerify = operations.find(
      (operation) =>
        operation.kind === "verify" &&
        operation.candidateRevision === candidate &&
        operation.specificationGeneration ===
          commission.specificationGeneration &&
        operation.outcome.kind === "observed" &&
        operation.outcome.result === "applied" &&
        operation.outcome.externalIdentity === checks.runId,
    );
    return priorVerify === undefined
      ? { kind: "verify", candidateRevision: candidate }
      : {
          kind: "wait",
          reason: "the same check evidence remains unknown after verification",
          wake: { kind: "provider_refresh", provider: "checks" },
        };
  }
  if (checks.state === "failing") {
    const previousRepair = operations.find(
      (operation) =>
        operation.kind === "repair" &&
        operation.candidateRevision === candidate &&
        operation.outcome.kind === "observed" &&
        operation.outcome.result === "applied" &&
        sameStrings(operation.findingIds, checks.failureIds),
    );
    if (previousRepair !== undefined) {
      return strategyOrHold(
        commission,
        attempt,
        "alternate-repair",
        `The same check failures remain after repair of ${checks.runId}`,
      );
    }
    if (commission.budget.used.repairs < commission.budget.limits.maxRepairs) {
      if (checks.failureIds.length === 0) {
        return strategyOrHold(
          commission,
          attempt,
          "diagnose-checks",
          `Check ${checks.runId} failed without actionable diagnostics`,
        );
      }
      return {
        kind: "repair",
        attemptId: attempt.id,
        candidateRevision: candidate,
        findingIds: checks.failureIds,
        directive: `Repair required check run ${checks.runId} for Candidate ${candidate}: ${checks.failureIds.join(", ")}`,
      };
    }
    return strategyOrHold(
      commission,
      attempt,
      "alternate-repair",
      `Change strategy after exhausted repairs for ${checks.runId}`,
    );
  }

  if (observation.integration.kind === "queued") {
    return {
      kind: "wait",
      reason: "pull request is in the merge queue",
      wake: {
        kind: "merge_queue",
        pullRequest: observation.integration.providerIdentity,
      },
    };
  }
  const acceptedIntegrate = operations.find(
    (operation) =>
      operation.kind === "integrate" &&
      operation.candidateRevision === candidate &&
      operation.outcome.kind === "observed" &&
      operation.outcome.result === "accepted",
  );
  if (
    acceptedIntegrate !== undefined &&
    observation.integration.kind !== "merged"
  ) {
    return {
      kind: "wait",
      reason:
        "integration request accepted; awaiting authoritative delivery state",
      wake: {
        kind: "merge_queue",
        pullRequest:
          observation.integration.kind === "pr_open"
            ? observation.integration.providerIdentity
            : `${commission.repository}#${candidate}`,
      },
    };
  }
  if (observation.integration.kind === "merged") {
    return strategyOrHold(
      commission,
      attempt,
      "reconcile-delivery",
      `Delivered ${observation.integration.revision}; current Candidate is ${candidate}`,
    );
  }
  if (observation.integration.kind === "pr_open") {
    const previousIntegrate = operations.find(
      (operation) =>
        operation.kind === "integrate" &&
        operation.candidateRevision === candidate &&
        operation.outcome.kind === "observed" &&
        operation.outcome.result === "accepted",
    );
    if (previousIntegrate !== undefined) {
      return {
        kind: "wait",
        reason: "integration request accepted; awaiting queue observation",
        wake: {
          kind: "merge_queue",
          pullRequest: observation.integration.providerIdentity,
        },
      };
    }
    return { kind: "integrate", candidateRevision: candidate };
  }
  return { kind: "integrate", candidateRevision: candidate };
}

export function evolve(
  current: Commission,
  input: AuthorizedInput,
): Result<Transition, DomainError> {
  switch (input.kind) {
    case "admit": {
      if (current.lifecycle !== "proposed") return err("already_admitted");
      if (!validLease(input.lease, input.now)) return err("lease_expired");
      const attempt: Attempt = {
        id: input.attemptId,
        assignmentId: input.assignmentId,
        ordinal: 1,
        strategy: "implementation",
        lifecycle: "active",
        nextInstructionSequence: 1,
      };
      return ok(
        transition(current.version, {
          ...current,
          version: current.version + 1,
          lifecycle: "active",
          owner: input.lease.owner,
          attempts: [attempt],
          activeAttemptId: attempt.id,
          budget: {
            ...current.budget,
            used: { ...current.budget.used, attempts: 1 },
          },
        }),
      );
    }
    case "takeover": {
      if (!validLease(input.lease, input.now)) return err("lease_expired");
      if (
        current.owner?.controllerId === input.lease.owner.controllerId &&
        current.owner.epoch === input.lease.owner.epoch
      )
        return ok(transition(current.version, current));
      if (
        current.owner !== null &&
        (input.lease.owner.epoch < current.owner.epoch ||
          (input.lease.owner.controllerId !== current.owner.controllerId &&
            input.lease.owner.epoch <= current.owner.epoch))
      )
        return err("owner_mismatch");
      return ok(
        transition(current.version, {
          ...current,
          version: current.version + 1,
          owner: input.lease.owner,
        }),
      );
    }
    case "reconcile": {
      if (!authorizedOwner(current, input.lease, input.now))
        return err("owner_mismatch");
      if (!observationValidFor(current, input.observation))
        return err("invalid_observation");
      const observed = recordObservation(current, input.observation);
      if (observed === null) return err("invalid_observation");
      const decision = decide(
        observed,
        input.observation,
        input.operations,
        input.policy,
        input.now,
      );
      return authorizeDecision(
        observed,
        current.version,
        input,
        decision,
        observed !== current,
      );
    }
    case "hold": {
      if (!authorizedOwner(current, input.lease, input.now))
        return err("owner_mismatch");
      if (current.lifecycle === "held") {
        return current.holdReason === input.reason
          ? ok(transition(current.version, current))
          : err("invalid_lifecycle");
      }
      if (current.lifecycle === "concluded") return err("invalid_lifecycle");
      return ok(
        transition(current.version, {
          ...current,
          version: current.version + 1,
          lifecycle: "held",
          holdReason: input.reason,
        }),
      );
    }
    case "resume": {
      if (!authorizedOwner(current, input.lease, input.now))
        return err("owner_mismatch");
      if (current.lifecycle === "active")
        return ok(transition(current.version, current));
      if (current.lifecycle !== "held") return err("invalid_lifecycle");
      return ok(
        transition(current.version, {
          ...current,
          version: current.version + 1,
          lifecycle: "active",
          holdReason: null,
        }),
      );
    }
    case "amend_specification": {
      if (input.actor.kind !== "approver") return err("invalid_amendment");
      if (current.lifecycle === "concluded") return err("invalid_lifecycle");
      if (input.expectedGeneration !== current.specificationGeneration)
        return err("stale_generation");
      if (
        !input.objective.trim() ||
        !input.integrationTarget.trim() ||
        input.obligations.length === 0 ||
        new Set(input.obligations.map(({ id }) => id)).size !==
          input.obligations.length
      )
        return err("invalid_amendment");
      const unchanged =
        input.objective === current.objective &&
        input.integrationTarget === current.integrationTarget &&
        input.independentReviewRequired === current.independentReviewRequired &&
        sameObligations(input.obligations, current.obligations);
      if (unchanged) return ok(transition(current.version, current));
      return ok(
        transition(current.version, {
          ...current,
          version: current.version + 1,
          specificationGeneration: current.specificationGeneration + 1,
          objective: input.objective,
          integrationTarget: input.integrationTarget,
          obligations: [...input.obligations],
          independentReviewRequired: input.independentReviewRequired,
        }),
      );
    }
    case "record_usage": {
      if (!authorizedOwner(current, input.lease, input.now))
        return err("owner_mismatch");
      if (!Number.isSafeInteger(input.costMicros) || input.costMicros < 0)
        return err("invalid_usage");
      if (input.costMicros === 0)
        return ok(transition(current.version, current));
      return ok(
        transition(current.version, {
          ...current,
          version: current.version + 1,
          budget: {
            ...current.budget,
            used: {
              ...current.budget.used,
              costMicros: current.budget.used.costMicros + input.costMicros,
            },
          },
        }),
      );
    }
    default:
      return exhaustive(input);
  }
}

function authorizeDecision(
  current: Commission,
  beforeVersion: number,
  input: ReconcileInput,
  decision: Decision,
  observedStateChanged: boolean,
): Result<Transition, DomainError> {
  if (decision.kind === "conclude") {
    const integration = input.observation.integration;
    const checks = input.observation.checks;
    if (
      integration.kind !== "merged" ||
      checks === null ||
      integration.revision !== decision.deliveredRevision ||
      integration.repository !== decision.repository ||
      integration.repository !== current.repository ||
      integration.target !== decision.integrationTarget ||
      integration.target !== current.integrationTarget ||
      current.registeredPullRequestId !== integration.providerIdentity ||
      integration.providerIdentity !== decision.providerIdentity ||
      checks.runId !== decision.checkRunId ||
      checks.revision !== decision.deliveredRevision ||
      checks.state !== "passing"
    )
      return err("invalid_observation");
    const integrationOperation = input.operations.find(
      (operation) =>
        operation.kind === "integrate" &&
        operation.candidateRevision === decision.deliveredRevision &&
        isUnresolved(operation),
    );
    const updatedOperations =
      integrationOperation === undefined
        ? []
        : [
            {
              ...integrationOperation,
              outcome: {
                kind: "observed" as const,
                observedAt: integration.observedAt,
                source: integration.source,
                result: "accepted" as const,
                retrySafe: false,
                externalIdentity: integration.providerIdentity,
              },
            },
          ];
    return ok(
      transition(
        beforeVersion,
        {
          ...current,
          version: beforeVersion + 1,
          lifecycle: "concluded",
          deliveryEvidence: {
            revision: decision.deliveredRevision,
            repository: decision.repository,
            integrationTarget: decision.integrationTarget,
            providerIdentity: decision.providerIdentity,
            source: integration.source,
            observedAt: integration.observedAt,
            expiresAt: integration.expiresAt,
            checkRunId: checks.runId,
            specificationGeneration: current.specificationGeneration,
          },
          activeAttemptId: null,
          attempts: current.attempts.map((attempt) =>
            attempt.id === current.activeAttemptId
              ? { ...attempt, lifecycle: "completed" }
              : attempt,
          ),
        },
        [],
        updatedOperations,
        decision,
      ),
    );
  }
  if (decision.kind === "retry_operation") {
    const previous = input.operations.find(
      ({ id }) => id === decision.operationId,
    );
    if (
      previous === undefined ||
      previous.outcome.kind !== "observed" ||
      previous.outcome.result !== "not_applied" ||
      !previous.outcome.retrySafe ||
      previous.retryCount >= 1
    )
      return err("invalid_operation_transition");
    const retry: Operation = {
      ...previous,
      retryCount: previous.retryCount + 1,
      outcome: {
        kind: "retry_authorized",
        authorizedAt: input.now,
        observation: {
          observedAt: previous.outcome.observedAt,
          source: previous.outcome.source,
          result: "not_applied",
          retrySafe: true,
        },
      },
    };
    return ok(
      transition(
        beforeVersion,
        { ...current, version: beforeVersion + 1 },
        [],
        [retry],
        decision,
      ),
    );
  }
  if (
    decision.kind === "wait" ||
    decision.kind === "hold" ||
    decision.kind === "escalate"
  ) {
    return ok(
      transition(
        beforeVersion,
        observedStateChanged
          ? { ...current, version: beforeVersion + 1 }
          : current,
        [],
        [],
        decision,
      ),
    );
  }

  const attempt = activeAttempt(current);
  if (attempt === null) return err("not_admitted");
  if (
    (decision.kind === "continue" ||
      decision.kind === "repair" ||
      decision.kind === "refresh_context" ||
      decision.kind === "change_strategy") &&
    current.budget.used.instructions >= current.budget.limits.maxInstructions
  )
    return err("budget_exhausted");
  if (
    decision.kind === "repair" &&
    current.budget.used.repairs >= current.budget.limits.maxRepairs
  )
    return err("budget_exhausted");
  if (
    decision.kind === "change_strategy" &&
    current.budget.used.attempts >= current.budget.limits.maxAttempts
  )
    return err("budget_exhausted");

  const operation = operationFor(
    current,
    input.lease.owner,
    attempt,
    decision,
    input.now,
  );
  let commission: Commission = { ...current, version: beforeVersion + 1 };
  if (
    decision.kind === "continue" ||
    decision.kind === "repair" ||
    decision.kind === "refresh_context"
  ) {
    commission = {
      ...commission,
      budget: {
        ...commission.budget,
        used: {
          ...commission.budget.used,
          instructions: commission.budget.used.instructions + 1,
        },
      },
      attempts: current.attempts.map((item) =>
        item.id === attempt.id
          ? {
              ...item,
              nextInstructionSequence: item.nextInstructionSequence + 1,
            }
          : item,
      ),
    };
    if (decision.kind === "repair") {
      commission = {
        ...commission,
        budget: {
          ...commission.budget,
          used: {
            ...commission.budget.used,
            repairs: commission.budget.used.repairs + 1,
          },
        },
      };
    }
  } else if (decision.kind === "change_strategy") {
    const replacement: Attempt = {
      id: `${attempt.assignmentId}:attempt-${attempt.ordinal + 1}`,
      assignmentId: attempt.assignmentId,
      ordinal: attempt.ordinal + 1,
      strategy: decision.nextStrategy,
      lifecycle: "active",
      nextInstructionSequence: 1,
    };
    commission = {
      ...commission,
      attempts: [
        ...current.attempts.map((item) =>
          item.id === attempt.id
            ? { ...item, lifecycle: "superseded" as const }
            : item,
        ),
        replacement,
      ],
      activeAttemptId: replacement.id,
      budget: {
        ...commission.budget,
        used: {
          ...commission.budget.used,
          attempts: commission.budget.used.attempts + 1,
          instructions: commission.budget.used.instructions + 1,
        },
      },
    };
  } else if (decision.kind === "interrupt") {
    commission = {
      ...commission,
      attempts: current.attempts.map((item) =>
        item.id === attempt.id
          ? {
              ...item,
              nextInstructionSequence: item.nextInstructionSequence + 1,
            }
          : item,
      ),
    };
  }
  return ok(transition(beforeVersion, commission, [operation], [], decision));
}

export function evolveOperation(
  current: Commission,
  operation: Operation,
  lease: LeaseGrant,
  outcome: OperationOutcome,
  now: number,
): Result<Transition, DomainError> {
  if (!authorizedOwner(current, lease, now)) return err("owner_mismatch");
  if (operation.commissionId !== current.id || current.owner === null)
    return err("owner_mismatch");
  if (
    operation.ownerEpoch > current.owner.epoch ||
    (operation.ownerEpoch === current.owner.epoch &&
      operation.controllerId !== current.owner.controllerId)
  )
    return err("owner_mismatch");
  if (JSON.stringify(operation.outcome) === JSON.stringify(outcome)) {
    return ok(transition(current.version, current));
  }
  if (outcome.kind === "submitted") {
    // Prepared intent reserves budget; it does not grant permanent permission
    // to execute after a hold, amendment, Candidate change or deadline. Outcome
    // inspection/recording below remains possible after any of these changes.
    if (operation.kind !== "interrupt" && current.lifecycle !== "active")
      return err("invalid_lifecycle");
    if (operation.specificationGeneration !== current.specificationGeneration)
      return err("stale_generation");
    const active = activeAttempt(current);
    const original = current.attempts.find(
      ({ id }) => id === operation.attemptId,
    );
    const strategyReplacement =
      operation.kind === "change_strategy" &&
      original?.lifecycle === "superseded" &&
      active?.ordinal === original.ordinal + 1;
    if (
      active === null ||
      active.assignmentId !== operation.assignmentId ||
      (operation.attemptId !== active.id && !strategyReplacement)
    )
      return err("invalid_operation_transition");
    if (
      operation.candidateRevision !== null &&
      operation.candidateRevision !== current.candidateRevision
    )
      return err("invalid_operation_transition");
    if (
      operation.kind !== "interrupt" &&
      (now >= current.budget.limits.deadlineAt ||
        current.budget.used.costMicros >= current.budget.limits.maxCostMicros ||
        current.budget.used.instructions >
          current.budget.limits.maxInstructions ||
        current.budget.used.repairs > current.budget.limits.maxRepairs)
    )
      return err("budget_exhausted");
  }
  if (!validOperationOutcome(outcome, now)) return err("invalid_observation");
  if (!allowedOutcome(operation.outcome, outcome))
    return err("invalid_operation_transition");
  if (
    (operation.kind === "provision_sandbox" ||
      operation.kind === "create_session" ||
      operation.kind === "interrupt") &&
    outcome.kind === "observed" &&
    outcome.result === "applied" &&
    (outcome.externalIdentity === null ||
      outcome.externalIdentity.trim() === "")
  ) {
    return err("invalid_observation");
  }
  if (
    operation.kind === "integrate" &&
    outcome.kind === "observed" &&
    outcome.result === "accepted"
  ) {
    if (
      outcome.externalIdentity === null ||
      outcome.externalIdentity.length === 0
    )
      return err("invalid_observation");
    if (
      current.registeredPullRequestId !== null &&
      current.registeredPullRequestId !== outcome.externalIdentity
    )
      return err("invalid_operation_transition");
  }
  const commission =
    operation.kind === "integrate" &&
    outcome.kind === "observed" &&
    outcome.result === "accepted"
      ? {
          ...current,
          version: current.version + 1,
          registeredPullRequestId: outcome.externalIdentity,
        }
      : { ...current, version: current.version + 1 };
  return ok(
    transition(current.version, commission, [], [{ ...operation, outcome }]),
  );
}

export function observeOperation(
  operation: Operation,
  observation: OperationOutcome,
): Result<Operation, DomainError> {
  if (!allowedOutcome(operation.outcome, observation))
    return err("invalid_operation_transition");
  return ok({ ...operation, outcome: observation });
}

function allowedOutcome(
  previous: OperationOutcome,
  next: OperationOutcome,
): boolean {
  if (previous.kind === next.kind) return false;
  if (previous.kind === "prepared")
    return (
      next.kind === "submitted" ||
      next.kind === "ambiguous" ||
      next.kind === "observed" ||
      next.kind === "rejected"
    );
  if (previous.kind === "submitted")
    return (
      next.kind === "ambiguous" ||
      next.kind === "observed" ||
      next.kind === "rejected"
    );
  if (previous.kind === "ambiguous")
    return next.kind === "observed" || next.kind === "rejected";
  if (
    previous.kind === "observed" &&
    previous.result === "not_applied" &&
    previous.retrySafe
  )
    return next.kind === "retry_authorized";
  if (previous.kind === "retry_authorized")
    return (
      next.kind === "submitted" ||
      next.kind === "ambiguous" ||
      next.kind === "observed" ||
      next.kind === "rejected"
    );
  return false;
}

function validOperationOutcome(
  outcome: OperationOutcome,
  now: number,
): boolean {
  switch (outcome.kind) {
    case "prepared":
      return false;
    case "submitted":
      return (
        Number.isSafeInteger(outcome.submittedAt) && outcome.submittedAt <= now
      );
    case "ambiguous":
      return (
        Number.isSafeInteger(outcome.observedAt) && outcome.observedAt <= now
      );
    case "observed":
      return (
        Number.isSafeInteger(outcome.observedAt) &&
        outcome.observedAt <= now &&
        outcome.source.length > 0
      );
    case "retry_authorized":
      return (
        Number.isSafeInteger(outcome.authorizedAt) &&
        outcome.authorizedAt <= now &&
        Number.isSafeInteger(outcome.observation.observedAt) &&
        outcome.observation.observedAt <= outcome.authorizedAt &&
        outcome.observation.source.length > 0 &&
        outcome.observation.retrySafe
      );
    case "rejected":
      return (
        Number.isSafeInteger(outcome.observedAt) && outcome.observedAt <= now
      );
    default:
      return exhaustive(outcome);
  }
}

function operationFor(
  commission: Commission,
  owner: Owner,
  attempt: Attempt,
  decision: Exclude<
    Decision,
    { kind: "wait" | "hold" | "escalate" | "conclude" | "retry_operation" }
  >,
  now: number,
): Operation {
  const kind: OperationKind = decision.kind;
  const candidateRevision =
    "candidateRevision" in decision
      ? decision.candidateRevision
      : commission.candidateRevision;
  const sequence = attempt.nextInstructionSequence;
  const fingerprint = [
    decision.kind,
    commission.specificationGeneration,
    candidateRevision ?? "none",
    decision.kind === "repair" ? decision.findingIds.join(",") : "",
    decision.kind === "interrupt" ? decision.findingIds.join(",") : "",
    decision.kind === "interrupt" ? decision.directive : "",
    decision.kind === "change_strategy" ? decision.nextStrategy : "",
    decision.kind === "create_session" ? decision.sandboxId : "",
  ].join("|");
  const logicalKey = [
    commission.id,
    attempt.assignmentId,
    attempt.id,
    sequence,
    fingerprint,
  ].join(":");
  let directive: string;
  switch (decision.kind) {
    case "provision_sandbox":
      directive = "Provision the approved Agent Sandbox Workspace";
      break;
    case "create_session":
      directive = "Create an OpenCode Session in the provisioned Sandbox";
      break;
    case "continue":
    case "repair":
    case "refresh_context":
    case "interrupt":
    case "change_strategy":
      directive = decision.directive;
      break;
    case "verify":
    case "integrate":
      directive = `${decision.kind} ${decision.candidateRevision}`;
      break;
    default:
      return exhaustive(decision);
  }
  let target: string;
  switch (decision.kind) {
    case "provision_sandbox":
      target = `sandbox:${commission.id}`;
      break;
    case "create_session":
      target = `opencode:${decision.sandboxId}`;
      break;
    case "interrupt":
      target = `session:${decision.sessionId}`;
      break;
    case "verify":
      target = `checks:${commission.repository}:${candidateRevision}`;
      break;
    case "integrate":
      target = `delivery:${commission.repository}:${commission.integrationTarget}`;
      break;
    default:
      target = `assignment:${attempt.assignmentId}`;
  }
  return {
    id: logicalKey,
    logicalKey,
    commissionId: commission.id,
    kind,
    target,
    controllerId: owner.controllerId,
    ownerEpoch: owner.epoch,
    specificationGeneration: commission.specificationGeneration,
    assignmentId: attempt.assignmentId,
    attemptId: attempt.id,
    instructionSequence: sequence,
    retryCount: 0,
    candidateRevision,
    findingIds:
      decision.kind === "repair" || decision.kind === "interrupt"
        ? [...decision.findingIds]
        : [],
    directive,
    createdAt: now,
    outcome: { kind: "prepared" },
  };
}

function recordObservation(
  current: Commission,
  observation: Observation,
): Commission | null {
  if (!observationValid(observation)) return null;
  const candidateRevision = observation.candidateRevision;
  const claims: Evidence[] = observation.workerClaims.flatMap((claim) => {
    if (
      candidateRevision === null ||
      !current.obligations.some(({ id }) => id === claim.obligationId) ||
      current.evidence.some(({ id }) => id === claim.id)
    )
      return [];
    return [
      {
        id: claim.id,
        obligationId: claim.obligationId,
        specificationGeneration: current.specificationGeneration,
        criterionVersion: criterionVersion(current, claim.obligationId),
        candidateRevision,
        source: { kind: "worker", identity: claim.sourceIdentity },
        observedAt: claim.observedAt,
        expiresAt: claim.expiresAt,
        claim: claim.claim,
        disposition: "submitted",
        checkRunId: null,
      },
    ];
  });
  const reviews: Evidence[] = observation.independentReviews.flatMap(
    (review) => {
      if (
        review.specificationGeneration !== current.specificationGeneration ||
        !current.obligations.some(({ id }) => id === review.obligationId) ||
        current.evidence.some(({ id }) => id === review.id)
      )
        return [];
      return [
        {
          id: review.id,
          obligationId: review.obligationId,
          specificationGeneration: review.specificationGeneration,
          criterionVersion: criterionVersion(current, review.obligationId),
          candidateRevision: review.candidateRevision,
          source: { kind: "independent", identity: review.sourceIdentity },
          observedAt: review.observedAt,
          expiresAt: review.expiresAt,
          claim: review.claim,
          disposition: review.result,
          checkRunId: review.checkRunId,
        },
      ];
    },
  );
  const candidateUnchanged =
    candidateRevision === current.candidateRevision &&
    (candidateRevision === null ||
      (observation.candidateObservedAt === current.candidateObservedAt &&
        observation.candidateExpiresAt === current.candidateExpiresAt &&
        observation.candidateSource === current.candidateSource));
  if (
    candidateUnchanged &&
    claims.length === 0 &&
    reviews.length === 0 &&
    current.lifecycle !== "admitted"
  )
    return current;
  return {
    ...current,
    lifecycle: current.lifecycle === "admitted" ? "active" : current.lifecycle,
    candidateRevision,
    candidateObservedAt:
      candidateRevision === null ? null : observation.candidateObservedAt,
    candidateExpiresAt:
      candidateRevision === null ? null : observation.candidateExpiresAt,
    candidateSource:
      candidateRevision === null ? null : observation.candidateSource,
    evidence: [...current.evidence, ...claims, ...reviews],
  };
}

function observationValid(observation: Observation): boolean {
  const times = [
    observation.candidateObservedAt,
    observation.candidateExpiresAt,
    observation.execution.observedAt,
    observation.execution.expiresAt,
    ...(observation.execution.kind === "running" &&
    observation.execution.lastProgressAt !== null
      ? [observation.execution.lastProgressAt]
      : []),
    ...(observation.checks === null
      ? []
      : [observation.checks.observedAt, observation.checks.expiresAt]),
    ...(observation.integration.kind === "none"
      ? []
      : [
          observation.integration.observedAt,
          observation.integration.expiresAt,
        ]),
    ...observation.workerClaims.flatMap(({ observedAt, expiresAt }) => [
      observedAt,
      expiresAt,
    ]),
    ...observation.independentReviews.flatMap(({ observedAt, expiresAt }) => [
      observedAt,
      expiresAt,
    ]),
  ];
  return (
    times.every(Number.isSafeInteger) &&
    (observation.candidateRevision === null ||
      observation.candidateSource.length > 0) &&
    new Set([
      ...observation.workerClaims.map(({ id }) => id),
      ...observation.independentReviews.map(({ id }) => id),
    ]).size ===
      observation.workerClaims.length + observation.independentReviews.length
  );
}

function observationValidFor(
  commission: Commission,
  observation: Observation,
): boolean {
  if (!observationValid(observation)) return false;
  if (observation.execution.kind === "running") {
    const execution = observation.execution;
    if (
      (execution.contextTokens !== null &&
        (!Number.isSafeInteger(execution.contextTokens) ||
          execution.contextTokens < 0)) ||
      (execution.contextLimitTokens !== null &&
        (!Number.isSafeInteger(execution.contextLimitTokens) ||
          execution.contextLimitTokens < 1)) ||
      (execution.contextPressure &&
        (execution.contextTokens === null ||
          execution.contextLimitTokens === null)) ||
      (execution.lastProgressAt !== null &&
        (execution.lastProgressAt > execution.observedAt ||
          execution.lastProgressAt > execution.expiresAt))
    )
      return false;
  }
  if (
    observation.candidateRevision === null &&
    (observation.workerClaims.length > 0 ||
      observation.independentReviews.length > 0)
  )
    return false;
  for (const claim of observation.workerClaims) {
    if (!commission.obligations.some(({ id }) => id === claim.obligationId))
      return false;
    const previous = commission.evidence.find(({ id }) => id === claim.id);
    if (
      previous !== undefined &&
      (previous.claim !== claim.claim ||
        previous.obligationId !== claim.obligationId ||
        previous.candidateRevision !== observation.candidateRevision ||
        previous.source.identity !== claim.sourceIdentity)
    )
      return false;
  }
  for (const review of observation.independentReviews) {
    if (
      review.specificationGeneration !== commission.specificationGeneration ||
      review.candidateRevision !== observation.candidateRevision ||
      !commission.obligations.some(({ id }) => id === review.obligationId)
    )
      return false;
    const previous = commission.evidence.find(({ id }) => id === review.id);
    if (
      previous !== undefined &&
      (previous.claim !== review.claim ||
        previous.obligationId !== review.obligationId ||
        previous.candidateRevision !== review.candidateRevision ||
        previous.source.identity !== review.sourceIdentity ||
        previous.disposition !== review.result)
    )
      return false;
  }
  return true;
}

export function acceptanceGaps(
  commission: Commission,
  now: number,
  checks: CheckObservation | null,
): readonly string[] {
  return commission.obligations
    .filter(
      (obligation) =>
        !obligationSatisfied(
          commission,
          obligation,
          commission.candidateRevision,
          now,
          checks,
        ),
    )
    .map(({ id }) => id);
}

function obligationsSatisfied(
  commission: Commission,
  revision: string,
  now: number,
  checks: CheckObservation | null,
): boolean {
  return commission.obligations.every((obligation) =>
    obligationSatisfied(commission, obligation, revision, now, checks),
  );
}

function obligationSatisfied(
  commission: Commission,
  obligation: Obligation,
  revision: string | null,
  now: number,
  checks: CheckObservation | null,
): boolean {
  if (revision === null) return false;
  const applicable = commission.evidence.filter(
    (item) =>
      item.obligationId === obligation.id &&
      item.criterionVersion === criterionVersion(commission, obligation.id) &&
      item.candidateRevision === revision &&
      (item.checkRunId === null ||
        (checks?.runId === item.checkRunId &&
          checks.revision === revision &&
          checks.state === "passing")) &&
      item.observedAt <= now &&
      item.expiresAt > now,
  );
  const worker = applicable.some(({ source }) => source.kind === "worker");
  const independent = applicable.some(
    ({ source, disposition }) =>
      source.kind === "independent" && disposition === "accepted",
  );
  return (
    worker &&
    (!(
      commission.independentReviewRequired ||
      obligation.independentReviewRequired
    ) ||
      independent)
  );
}

function hasCurrentWorkerEvidence(
  commission: Commission,
  revision: string,
  now: number,
): boolean {
  return commission.evidence.some(
    (evidence) =>
      evidence.source.kind === "worker" &&
      evidence.candidateRevision === revision &&
      commission.obligations.some(
        ({ id }) =>
          id === evidence.obligationId &&
          evidence.criterionVersion === criterionVersion(commission, id),
      ) &&
      evidence.observedAt <= now &&
      evidence.expiresAt > now,
  );
}

function criterionVersion(
  commission: Commission,
  obligationId: string,
): string {
  const obligation = commission.obligations.find(
    ({ id }) => id === obligationId,
  );
  if (obligation === undefined) return "";
  return JSON.stringify([
    commission.objective,
    commission.repository,
    commission.integrationTarget,
    commission.independentReviewRequired,
    obligation.id,
    obligation.description,
    obligation.independentReviewRequired,
  ]);
}

function sameObligations(
  left: readonly Obligation[],
  right: readonly Obligation[],
): boolean {
  if (left.length !== right.length) return false;
  const byId = new Map(right.map((obligation) => [obligation.id, obligation]));
  return left.every((obligation) => {
    const other = byId.get(obligation.id);
    return (
      other !== undefined &&
      obligation.description === other.description &&
      obligation.independentReviewRequired === other.independentReviewRequired
    );
  });
}

function currentChecks(
  checks: CheckObservation | null,
  revision: string,
  policy: Policy,
  now: number,
): CheckObservation | null {
  if (
    checks === null ||
    checks.revision !== revision ||
    !isCurrent(checks.observedAt, checks.expiresAt, policy, now)
  )
    return null;
  return checks;
}

function matchesRegisteredDelivery(
  commission: Commission,
  integration: Exclude<IntegrationObservation, { kind: "none" }>,
): boolean {
  return (
    integration.repository === commission.repository &&
    integration.target === commission.integrationTarget &&
    commission.registeredPullRequestId !== null &&
    integration.providerIdentity === commission.registeredPullRequestId
  );
}

function isCurrent(
  observedAt: number,
  expiresAt: number,
  policy: Policy,
  now: number,
): boolean {
  return (
    Number.isSafeInteger(observedAt) &&
    Number.isSafeInteger(expiresAt) &&
    observedAt <= now &&
    expiresAt > now &&
    now - observedAt <= policy.maxObservationAgeMs
  );
}

function budgetExhausted(commission: Commission, now: number): boolean {
  const { limits, used } = commission.budget;
  return (
    now >= limits.deadlineAt ||
    used.instructions >= limits.maxInstructions ||
    used.costMicros >= limits.maxCostMicros
  );
}

function isUnresolved(operation: Operation): boolean {
  return (
    operation.outcome.kind === "prepared" ||
    operation.outcome.kind === "submitted" ||
    operation.outcome.kind === "ambiguous" ||
    operation.outcome.kind === "retry_authorized"
  );
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => item === right[index])
  );
}

function activeAttempt(commission: Commission): Attempt | null {
  return (
    commission.attempts.find(({ id }) => id === commission.activeAttemptId) ??
    null
  );
}

function strategyOrHold(
  commission: Commission,
  attempt: Attempt,
  nextStrategy: string,
  directive: string,
): Decision {
  if (commission.budget.used.attempts >= commission.budget.limits.maxAttempts) {
    return { kind: "hold", reason: "budget_exhausted" };
  }
  return {
    kind: "change_strategy",
    attemptId: attempt.id,
    nextStrategy,
    directive,
  };
}

function authorizedOwner(
  commission: Commission,
  lease: LeaseGrant,
  now: number,
): boolean {
  return (
    commission.owner !== null &&
    commission.owner.controllerId === lease.owner.controllerId &&
    commission.owner.epoch === lease.owner.epoch &&
    validLease(lease, now)
  );
}

function validLease(lease: LeaseGrant, now: number): boolean {
  return (
    Boolean(lease.owner.controllerId) &&
    Boolean(lease.resourceVersion) &&
    Number.isSafeInteger(lease.owner.epoch) &&
    lease.owner.epoch > 0 &&
    lease.observedAt <= now &&
    lease.validUntil > now
  );
}

function contextPacket(
  commission: Commission,
  revision: string | null,
  operations: readonly Operation[],
  now: number,
  checks: CheckObservation | null,
): string {
  const attempt = activeAttempt(commission);
  const outstanding = commission.obligations.filter(
    (obligation) =>
      !obligationSatisfied(commission, obligation, revision, now, checks),
  );
  const findings = operations
    .filter(
      (operation) =>
        operation.attemptId === attempt?.id &&
        operation.specificationGeneration ===
          commission.specificationGeneration &&
        operation.kind === "repair" &&
        operation.candidateRevision === revision,
    )
    .flatMap(({ findingIds }) => findingIds);
  const previousAttempts = commission.attempts
    .filter(({ id }) => id !== attempt?.id)
    .map(
      ({ ordinal, strategy, lifecycle }) =>
        `${ordinal}:${strategy} (${lifecycle})`,
    );
  return [
    `Campaign: ${commission.campaignId}`,
    `Commission: ${commission.id}`,
    `Objective: ${commission.objective}`,
    `Repository: ${commission.repository}`,
    `Integration target: ${commission.integrationTarget}`,
    `Assignment: ${attempt?.assignmentId ?? "not assigned"}`,
    `Attempt: ${attempt === null ? "not assigned" : `${attempt.ordinal} · ${attempt.strategy}`}`,
    `Previous attempts: ${previousAttempts.join("; ") || "none"}`,
    `Candidate: ${revision ?? "not observed"}`,
    `Budget remaining: attempts ${Math.max(0, commission.budget.limits.maxAttempts - commission.budget.used.attempts)}, instructions ${Math.max(0, commission.budget.limits.maxInstructions - commission.budget.used.instructions)}, repairs ${Math.max(0, commission.budget.limits.maxRepairs - commission.budget.used.repairs)}, costMicros ${Math.max(0, commission.budget.limits.maxCostMicros - commission.budget.used.costMicros)}`,
    `Known repair findings: ${[...new Set(findings)].join("; ") || "none"}`,
    `Outstanding obligations: ${outstanding.map(({ id, description }) => `${id}: ${description}`).join("; ") || "none"}`,
  ].join("\n");
}

function exhaustive(value: never): never {
  throw new Error(`Unhandled domain variant: ${JSON.stringify(value)}`);
}
