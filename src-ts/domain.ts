import { z } from "zod";

const timestamp = z.number().int().nonnegative();
const provenanceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("worker"), identity: z.string() }),
  z.object({ kind: z.literal("check"), identity: z.string() }),
  z.object({ kind: z.literal("github"), identity: z.string() }),
  z.object({ kind: z.literal("controller"), identity: z.string() }),
]);
const evidenceSchema = z.object({
  id: z.string().min(1),
  obligationId: z.string().min(1),
  candidateRevision: z.string().min(1),
  source: provenanceSchema,
  disposition: z.enum(["submitted", "accepted", "challenged"]),
  observedAt: timestamp,
  expiresAt: timestamp,
});

export const operationSchema = z.object({
  id: z.string().min(1),
  kind: z.enum([
    "instruction",
    "repair",
    "refresh_context",
    "change_strategy",
    "verify",
    "integrate",
  ]),
  target: z.string().min(1),
  authorizedGeneration: z.number().int().positive(),
  assignmentId: z.string().min(1),
  attemptId: z.string().min(1),
  candidateRevision: z.string().nullable(),
  findingIds: z.array(z.string().min(1)),
  state: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("prepared") }),
    z.object({ kind: z.literal("submitted"), submittedAt: timestamp }),
    z.object({
      kind: z.literal("ambiguous"),
      observedAt: timestamp,
      reason: z.string(),
    }),
    z.object({
      kind: z.literal("observed"),
      observedAt: timestamp,
      source: z.string(),
      postcondition: z.enum(["satisfied", "not_satisfied"]),
    }),
    z.object({
      kind: z.literal("rejected"),
      observedAt: timestamp,
      reason: z.string(),
    }),
  ]),
  createdAt: timestamp,
});

export const commissionSchema = z
  .object({
    id: z.string().min(1),
    campaignId: z.string().min(1),
    objective: z.string().min(1),
    repository: z.string().min(1),
    integrationTarget: z.string().min(1),
    generation: z.number().int().positive(),
    lifecycle: z.enum(["proposed", "admitted", "active", "held", "concluded"]),
    owner: z
      .object({
        controllerId: z.string().min(1),
        leaseExpiresAt: timestamp,
      })
      .nullable(),
    assignmentId: z.string().min(1),
    attempt: z.object({
      id: z.string().min(1),
      ordinal: z.number().int().positive(),
      disposition: z.enum(["active", "completed", "failed", "superseded"]),
      strategy: z.string().min(1),
    }),
    budget: z.object({
      maxAttempts: z.number().int().nonnegative(),
      maxRepairs: z.number().int().nonnegative(),
      attemptsUsed: z.number().int().nonnegative(),
      repairsUsed: z.number().int().nonnegative(),
      costLimitMicros: z.number().int().nonnegative(),
      costUsedMicros: z.number().int().nonnegative(),
      deadlineAt: timestamp,
    }),
    candidate: z
      .object({ revision: z.string().min(1), observedAt: timestamp })
      .nullable(),
    obligations: z.array(
      z.object({ id: z.string().min(1), description: z.string().min(1) }),
    ),
    evidence: z.array(evidenceSchema),
    execution: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("running"),
        sessionId: z.string(),
        observedAt: timestamp,
        expiresAt: timestamp,
        contextPressure: z.boolean(),
        toolFailures: z.array(z.string()),
      }),
      z.object({
        kind: z.literal("idle"),
        sessionId: z.string(),
        observedAt: timestamp,
        expiresAt: timestamp,
      }),
      z.object({
        kind: z.literal("unavailable"),
        reason: z.string(),
        observedAt: timestamp,
        expiresAt: timestamp,
      }),
      z.object({
        kind: z.literal("unknown"),
        reason: z.string(),
        observedAt: timestamp,
        expiresAt: timestamp,
      }),
    ]),
    checks: z
      .object({
        candidateRevision: z.string(),
        state: z.enum(["pending", "passing", "failing", "unknown"]),
        observedAt: timestamp,
        expiresAt: timestamp,
      })
      .nullable(),
    integration: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("none") }),
      z.object({
        kind: z.literal("pr_open"),
        revision: z.string(),
        observedAt: timestamp,
        expiresAt: timestamp,
      }),
      z.object({
        kind: z.literal("queued"),
        revision: z.string(),
        observedAt: timestamp,
        expiresAt: timestamp,
      }),
      z.object({
        kind: z.literal("merged"),
        revision: z.string(),
        observedAt: timestamp,
        expiresAt: timestamp,
        providerIdentity: z.string().min(1),
      }),
    ]),
    operations: z.array(operationSchema),
    findings: z.array(
      z.object({
        id: z.string(),
        summary: z.string(),
        source: provenanceSchema,
        observedAt: timestamp,
        expiresAt: timestamp,
        candidateRevision: z.string().optional(),
      }),
    ),
  })
  .superRefine((commission, context) => {
    for (const [name, entries] of [
      ["obligation", commission.obligations],
      ["evidence", commission.evidence],
      ["operation", commission.operations],
      ["Finding", commission.findings],
    ] as const) {
      const identities = entries.map(({ id }) => id);
      if (new Set(identities).size !== identities.length) {
        context.addIssue({
          code: "custom",
          message: `${name} identities must be unique`,
        });
      }
    }
  });

