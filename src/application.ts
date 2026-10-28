import { z } from "zod";
import {
  evolve,
  evolveOperation,
  proposeCommission,
  type Commission,
  type CommissionProposalInput,
  type Decision,
  type LeaseGrant,
  type Observation,
  type Operation,
  type OperationOutcome,
  type Policy,
  type Result,
} from "./domain";
import { CommissionStore, type StoreError } from "./persistence/sqlite";

export type ProviderFailure = Readonly<{
  kind: "unavailable" | "acknowledgement_lost" | "rejected";
  message: string;
}>;

export type ProviderResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: ProviderFailure }>;

export interface LeasePort {
  current(
    commissionId: string,
    controllerId: string,
    now: number,
  ): Promise<ProviderResult<LeaseGrant>>;
}

export interface AuthorizationPort {
  approve(
    request: Readonly<{
      commissionId: string;
      principalId: string;
      action: "admit" | "amend_specification";
    }>,
  ): Promise<boolean>;
}

export interface ProviderPort {
  observe(
    commission: Commission,
    now: number,
    operations: readonly Operation[],
  ): Promise<ProviderResult<Observation>>;
  dispatch(
    commission: Commission,
    operation: Operation,
  ): Promise<ProviderResult<Exclude<OperationOutcome, { kind: "prepared" }>>>;
  inspectOperation(
    commission: Commission,
    operation: Operation,
  ): Promise<ProviderResult<OperationOutcome | null>>;
}

export type ApplicationError =
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "unauthorized" }>
  | Readonly<{ kind: "domain"; error: string }>
  | Readonly<{ kind: "store"; error: StoreError }>
  | Readonly<{ kind: "provider"; error: ProviderFailure }>
  | Readonly<{ kind: "invalid_provider_observation" }>
  | Readonly<{ kind: "ownership_unavailable" }>;

export type ReconcileResult = Readonly<{
  commission: Commission;
  decision: Decision | null;
}>;

const ownerSchema = z
  .object({
    owner: z.object({
      controllerId: z.string().min(1),
      epoch: z.number().int().positive(),
    }),
    resourceVersion: z.string().min(1),
    observedAt: z.number().int().nonnegative(),
    validUntil: z.number().int().nonnegative(),
  })
  .strict();

const executionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("running"),
      sessionId: z.string(),
      contextPressure: z.boolean(),
      repeatedToolFailures: z.array(z.string()),
      observedAt: z.number().int(),
      expiresAt: z.number().int(),
      source: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("idle"),
      sessionId: z.string(),
      observedAt: z.number().int(),
      expiresAt: z.number().int(),
      source: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unavailable"),
      reason: z.string(),
      observedAt: z.number().int(),
      expiresAt: z.number().int(),
      source: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unknown"),
      reason: z.string(),
      observedAt: z.number().int(),
      expiresAt: z.number().int(),
      source: z.string().min(1),
    })
    .strict(),
]);
const observationSchema = z
  .object({
    candidateRevision: z.string().nullable(),
    candidateObservedAt: z.number().int(),
    candidateExpiresAt: z.number().int(),
    candidateSource: z.string().min(1),
    execution: executionSchema,
    checks: z
      .object({
        runId: z.string().min(1),
        revision: z.string().min(1),
        state: z.enum(["pending", "failing", "passing", "unknown"]),
        failureIds: z.array(z.string()),
        observedAt: z.number().int(),
        expiresAt: z.number().int(),
        source: z.string().min(1),
      })
      .strict()
      .nullable(),
    integration: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("none") }).strict(),
      z
        .object({
          kind: z.enum(["pr_open", "queued", "merged"]),
          revision: z.string().min(1),
          providerIdentity: z.string().min(1),
          repository: z.string().min(1),
          target: z.string().min(1),
          observedAt: z.number().int(),
          expiresAt: z.number().int(),
          source: z.string().min(1),
        })
        .strict(),
    ]),
    workerClaims: z.array(
      z
        .object({
          id: z.string().min(1),
          obligationId: z.string().min(1),
          claim: z.string(),
          observedAt: z.number().int(),
          expiresAt: z.number().int(),
          sourceIdentity: z.string().min(1),
        })
        .strict(),
    ),
    independentReviews: z.array(
      z
        .object({
          id: z.string().min(1),
          obligationId: z.string().min(1),
          candidateRevision: z.string().min(1),
          specificationGeneration: z.number().int().positive(),
          result: z.enum(["accepted", "challenged"]),
          checkRunId: z.string().nullable(),
          claim: z.string(),
          observedAt: z.number().int(),
          expiresAt: z.number().int(),
          sourceIdentity: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();
const operationOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prepared") }).strict(),
  z
    .object({ kind: z.literal("submitted"), submittedAt: z.number().int() })
    .strict(),
  z
    .object({
      kind: z.literal("ambiguous"),
      observedAt: z.number().int(),
      reason: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("observed"),
      observedAt: z.number().int(),
      source: z.string().min(1),
      result: z.enum(["accepted", "rejected", "applied", "not_applied"]),
      retrySafe: z.boolean(),
      externalIdentity: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("retry_authorized"),
      authorizedAt: z.number().int(),
      observation: z
        .object({
          observedAt: z.number().int(),
          source: z.string().min(1),
          result: z.literal("not_applied"),
          retrySafe: z.literal(true),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("rejected"),
      observedAt: z.number().int(),
      reason: z.string(),
    })
    .strict(),
]);

export class ApplicationService {
  readonly #store: CommissionStore;
  readonly #lease: LeasePort;
  readonly #provider: ProviderPort;
  readonly #authorization: AuthorizationPort;
  readonly #controllerId: string;
  readonly #policy: Policy;

  constructor(
    store: CommissionStore,
    lease: LeasePort,
    provider: ProviderPort,
    authorization: AuthorizationPort,
    controllerId: string,
    policy: Policy,
  ) {
    this.#store = store;
    this.#lease = lease;
    this.#provider = provider;
    this.#authorization = authorization;
    this.#controllerId = controllerId;
    this.#policy = policy;
  }

  propose(input: CommissionProposalInput): Result<void, ApplicationError> {
    const proposal = proposeCommission(input);
    if (!proposal.ok)
      return { ok: false, error: { kind: "domain", error: proposal.error } };
    const result = this.#store.propose(proposal.value);
    return result.ok
      ? result
      : { ok: false, error: { kind: "store", error: result.error } };
  }

  async admit(
    commissionId: string,
    principalId: string,
    now: number,
  ): Promise<Result<Commission, ApplicationError>> {
    if (
      !(await this.#authorization.approve({
        commissionId,
        principalId,
        action: "admit",
      }))
    ) {
      return { ok: false, error: { kind: "unauthorized" } };
    }
    const current = this.#load(commissionId);
    if (!current.ok) return current;
    const grant = await this.#currentLease(commissionId, now);
    if (!grant.ok) return grant;
    const transition = evolve(current.value, {
      kind: "admit",
      actor: { kind: "approver", identity: principalId },
      lease: grant.value,
      attemptId: `${commissionId}:attempt-1`,
      assignmentId: `${commissionId}:assignment-1`,
      now,
    });
    if (!transition.ok)
      return { ok: false, error: { kind: "domain", error: transition.error } };
    return this.#commit(transition.value);
  }

  async reconcile(
    commissionId: string,
    now: number,
  ): Promise<Result<ReconcileResult, ApplicationError>> {
    for (let conflict = 0; conflict < 3; conflict += 1) {
      const loaded = this.#load(commissionId);
      if (!loaded.ok) return loaded;
      const lease = await this.#currentLease(commissionId, now);
      if (!lease.ok) return lease;
      let current = loaded.value;
      if (!hasOwner(current, lease.value)) {
        const takeover = evolve(current, {
          kind: "takeover",
          lease: lease.value,
          now,
        });
        if (!takeover.ok)
          return {
            ok: false,
            error: { kind: "domain", error: takeover.error },
          };
        const result = this.#store.commitTransition(takeover.value);
        if (!result.ok && result.error === "conflict") continue;
        if (!result.ok)
          return { ok: false, error: { kind: "store", error: result.error } };
        continue;
      }

      let operations = this.#store.operations(commissionId);
      const rawObservation = await this.#provider.observe(
        current,
        now,
        operations,
      );
      if (!rawObservation.ok)
        return {
          ok: false,
          error: { kind: "provider", error: rawObservation.error },
        };
      const parsed = observationSchema.safeParse(rawObservation.value);
      if (!parsed.success)
        return { ok: false, error: { kind: "invalid_provider_observation" } };
      const result = evolve(current, {
        kind: "reconcile",
        lease: lease.value,
        observation: parsed.data,
        operations,
        policy: this.#policy,
        now,
      });
      if (!result.ok)
        return { ok: false, error: { kind: "domain", error: result.error } };
      const transition = result.value;
      if (transition.commission.version !== transition.beforeVersion) {
        const saved = this.#store.commitTransition(transition);
        if (!saved.ok && saved.error === "conflict") continue;
        if (!saved.ok)
          return { ok: false, error: { kind: "store", error: saved.error } };
      }
      current = transition.commission;
      operations = this.#store.operations(commissionId);
      const created = transition.newOperations[0];
      if (created !== undefined) {
        const dispatched = await this.#dispatchAndRecord(
          current,
          created,
          lease.value,
          now,
        );
        if (!dispatched.ok) return dispatched;
        return {
          ok: true,
          value: {
            commission: dispatched.value,
            decision: transition.decision,
          },
        };
      }
      const pending = operations.find(isPending);
      if (pending !== undefined) {
        if (pending.outcome.kind === "retry_authorized") {
          const retried = await this.#dispatchAndRecord(
            current,
            pending,
            lease.value,
            now,
          );
          if (!retried.ok) return retried;
          return {
            ok: true,
            value: {
              commission: retried.value,
              decision: {
                kind: "wait",
                reason:
                  "safe retry was submitted with the original Operation identity",
                wake: { kind: "operation", operationId: pending.id },
              },
            },
          };
        }
        const inspected = await this.#provider.inspectOperation(
          current,
          pending,
        );
        if (!inspected.ok)
          return {
            ok: false,
            error: { kind: "provider", error: inspected.error },
          };
        if (inspected.value === null) {
          return {
            ok: true,
            value: {
              commission: current,
              decision: {
                kind: "wait",
                reason: "operation result unknown; no safe retry evidence",
                wake: { kind: "operation", operationId: pending.id },
              },
            },
          };
        }
        const checkedOutcome = operationOutcomeSchema.safeParse(
          inspected.value,
        );
        if (!checkedOutcome.success)
          return { ok: false, error: { kind: "invalid_provider_observation" } };
        if (checkedOutcome.data.kind === "prepared") {
          return {
            ok: true,
            value: {
              commission: current,
              decision: {
                kind: "wait",
                reason: "submitted status is not observable; no safe retry",
                wake: { kind: "operation", operationId: pending.id },
              },
            },
          };
        }
        const resolution = evolveOperation(
          current,
          pending,
          lease.value,
          checkedOutcome.data,
          now,
        );
        if (!resolution.ok)
          return {
            ok: false,
            error: { kind: "domain", error: resolution.error },
          };
        if (
          resolution.value.commission.version !== resolution.value.beforeVersion
        ) {
          const committed = this.#store.commitTransition(resolution.value);
          if (!committed.ok && committed.error === "conflict") continue;
          if (!committed.ok)
            return {
              ok: false,
              error: { kind: "store", error: committed.error },
            };
        }
        return {
          ok: true,
          value: {
            commission: resolution.value.commission,
            decision: {
              kind: "wait",
              reason: "operation outcome observed; reobserve providers",
              wake: { kind: "provider_refresh", provider: "world" },
            },
          },
        };
      }

      const retry = transition.updatedOperations.find(
        ({ outcome }) => outcome.kind === "retry_authorized",
      );
      if (retry !== undefined) {
        const executed = await this.#dispatchAndRecord(
          transition.commission,
          retry,
          lease.value,
          now,
        );
        if (!executed.ok) return executed;
        return {
          ok: true,
          value: { commission: executed.value, decision: transition.decision },
        };
      }
      return {
        ok: true,
        value: {
          commission: transition.commission,
          decision: transition.decision,
        },
      };
    }
    return { ok: false, error: { kind: "store", error: "conflict" } };
  }

  async hold(
    commissionId: string,
    reason: string,
    now: number,
  ): Promise<Result<Commission, ApplicationError>> {
    return this.#authorizedTransition(commissionId, now, (commission, lease) =>
      evolve(commission, { kind: "hold", lease, reason, now }),
    );
  }

  async resume(
    commissionId: string,
    now: number,
  ): Promise<Result<Commission, ApplicationError>> {
    return this.#authorizedTransition(commissionId, now, (commission, lease) =>
      evolve(commission, { kind: "resume", lease, now }),
    );
  }

  async recordUsage(
    commissionId: string,
    costMicros: number,
    now: number,
  ): Promise<Result<Commission, ApplicationError>> {
    return this.#authorizedTransition(commissionId, now, (commission, lease) =>
      evolve(commission, { kind: "record_usage", lease, costMicros, now }),
    );
  }

  async amendSpecification(
    commissionId: string,
    principalId: string,
    expectedGeneration: number,
    amendment: Readonly<{
      objective: string;
      integrationTarget: string;
      obligations: Commission["obligations"];
      independentReviewRequired: boolean;
    }>,
    now: number,
  ): Promise<Result<Commission, ApplicationError>> {
    if (
      !(await this.#authorization.approve({
        commissionId,
        principalId,
        action: "amend_specification",
      }))
    ) {
      return { ok: false, error: { kind: "unauthorized" } };
    }
    return this.#authorizedTransition(commissionId, now, (commission) =>
      evolve(commission, {
        kind: "amend_specification",
        actor: { kind: "approver", identity: principalId },
        expectedGeneration,
        ...amendment,
        now,
      }),
    );
  }

  async #dispatchAndRecord(
    commission: Commission,
    operation: Operation,
    lease: LeaseGrant,
    now: number,
  ): Promise<Result<Commission, ApplicationError>> {
    const dispatched = await this.#provider.dispatch(commission, operation);
    let outcome: OperationOutcome;
    if (dispatched.ok) {
      const parsed = operationOutcomeSchema.safeParse(dispatched.value);
      if (!parsed.success)
        return { ok: false, error: { kind: "invalid_provider_observation" } };
      outcome = parsed.data;
    } else if (dispatched.error.kind === "rejected") {
      outcome = {
        kind: "rejected",
        observedAt: now,
        reason: dispatched.error.message,
      };
    } else {
      outcome = {
        kind: "ambiguous",
        observedAt: now,
        reason: dispatched.error.message,
      };
    }
    const transition = evolveOperation(
      commission,
      operation,
      lease,
      outcome,
      now,
    );
    if (!transition.ok)
      return { ok: false, error: { kind: "domain", error: transition.error } };
    const committed = this.#store.commitTransition(transition.value);
    return committed.ok
      ? { ok: true, value: transition.value.commission }
      : { ok: false, error: { kind: "store", error: committed.error } };
  }

  async #authorizedTransition(
    commissionId: string,
    now: number,
    make: (
      commission: Commission,
      lease: LeaseGrant,
    ) => ReturnType<typeof evolve>,
  ): Promise<Result<Commission, ApplicationError>> {
    const current = this.#load(commissionId);
    if (!current.ok) return current;
    const lease = await this.#currentLease(commissionId, now);
    if (!lease.ok) return lease;
    const transition = make(current.value, lease.value);
    if (!transition.ok)
      return { ok: false, error: { kind: "domain", error: transition.error } };
    return this.#commit(transition.value);
  }

  #load(commissionId: string): Result<Commission, ApplicationError> {
    const commission = this.#store.get(commissionId);
    return commission === null
      ? { ok: false, error: { kind: "not_found" } }
      : { ok: true, value: commission };
  }

  async #currentLease(
    commissionId: string,
    now: number,
  ): Promise<Result<LeaseGrant, ApplicationError>> {
    const result = await this.#lease.current(
      commissionId,
      this.#controllerId,
      now,
    );
    if (!result.ok)
      return { ok: false, error: { kind: "provider", error: result.error } };
    const parsed = ownerSchema.safeParse(result.value);
    if (
      parsed.success &&
      parsed.data.owner.controllerId !== this.#controllerId
    ) {
      return { ok: false, error: { kind: "ownership_unavailable" } };
    }
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, error: { kind: "ownership_unavailable" } };
  }

  #commit(
    transition: import("./domain").Transition,
  ): Result<Commission, ApplicationError> {
    if (transition.commission.version === transition.beforeVersion) {
      return { ok: true, value: transition.commission };
    }
    const result = this.#store.commitTransition(transition);
    return result.ok
      ? { ok: true, value: transition.commission }
      : { ok: false, error: { kind: "store", error: result.error } };
  }
}

function hasOwner(commission: Commission, lease: LeaseGrant): boolean {
  return (
    commission.owner?.controllerId === lease.owner.controllerId &&
    commission.owner.epoch === lease.owner.epoch
  );
}

function isPending(operation: Operation): boolean {
  return (
    operation.outcome.kind === "prepared" ||
    operation.outcome.kind === "submitted" ||
    operation.outcome.kind === "ambiguous" ||
    operation.outcome.kind === "retry_authorized"
  );
}
