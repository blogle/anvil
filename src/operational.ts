import type { ApplicationError } from "./application";
import type {
  Commission,
  Decision,
  Observation,
  Operation,
  Policy,
} from "./domain";
import { acceptanceGaps } from "./domain";

// These are inspectable records of reconciliation, never new domain authority.
export type ReconciliationRecord = Readonly<{
  commissionVersion: number;
  recordedAt: number;
  observation: Readonly<{
    commissionVersion: number;
    specificationGeneration: number;
    value: Observation;
  }> | null;
  result:
    | Readonly<{ kind: "decision"; decision: Decision | null }>
    | Readonly<{ kind: "error"; error: ApplicationError }>;
}>;

export type DecisionHistoryEntry = Readonly<{
  sequence: number;
  commissionVersion: number;
  recordedAt: number;
  result: ReconciliationRecord["result"];
}>;

export function projectCommission(
  commission: Commission,
  operations: readonly Operation[],
  reconciliation: ReconciliationRecord | null,
  now: number,
  policy: Policy,
) {
  const observed = reconciliation?.observation ?? null;
  const applicable =
    observed !== null &&
    observed.specificationGeneration === commission.specificationGeneration;
  const observation = applicable ? observed.value : null;
  const pending = operations.filter(({ outcome }) =>
    ["prepared", "submitted", "ambiguous", "retry_authorized"].includes(
      outcome.kind,
    ),
  );
  return {
    commission,
    projectedAt: now,
    reconciliation,
    decisionApplicable:
      reconciliation !== null &&
      reconciliation.commissionVersion === commission.version,
    observationApplicable: applicable,
    freshness:
      observation === null
        ? ("unavailable" as const)
        : observation.execution.observedAt > now
          ? ("future" as const)
          : observation.execution.expiresAt <= now ||
              now - observation.execution.observedAt >
                policy.maxObservationAgeMs
            ? ("stale" as const)
            : ("fresh" as const),
    pendingOperations: pending,
    steeringCommands: operations
      .filter((operation) => operation.kind === "steer")
      .map((operation) => ({
        operationId: operation.id,
        target: operation.target,
        requestedAt: operation.createdAt,
        request: operation.steering,
        disposition: operation.outcome,
        pending: pending.some(({ id }) => id === operation.id),
      })),
    attempts: commission.attempts.map((attempt) => ({
      ...attempt,
      operations: operations.filter(
        ({ attemptId }) => attemptId === attempt.id,
      ),
    })),
    evidence: commission.evidence,
    acceptanceGaps: acceptanceGaps(
      commission,
      now,
      observation?.checks ?? null,
    ),
    deployment: {
      kind: "unknown" as const,
      reason: "No deployment provider observation is configured",
    },
  };
}
