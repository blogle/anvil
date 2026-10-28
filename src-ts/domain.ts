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
  evidence: readonly Evidence[];
}>;

export type OperationKind =
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
      repeatedToolFailures: readonly string[];
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
  state: "pending" | "failing" | "passing" | "unknown";
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
}>;

export type WakeCondition =
  | Readonly<{ kind: "execution"; sessionId: string }>
  | Readonly<{ kind: "check_run"; runId: string }>
  | Readonly<{ kind: "merge_queue"; pullRequest: string }>
  | Readonly<{ kind: "operation"; operationId: string }>
  | Readonly<{ kind: "provider_refresh"; provider: string }>;

export type Decision =
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
    obligationsSatisfied(commission, candidate, now) &&
    currentChecks(observation.checks, candidate, policy, now)?.state ===
      "passing"
  ) {
    const checks = currentChecks(observation.checks, candidate, policy, now);
    if (checks !== null && integration.kind === "merged") {
      return {
        kind: "conclude",
        deliveredRevision: candidate,
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
    return {
      kind: "change_strategy",
      attemptId: attempt.id,
      nextStrategy: "recover-rejected-operation",
      directive: `Choose a bounded alternative after ${refusedOperation.kind} Operation ${refusedOperation.id} was rejected`,
    };
  }
  if (observation.execution.kind === "running") {
    if (observation.execution.contextPressure) {
      return {
        kind: "refresh_context",
        attemptId: attempt.id,
        directive: contextPacket(commission, candidate),
      };
    }
    if (
      observation.execution.repeatedToolFailures.length >=
        policy.repeatedToolFailureThreshold &&
      observation.execution.repeatedToolFailures.length > 0
    ) {
      const revision = candidate ?? commission.candidateRevision;
      if (
        revision !== null &&
        commission.budget.used.repairs < commission.budget.limits.maxRepairs
      ) {
        return {
          kind: "repair",
          attemptId: attempt.id,
          candidateRevision: revision,
          findingIds: observation.execution.repeatedToolFailures,
          directive: `Repair repeated tool failures on ${revision}: ${observation.execution.repeatedToolFailures.join("; ")}`,
        };
      }
    }
    return {
      kind: "wait",
      reason: "OpenCode execution is active",
      wake: { kind: "execution", sessionId: observation.execution.sessionId },
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
      directive: contextPacket(commission, null),
    };
  }
  const accepted = obligationsSatisfied(commission, candidate, now);
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
      directive: contextPacket(commission, candidate),
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
  if (checks.state === "unknown")
    return { kind: "verify", candidateRevision: candidate };
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
      return {
        kind: "change_strategy",
        attemptId: attempt.id,
        nextStrategy: "alternate-repair",
        directive: `The same check failures remain after repair of ${checks.runId}`,
      };
    }
    if (commission.budget.used.repairs < commission.budget.limits.maxRepairs) {
      if (checks.failureIds.length === 0) {
        return {
          kind: "change_strategy",
          attemptId: attempt.id,
          nextStrategy: "diagnose-checks",
          directive: `Check ${checks.runId} failed without actionable diagnostics`,
        };
      }
      return {
        kind: "repair",
        attemptId: attempt.id,
        candidateRevision: candidate,
        findingIds: checks.failureIds,
        directive: `Repair required check run ${checks.runId} for Candidate ${candidate}: ${checks.failureIds.join(", ")}`,
      };
    }
    return {
      kind: "change_strategy",
      attemptId: attempt.id,
      nextStrategy: "alternate-repair",
      directive: `Change strategy after exhausted repairs for ${checks.runId}`,
    };
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
    return {
      kind: "change_strategy",
      attemptId: attempt.id,
      nextStrategy: "reconcile-delivery",
      directive: `Delivered ${observation.integration.revision}; current Candidate is ${candidate}`,
    };
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
      return authorizeDecision(observed, current.version, input, decision);
    }
    case "hold": {
      if (!authorizedOwner(current, input.lease, input.now))
        return err("owner_mismatch");
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
): Result<Transition, DomainError> {
  if (decision.kind === "conclude") {
    const integration = input.observation.integration;
    const checks = input.observation.checks;
    if (
      integration.kind !== "merged" ||
      checks === null ||
      integration.revision !== decision.deliveredRevision ||
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
        { ...current, version: beforeVersion + 1 },
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
  if (
    operation.commissionId !== current.id ||
    operation.controllerId !== lease.owner.controllerId ||
    operation.ownerEpoch !== lease.owner.epoch
  )
    return err("owner_mismatch");
  if (!allowedOutcome(operation.outcome, outcome))
    return err("invalid_operation_transition");
  return ok(
    transition(
      current.version,
      { ...current, version: current.version + 1 },
      [],
      [{ ...operation, outcome }],
    ),
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
    decision.kind === "change_strategy" ? decision.nextStrategy : "",
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
    case "continue":
    case "repair":
    case "refresh_context":
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
  return {
    id: logicalKey,
    logicalKey,
    commissionId: commission.id,
    kind,
    target:
      kind === "verify"
        ? `checks:${commission.repository}:${candidateRevision}`
        : kind === "integrate"
          ? `delivery:${commission.repository}:${commission.integrationTarget}`
          : `assignment:${attempt.assignmentId}`,
    controllerId: owner.controllerId,
    ownerEpoch: owner.epoch,
    specificationGeneration: commission.specificationGeneration,
    assignmentId: attempt.assignmentId,
    attemptId: attempt.id,
    instructionSequence: sequence,
    retryCount: 0,
    candidateRevision,
    findingIds: decision.kind === "repair" ? [...decision.findingIds] : [],
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

function obligationsSatisfied(
  commission: Commission,
  revision: string,
  now: number,
): boolean {
  return commission.obligations.every((obligation) => {
    const evidence = commission.evidence.filter(
      (item) =>
        item.obligationId === obligation.id &&
        item.specificationGeneration === commission.specificationGeneration &&
        item.candidateRevision === revision &&
        item.observedAt <= now &&
        item.expiresAt > now,
    );
    const worker = evidence.some(({ source }) => source.kind === "worker");
    const independent = evidence.some(
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
  });
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
      evidence.specificationGeneration === commission.specificationGeneration &&
      evidence.observedAt <= now &&
      evidence.expiresAt > now,
  );
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
    used.attempts >= limits.maxAttempts ||
    used.instructions >= limits.maxInstructions ||
    used.costMicros >= limits.maxCostMicros
  );
}

function isUnresolved(operation: Operation): boolean {
  return (
    operation.outcome.kind === "prepared" ||
    operation.outcome.kind === "submitted" ||
    operation.outcome.kind === "ambiguous"
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
): string {
  const outstanding = commission.obligations.filter(
    (obligation) =>
      !commission.evidence.some(
        (evidence) =>
          evidence.obligationId === obligation.id &&
          evidence.candidateRevision === revision &&
          evidence.specificationGeneration ===
            commission.specificationGeneration,
      ),
  );
  return [
    `Objective: ${commission.objective}`,
    `Repository: ${commission.repository}`,
    `Integration target: ${commission.integrationTarget}`,
    `Candidate: ${revision ?? "not observed"}`,
    `Outstanding obligations: ${outstanding.map(({ id, description }) => `${id}: ${description}`).join("; ") || "none"}`,
  ].join("\n");
}

function exhaustive(value: never): never {
  throw new Error(`Unhandled domain variant: ${JSON.stringify(value)}`);
}