export type Commission = z.infer<typeof commissionSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type Operation = z.infer<typeof operationSchema>;

export type Decision =
  | {
      kind: "wait";
      reason:
        | "active_execution"
        | "provider_observation"
        | "operation_outcome"
        | "integration_queue";
    }
  | {
      kind: "continue";
      assignmentId: string;
      attemptId: string;
      reason: "no_candidate" | "missing_evidence";
    }
  | { kind: "repair"; findingIds: string[]; candidateRevision: string }
  | { kind: "refresh_context"; attemptId: string }
  | { kind: "change_strategy"; attemptId: string; reason: string }
  | { kind: "verify"; candidateRevision: string }
  | { kind: "integrate"; candidateRevision: string }
  | {
      kind: "hold";
      reason: "authority_lost" | "budget_exhausted" | "operator_hold";
    }
  | { kind: "escalate"; reason: string }
  | { kind: "conclude"; deliveredRevision: string };

function exhaustive(value: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`);
}

export function operationMatchesDecision(
  decision: Decision,
  operation: Operation,
): boolean {
  switch (decision.kind) {
    case "continue":
      return (
        operation.kind === "instruction" &&
        operation.assignmentId === decision.assignmentId &&
        operation.attemptId === decision.attemptId &&
        operation.candidateRevision === null &&
        operation.findingIds.length === 0
      );
    case "repair":
      return (
        operation.kind === "repair" &&
        operation.candidateRevision === decision.candidateRevision &&
        JSON.stringify(operation.findingIds) ===
          JSON.stringify(decision.findingIds)
      );
    case "refresh_context":
      return (
        operation.kind === "refresh_context" &&
        operation.attemptId === decision.attemptId
      );
    case "change_strategy":
      return (
        operation.kind === "change_strategy" &&
        operation.attemptId === decision.attemptId
      );
    case "verify":
      return (
        operation.kind === "verify" &&
        operation.candidateRevision === decision.candidateRevision
      );
    case "integrate":
      return (
        operation.kind === "integrate" &&
        operation.candidateRevision === decision.candidateRevision
      );
    case "wait":
    case "hold":
    case "escalate":
    case "conclude":
      return false;
    default:
      return exhaustive(decision);
  }
}

function acceptedObligations(commission: Commission, now: number): boolean {
  const revision = commission.candidate?.revision;
  if (revision === undefined || commission.obligations.length === 0)
    return false;
  return commission.obligations.every((obligation) =>
    commission.evidence.some(
      (evidence) =>
        evidence.obligationId === obligation.id &&
        evidence.candidateRevision === revision &&
        evidence.disposition === "accepted" &&
        evidence.observedAt <= now &&
        evidence.expiresAt > now &&
        evidence.source.kind !== "worker",
    ),
  );
}

function isBudgetExhausted(commission: Commission, now: number): boolean {
  const budget = commission.budget;
  return (
    now >= budget.deadlineAt ||
    budget.attemptsUsed >= budget.maxAttempts ||
    budget.repairsUsed >= budget.maxRepairs ||
    budget.costUsedMicros >= budget.costLimitMicros
  );
}

function currentFindings(
  commission: Commission,
  now: number,
): Commission["findings"] {
  const revision = commission.candidate?.revision;
  if (revision === undefined) return [];
  return commission.findings.filter(
    (finding) =>
      (finding.candidateRevision === undefined ||
        finding.candidateRevision === revision) &&
      finding.observedAt <= now &&
      finding.expiresAt > now,
  );
}

export function decideCommission(
  commission: Commission,
  now: number,
): Decision {
  if (commission.lifecycle === "held")
    return { kind: "hold", reason: "operator_hold" };
  if (commission.owner === null || commission.owner.leaseExpiresAt <= now) {
    return { kind: "hold", reason: "authority_lost" };
  }
  if (isBudgetExhausted(commission, now))
    return { kind: "hold", reason: "budget_exhausted" };

  const unresolved = commission.operations.some(
    (operation) =>
      operation.state.kind === "prepared" ||
      operation.state.kind === "submitted" ||
      operation.state.kind === "ambiguous",
  );
  if (unresolved) return { kind: "wait", reason: "operation_outcome" };

  if (commission.lifecycle === "proposed")
    return { kind: "escalate", reason: "Commission has not been admitted" };
  if (commission.lifecycle === "admitted")
    return {
      kind: "continue",
      assignmentId: commission.assignmentId,
      attemptId: commission.attempt.id,
      reason: "no_candidate",
    };

  const findings = currentFindings(commission, now);
  if (commission.candidate !== null && commission.candidate.observedAt > now) {
    return { kind: "wait", reason: "provider_observation" };
  }
  if (commission.execution.expiresAt <= now) {
    return { kind: "wait", reason: "provider_observation" };
  }

  switch (commission.execution.kind) {
    case "running": {
      if (commission.execution.contextPressure)
        return { kind: "refresh_context", attemptId: commission.attempt.id };
      if (
        commission.execution.toolFailures.length > 0 &&
        commission.candidate !== null &&
        findings.length > 0
      ) {
        return {
          kind: "repair",
          findingIds: findings.map(({ id }) => id),
          candidateRevision: commission.candidate.revision,
        };
      }
      return { kind: "wait", reason: "active_execution" };
    }
    case "unavailable":
    case "unknown":
      return { kind: "wait", reason: "provider_observation" };
    case "idle":
      break;
    default:
      return exhaustive(commission.execution);
  }

  if (findings.length > 0 && commission.candidate !== null) {
    return {
      kind: "repair",
      findingIds: findings.map(({ id }) => id),
      candidateRevision: commission.candidate.revision,
    };
  }
  if (commission.candidate === null) {
    return {
      kind: "continue",
      assignmentId: commission.assignmentId,
      attemptId: commission.attempt.id,
      reason: "no_candidate",
    };
  }
  if (!acceptedObligations(commission, now)) {
    const workerSubmitted = commission.evidence.some(
      (evidence) =>
        evidence.candidateRevision === commission.candidate?.revision &&
        evidence.source.kind === "worker",
    );
    if (workerSubmitted)
      return {
        kind: "verify",
        candidateRevision: commission.candidate.revision,
      };
    return {
      kind: "continue",
      assignmentId: commission.assignmentId,
      attemptId: commission.attempt.id,
      reason: "missing_evidence",
    };
  }

  const checks = commission.checks;
  const checksCurrent =
    checks !== null &&
    checks.candidateRevision === commission.candidate.revision &&
    checks.observedAt <= now &&
    checks.expiresAt > now;
  if (
    !checksCurrent ||
    checks?.state === "pending" ||
    checks?.state === "unknown"
  ) {
    return { kind: "verify", candidateRevision: commission.candidate.revision };
  }
  if (checks.state === "failing") {
    if (findings.length === 0) {
      return {
        kind: "change_strategy",
        attemptId: commission.attempt.id,
        reason: "Required checks failed without an actionable Finding",
      };
    }
    return {
      kind: "repair",
      findingIds: findings.map(({ id }) => id),
      candidateRevision: commission.candidate.revision,
    };
  }

  if (
    commission.integration.kind !== "none" &&
    (commission.integration.observedAt > now ||
      commission.integration.expiresAt <= now)
  ) {
    return { kind: "wait", reason: "provider_observation" };
  }
  if (commission.integration.kind === "queued")
    return { kind: "wait", reason: "integration_queue" };
  if (commission.integration.kind === "merged") {
    if (commission.integration.revision === commission.candidate.revision) {
      return {
        kind: "conclude",
        deliveredRevision: commission.integration.revision,
      };
    }
    return {
      kind: "change_strategy",
      attemptId: commission.attempt.id,
      reason: "The delivered revision differs from the accepted Candidate",
    };
  }
  if (
    commission.integration.kind === "none" ||
    commission.integration.kind === "pr_open"
  ) {
    return {
      kind: "integrate",
      candidateRevision: commission.candidate.revision,
    };
  }
  return exhaustive(commission.integration);
}
