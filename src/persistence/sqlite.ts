import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type {
  DecisionHistoryEntry,
  ReconciliationRecord,
} from "../operational";
import {
  isCommissionProposal,
  isDomainTransition,
  type Attempt,
  type Commission,
  type DeliveryEvidence,
  type Evidence,
  type Obligation,
  type Operation,
  type OperationOutcome,
  type Proposal,
  type Transition,
  type SteeringRequest,
} from "../domain";

const migrationList = [
  {
    version: 1,
    sql: readFileSync(
      fileURLToPath(new URL("./migrations/0001_core.sql", import.meta.url)),
      "utf8",
    ),
  },
  {
    version: 2,
    sql: readFileSync(
      fileURLToPath(
        new URL("./migrations/0002_runtime_operations.sql", import.meta.url),
      ),
      "utf8",
    ),
  },
  {
    version: 3,
    sql: readFileSync(
      fileURLToPath(
        new URL("./migrations/0003_criterion_versions.sql", import.meta.url),
      ),
      "utf8",
    ),
  },
  {
    version: 4,
    sql: readFileSync(
      fileURLToPath(
        new URL("./migrations/0004_watchdog_interrupt.sql", import.meta.url),
      ),
      "utf8",
    ),
  },
  {
    version: 5,
    sql: readFileSync(
      fileURLToPath(
        new URL("./migrations/0005_operational_views.sql", import.meta.url),
      ),
      "utf8",
    ),
  },
  {
    version: 6,
    sql: readFileSync(
      fileURLToPath(
        new URL("./migrations/0006_assignment_steering.sql", import.meta.url),
      ),
      "utf8",
    ),
  },
  {
    version: 7,
    sql: readFileSync(
      fileURLToPath(
        new URL("./migrations/0007_worker_boundary.sql", import.meta.url),
      ),
      "utf8",
    ),
  },
] as const;
const latestSchemaVersion = 7;
const commissionColumns = [
  "id",
  "campaign_id",
  "objective",
  "repository",
  "integration_target",
  "specification_generation",
  "independent_review_required",
  "lifecycle",
  "hold_reason",
  "owner_controller_id",
  "owner_epoch",
  "version",
  "active_attempt_id",
  "registered_pull_request_id",
  "max_attempts",
  "max_instructions",
  "max_repairs",
  "max_cost_micros",
  "deadline_at",
  "attempts_used",
  "instructions_used",
  "repairs_used",
  "cost_used_micros",
  "candidate_revision",
  "candidate_observed_at",
  "candidate_expires_at",
  "candidate_source",
  "delivered_revision",
  "delivered_provider_identity",
  "delivered_source",
  "delivered_observed_at",
  "delivered_expires_at",
  "delivered_check_run_id",
  "delivered_specification_generation",
  "workspace_writer",
] as const;

const commissionRow = z.object({
  workspace_writer: z.string().nullable(),
  id: z.string(),
  campaign_id: z.string(),
  objective: z.string(),
  repository: z.string(),
  integration_target: z.string(),
  specification_generation: z.number(),
  independent_review_required: z.number(),
  lifecycle: z.enum(["proposed", "admitted", "active", "held", "concluded"]),
  hold_reason: z.string().nullable(),
  owner_controller_id: z.string().nullable(),
  owner_epoch: z.number().nullable(),
  version: z.number(),
  active_attempt_id: z.string().nullable(),
  registered_pull_request_id: z.string().nullable(),
  max_attempts: z.number(),
  max_instructions: z.number(),
  max_repairs: z.number(),
  max_cost_micros: z.number(),
  deadline_at: z.number(),
  attempts_used: z.number(),
  instructions_used: z.number(),
  repairs_used: z.number(),
  cost_used_micros: z.number(),
  candidate_revision: z.string().nullable(),
  candidate_observed_at: z.number().nullable(),
  candidate_expires_at: z.number().nullable(),
  candidate_source: z.string().nullable(),
  delivered_revision: z.string().nullable(),
  delivered_provider_identity: z.string().nullable(),
  delivered_source: z.string().nullable(),
  delivered_observed_at: z.number().nullable(),
  delivered_expires_at: z.number().nullable(),
  delivered_check_run_id: z.string().nullable(),
  delivered_specification_generation: z.number().nullable(),
});
const obligationRow = z.object({
  id: z.string(),
  description: z.string(),
  independent_review_required: z.number(),
});
const attemptRow = z.object({
  id: z.string(),
  assignment_id: z.string(),
  ordinal: z.number(),
  strategy: z.string(),
  lifecycle: z.enum(["active", "superseded", "completed"]),
  next_instruction_sequence: z.number(),
});
const evidenceRow = z.object({
  id: z.string(),
  obligation_id: z.string(),
  specification_generation: z.number(),
  criterion_version: z.string(),
  candidate_revision: z.string(),
  source_kind: z.enum(["worker", "independent"]),
  source_identity: z.string(),
  disposition: z.enum(["submitted", "accepted", "challenged"]),
  observed_at: z.number(),
  expires_at: z.number(),
  claim: z.string(),
  check_run_id: z.string().nullable(),
});
const operationRow = z.object({
  id: z.string(),
  logical_key: z.string(),
  commission_id: z.string(),
  kind: z.enum([
    "bootstrap_worker",
    "steer",
    "provision_sandbox",
    "create_session",
    "interrupt",
    "continue",
    "repair",
    "refresh_context",
    "change_strategy",
    "verify",
    "integrate",
  ]),
  target: z.string(),
  controller_id: z.string(),
  owner_epoch: z.number(),
  specification_generation: z.number(),
  assignment_id: z.string(),
  attempt_id: z.string(),
  instruction_sequence: z.number(),
  candidate_revision: z.string().nullable(),
  directive: z.string(),
  created_at: z.number(),
  retry_count: z.number(),
  outcome_kind: z.enum([
    "prepared",
    "submitted",
    "ambiguous",
    "observed",
    "retry_authorized",
    "rejected",
  ]),
  outcome_at: z.number().nullable(),
  retry_authorized_at: z.number().nullable(),
  outcome_source: z.string().nullable(),
  outcome_result: z
    .enum(["accepted", "rejected", "applied", "not_applied"])
    .nullable(),
  external_identity: z.string().nullable(),
  outcome_reason: z.string().nullable(),
  retry_safe: z.number(),
  steering_request: z.string().nullable(),
});
const operationFindingRow = z.object({ finding_id: z.string() });

export type StoreError =
  | "untrusted_transition"
  | "untrusted_proposal"
  | "not_found"
  | "conflict"
  | "logical_operation_conflict";
export type StoreResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: StoreError };

class AbortTransaction extends Error {
  constructor(readonly storeError: StoreError) {
    super(storeError);
  }
}

export class CommissionStore {
  readonly #database: Database;

  constructor(path: string) {
    this.#database = new Database(path, { create: true, strict: true });
    this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.#migrate();
  }

  close(): void {
    this.#database.close();
  }

  get(commissionId: string): Commission | null {
    const raw = this.#database
      .query("SELECT * FROM commissions WHERE id = ?")
      .get(commissionId);
    if (raw === null || raw === undefined) return null;
    const row = commissionRow.parse(raw);
    const obligations = this.#database
      .query(
        "SELECT id, description, independent_review_required FROM obligations WHERE commission_id = ? AND specification_generation = ? ORDER BY id",
      )
      .all(commissionId, row.specification_generation)
      .map((item) => {
        const value = obligationRow.parse(item);
        return {
          id: value.id,
          description: value.description,
          independentReviewRequired: value.independent_review_required === 1,
        } satisfies Obligation;
      });
    const attempts = this.#database
      .query(
        "SELECT id, assignment_id, ordinal, strategy, lifecycle, next_instruction_sequence FROM attempts WHERE commission_id = ? ORDER BY ordinal",
      )
      .all(commissionId)
      .map((item) => {
        const value = attemptRow.parse(item);
        return {
          id: value.id,
          assignmentId: value.assignment_id,
          ordinal: value.ordinal,
          strategy: value.strategy,
          lifecycle: value.lifecycle,
          nextInstructionSequence: value.next_instruction_sequence,
        } satisfies Attempt;
      });
    const evidence = this.#database
      .query(
        "SELECT id, obligation_id, specification_generation, criterion_version, candidate_revision, source_kind, source_identity, disposition, observed_at, expires_at, claim, check_run_id FROM evidence WHERE commission_id = ? ORDER BY id",
      )
      .all(commissionId)
      .map((item) => {
        const value = evidenceRow.parse(item);
        return {
          id: value.id,
          obligationId: value.obligation_id,
          specificationGeneration: value.specification_generation,
          criterionVersion: value.criterion_version,
          candidateRevision: value.candidate_revision,
          source: { kind: value.source_kind, identity: value.source_identity },
          disposition: value.disposition,
          observedAt: value.observed_at,
          expiresAt: value.expires_at,
          claim: value.claim,
          checkRunId: value.check_run_id,
        } satisfies Evidence;
      });
    const owner =
      row.owner_controller_id === null || row.owner_epoch === null
        ? null
        : { controllerId: row.owner_controller_id, epoch: row.owner_epoch };
    return {
      workspaceWriter:
        row.workspace_writer === null
          ? null
          : (JSON.parse(row.workspace_writer) as Commission["workspaceWriter"]),
      id: row.id,
      campaignId: row.campaign_id,
      objective: row.objective,
      repository: row.repository,
      integrationTarget: row.integration_target,
      specificationGeneration: row.specification_generation,
      obligations,
      independentReviewRequired: row.independent_review_required === 1,
      lifecycle: row.lifecycle,
      holdReason: row.hold_reason,
      owner,
      version: row.version,
      attempts,
      activeAttemptId: row.active_attempt_id,
      registeredPullRequestId: row.registered_pull_request_id,
      budget: {
        limits: {
          maxAttempts: row.max_attempts,
          maxInstructions: row.max_instructions,
          maxRepairs: row.max_repairs,
          maxCostMicros: row.max_cost_micros,
          deadlineAt: row.deadline_at,
        },
        used: {
          attempts: row.attempts_used,
          instructions: row.instructions_used,
          repairs: row.repairs_used,
          costMicros: row.cost_used_micros,
        },
      },
      candidateRevision: row.candidate_revision,
      candidateObservedAt: row.candidate_observed_at,
      candidateExpiresAt: row.candidate_expires_at,
      candidateSource: row.candidate_source,
      deliveryEvidence:
        row.delivered_revision === null
          ? null
          : ({
              revision: row.delivered_revision,
              repository: row.repository,
              integrationTarget: row.integration_target,
              providerIdentity: required(row.delivered_provider_identity),
              source: required(row.delivered_source),
              observedAt: required(row.delivered_observed_at),
              expiresAt: required(row.delivered_expires_at),
              checkRunId: required(row.delivered_check_run_id),
              specificationGeneration: required(
                row.delivered_specification_generation,
              ),
            } satisfies DeliveryEvidence),
      evidence,
    };
  }

  list(): readonly Commission[] {
    const rows = this.#database
      .query("SELECT id FROM commissions ORDER BY id")
      .all() as { id: string }[];
    return rows.flatMap(({ id }) => {
      const commission = this.get(id);
      return commission === null ? [] : [commission];
    });
  }

  operations(commissionId: string): readonly Operation[] {
    const rows = this.#database
      .query(
        "SELECT * FROM operations WHERE commission_id = ? ORDER BY created_at, id",
      )
      .all(commissionId);
    return rows.map((raw) => {
      const row = operationRow.parse(raw);
      const findingIds = this.#database
        .query(
          "SELECT finding_id FROM operation_findings WHERE operation_id = ? ORDER BY finding_id",
        )
        .all(row.id)
        .map((item) => operationFindingRow.parse(item).finding_id);
      return {
        id: row.id,
        logicalKey: row.logical_key,
        commissionId: row.commission_id,
        kind: row.kind,
        target: row.target,
        controllerId: row.controller_id,
        ownerEpoch: row.owner_epoch,
        specificationGeneration: row.specification_generation,
        assignmentId: row.assignment_id,
        attemptId: row.attempt_id,
        instructionSequence: row.instruction_sequence,
        retryCount: row.retry_count,
        candidateRevision: row.candidate_revision,
        findingIds,
        directive: row.directive,
        createdAt: row.created_at,
        outcome: operationOutcome(row),
        ...(row.steering_request === null
          ? {}
          : {
              steering: JSON.parse(row.steering_request) as SteeringRequest & {
                principalId: string;
              },
            }),
      } satisfies Operation;
    });
  }

  reconciliation(commissionId: string): ReconciliationRecord | null {
    const row = this.#database
      .query("SELECT payload FROM reconciliation_views WHERE commission_id = ?")
      .get(commissionId) as { payload: string } | null;
    return row === null
      ? null
      : (JSON.parse(row.payload) as ReconciliationRecord);
  }

  decisionHistory(
    commissionId: string,
    beforeSequence?: number,
  ): readonly DecisionHistoryEntry[] {
    const rows = this.#database
      .query(
        "SELECT sequence, commission_version, recorded_at, result FROM decision_history WHERE commission_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT 100",
      )
      .all(commissionId, beforeSequence ?? Number.MAX_SAFE_INTEGER) as {
      sequence: number;
      commission_version: number;
      recorded_at: number;
      result: string;
    }[];
    return rows.map((row) => ({
      sequence: row.sequence,
      commissionVersion: row.commission_version,
      recordedAt: row.recorded_at,
      result: JSON.parse(row.result) as ReconciliationRecord["result"],
    }));
  }

  recordReconciliation(
    commissionId: string,
    record: ReconciliationRecord,
  ): boolean {
    // A late completion must never overwrite a newer controller's projection.
    // This derived record is deliberately separate from Commission versioning:
    // healthy polling still performs zero authoritative Commission UPDATEs.
    let recorded = false;
    this.#database
      .transaction(() => {
        const current = this.get(commissionId);
        if (current === null || current.version !== record.commissionVersion)
          return;
        const previous = this.reconciliation(commissionId);
        if (previous !== null && previous.recordedAt > record.recordedAt)
          return;
        if (JSON.stringify(previous) === JSON.stringify(record)) {
          recorded = true;
          return;
        }
        const result = JSON.stringify(record.result);
        if (
          previous === null ||
          JSON.stringify(previous.result) !== result ||
          previous.commissionVersion !== record.commissionVersion
        ) {
          this.#database
            .query(
              "INSERT INTO decision_history(commission_id, commission_version, recorded_at, result) VALUES (?, ?, ?, ?)",
            )
            .run(
              commissionId,
              record.commissionVersion,
              record.recordedAt,
              result,
            );
        }
        this.#database
          .query(
            "INSERT INTO reconciliation_views(commission_id, commission_version, recorded_at, payload) VALUES (?, ?, ?, ?) ON CONFLICT(commission_id) DO UPDATE SET commission_version = excluded.commission_version, recorded_at = excluded.recorded_at, payload = excluded.payload",
          )
          .run(
            commissionId,
            record.commissionVersion,
            record.recordedAt,
            JSON.stringify(record),
          );
        recorded = true;
      })
      .immediate();
    return recorded;
  }

  propose(proposal: Proposal): StoreResult<void> {
    if (!isCommissionProposal(proposal))
      return { ok: false, error: "untrusted_proposal" };
    const commission = proposal.commission;
    try {
      const insert = this.#database.transaction(() => {
        const exists = this.#database
          .query("SELECT 1 FROM commissions WHERE id = ?")
          .get(commission.id);
        if (exists !== null && exists !== undefined)
          throw new AbortTransaction("conflict");
        this.#insertCommission(commission);
        this.#insertObligations(commission);
      });
      insert.immediate();
      return { ok: true, value: undefined };
    } catch (cause) {
      if (cause instanceof AbortTransaction)
        return { ok: false, error: cause.storeError };
      throw cause;
    }
  }

  commitTransition(authorized: Transition): StoreResult<number> {
    if (!isDomainTransition(authorized))
      return { ok: false, error: "untrusted_transition" };
    try {
      let committedVersion: number | undefined;
      const commit = this.#database.transaction(() => {
        const current = this.get(authorized.commission.id);
        if (current === null) throw new AbortTransaction("not_found");
        if (
          current.version !== authorized.beforeVersion ||
          authorized.commission.version !== current.version + 1
        ) {
          throw new AbortTransaction("conflict");
        }
        for (const operation of authorized.newOperations) {
          const existing = this.#database
            .query("SELECT id FROM operations WHERE logical_key = ?")
            .get(operation.logicalKey);
          if (existing !== null && existing !== undefined)
            throw new AbortTransaction("logical_operation_conflict");
        }
        this.#writeCommission(authorized.commission, current.version);
        if (
          authorized.commission.specificationGeneration !==
          current.specificationGeneration
        ) {
          this.#insertObligations(authorized.commission);
        }
        this.#writeAttempts(authorized.commission);
        this.#insertEvidence(authorized.commission, current.evidence);
        this.#insertOperations(authorized.newOperations);
        this.#updateOperations(authorized.updatedOperations);
        committedVersion = authorized.commission.version;
      });
      commit.immediate();
      if (committedVersion === undefined)
        throw new Error("Transaction did not commit a Commission version");
      return { ok: true, value: committedVersion };
    } catch (cause) {
      if (cause instanceof AbortTransaction)
        return { ok: false, error: cause.storeError };
      throw cause;
    }
  }

  migrationVersion(): number {
    const row = this.#database
      .query("SELECT MAX(version) AS version FROM schema_migrations")
      .get();
    const parsed = z.object({ version: z.number().nullable() }).parse(row);
    return parsed.version ?? 0;
  }

  #migrate(): void {
    this.#database.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
    );
    const migrate = this.#database.transaction(() => {
      let applied = this.migrationVersion();
      if (applied > latestSchemaVersion) {
        throw new Error(
          `Database schema version ${applied} is newer than this runtime`,
        );
      }
      for (const migration of migrationList) {
        if (migration.version <= applied) continue;
        if (migration.version !== applied + 1)
          throw new Error(`Missing SQLite migration ${applied + 1}`);
        this.#database.exec(migration.sql);
        this.#database
          .query(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
          )
          .run(migration.version, Date.now());
        applied = migration.version;
      }
    });
    migrate.immediate();
  }

  #insertCommission(commission: Commission): void {
    this.#database
      .query(
        `INSERT INTO commissions (${commissionColumns.join(",")}) VALUES (${new Array(commissionColumns.length).fill("?").join(",")})`,
      )
      .run(...commissionValues(commission));
  }

  #writeCommission(commission: Commission, expectedVersion: number): void {
    const values = commissionValues(commission);
    const assignments = commissionColumns
      .slice(1)
      .map((column) => `${column} = ?`)
      .join(",");
    const result = this.#database
      .query(
        `UPDATE commissions SET ${assignments} WHERE id = ? AND version = ?`,
      )
      .run(...values.slice(1), commission.id, expectedVersion);
    // SQLite may include auxiliary trigger writes in the reported change
    // count. The version predicate is the CAS; only zero changed rows means
    // the expected Commission version was not updated.
    if (result.changes < 1) throw new AbortTransaction("conflict");
  }

  #insertObligations(commission: Commission): void {
    const insert = this.#database.query(
      "INSERT INTO obligations(commission_id, specification_generation, id, description, independent_review_required) VALUES (?, ?, ?, ?, ?)",
    );
    for (const item of commission.obligations)
      insert.run(
        commission.id,
        commission.specificationGeneration,
        item.id,
        item.description,
        Number(item.independentReviewRequired),
      );
  }

  #writeAttempts(commission: Commission): void {
    const insert = this.#database
      .query(`INSERT INTO attempts(commission_id, id, assignment_id, ordinal, strategy, lifecycle, next_instruction_sequence)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(commission_id, id) DO UPDATE SET
      strategy = excluded.strategy, lifecycle = excluded.lifecycle, next_instruction_sequence = excluded.next_instruction_sequence`);
    for (const attempt of commission.attempts)
      insert.run(
        commission.id,
        attempt.id,
        attempt.assignmentId,
        attempt.ordinal,
        attempt.strategy,
        attempt.lifecycle,
        attempt.nextInstructionSequence,
      );
  }

  #insertEvidence(commission: Commission, previous: readonly Evidence[]): void {
    const known = new Set(previous.map(({ id }) => id));
    const insert = this.#database.query(`INSERT INTO evidence(
      commission_id, id, obligation_id, specification_generation, criterion_version, candidate_revision, source_kind,
      source_identity, disposition, observed_at, expires_at, claim, check_run_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const evidence of commission.evidence) {
      if (known.has(evidence.id)) continue;
      insert.run(
        commission.id,
        evidence.id,
        evidence.obligationId,
        evidence.specificationGeneration,
        evidence.criterionVersion,
        evidence.candidateRevision,
        evidence.source.kind,
        evidence.source.identity,
        evidence.disposition,
        evidence.observedAt,
        evidence.expiresAt,
        evidence.claim,
        evidence.checkRunId,
      );
    }
  }

  #insertOperations(operations: readonly Operation[]): void {
    const insert = this.#database.query(`INSERT INTO operations(
      id, logical_key, commission_id, kind, target, controller_id, owner_epoch,
      specification_generation, assignment_id, attempt_id, instruction_sequence,
      candidate_revision, directive, created_at, retry_count, outcome_kind, outcome_at,
      retry_authorized_at, outcome_source, outcome_result, external_identity, outcome_reason, retry_safe, steering_request
    ) VALUES (${new Array(24).fill("?").join(",")})`);
    const insertFinding = this.#database.query(
      "INSERT INTO operation_findings(operation_id, finding_id) VALUES (?, ?)",
    );
    for (const operation of operations) {
      const row = outcomeValues(operation.outcome);
      insert.run(
        operation.id,
        operation.logicalKey,
        operation.commissionId,
        operation.kind,
        operation.target,
        operation.controllerId,
        operation.ownerEpoch,
        operation.specificationGeneration,
        operation.assignmentId,
        operation.attemptId,
        operation.instructionSequence,
        operation.candidateRevision,
        operation.directive,
        operation.createdAt,
        operation.retryCount,
        ...row,
        operation.steering === undefined
          ? null
          : JSON.stringify(operation.steering),
      );
      for (const findingId of operation.findingIds)
        insertFinding.run(operation.id, findingId);
    }
  }

  #updateOperations(operations: readonly Operation[]): void {
    const update = this.#database.query(
      `UPDATE operations SET retry_count = ?, outcome_kind = ?, outcome_at = ?, retry_authorized_at = ?, outcome_source = ?, outcome_result = ?, external_identity = ?, outcome_reason = ?, retry_safe = ? WHERE id = ? AND commission_id = ?`,
    );
    for (const operation of operations) {
      const result = update.run(
        operation.retryCount,
        ...outcomeValues(operation.outcome),
        operation.id,
        operation.commissionId,
      );
      if (result.changes !== 1) throw new AbortTransaction("not_found");
    }
  }
}

function commissionValues(commission: Commission): (string | number | null)[] {
  const delivery = commission.deliveryEvidence;
  return [
    commission.id,
    commission.campaignId,
    commission.objective,
    commission.repository,
    commission.integrationTarget,
    commission.specificationGeneration,
    Number(commission.independentReviewRequired),
    commission.lifecycle,
    commission.holdReason,
    commission.owner?.controllerId ?? null,
    commission.owner?.epoch ?? null,
    commission.version,
    commission.activeAttemptId,
    commission.registeredPullRequestId,
    commission.budget.limits.maxAttempts,
    commission.budget.limits.maxInstructions,
    commission.budget.limits.maxRepairs,
    commission.budget.limits.maxCostMicros,
    commission.budget.limits.deadlineAt,
    commission.budget.used.attempts,
    commission.budget.used.instructions,
    commission.budget.used.repairs,
    commission.budget.used.costMicros,
    commission.candidateRevision,
    commission.candidateObservedAt,
    commission.candidateExpiresAt,
    commission.candidateSource,
    delivery?.revision ?? null,
    delivery?.providerIdentity ?? null,
    delivery?.source ?? null,
    delivery?.observedAt ?? null,
    delivery?.expiresAt ?? null,
    delivery?.checkRunId ?? null,
    delivery?.specificationGeneration ?? null,
    commission.workspaceWriter === null
      ? null
      : JSON.stringify(commission.workspaceWriter),
  ];
}

function outcomeValues(outcome: OperationOutcome): (string | number | null)[] {
  switch (outcome.kind) {
    case "prepared":
      return ["prepared", null, null, null, null, null, null, 0];
    case "submitted":
      return [
        "submitted",
        outcome.submittedAt,
        null,
        null,
        null,
        null,
        null,
        0,
      ];
    case "ambiguous":
      return [
        "ambiguous",
        outcome.observedAt,
        null,
        null,
        null,
        null,
        outcome.reason,
        0,
      ];
    case "observed":
      return [
        "observed",
        outcome.observedAt,
        null,
        outcome.source,
        outcome.result,
        outcome.externalIdentity,
        null,
        Number(outcome.retrySafe),
      ];
    case "retry_authorized":
      return [
        "retry_authorized",
        outcome.observation.observedAt,
        outcome.authorizedAt,
        outcome.observation.source,
        outcome.observation.result,
        null,
        null,
        Number(outcome.observation.retrySafe),
      ];
    case "rejected":
      return [
        "rejected",
        outcome.observedAt,
        null,
        null,
        null,
        "rejected",
        outcome.reason,
        0,
      ];
    default:
      return exhaustive(outcome);
  }
}

function operationOutcome(row: z.infer<typeof operationRow>): OperationOutcome {
  switch (row.outcome_kind) {
    case "prepared":
      return { kind: "prepared" };
    case "submitted":
      return { kind: "submitted", submittedAt: required(row.outcome_at) };
    case "ambiguous":
      return {
        kind: "ambiguous",
        observedAt: required(row.outcome_at),
        reason: required(row.outcome_reason),
      };
    case "observed":
      return {
        kind: "observed",
        observedAt: required(row.outcome_at),
        source: required(row.outcome_source),
        result: required(row.outcome_result),
        retrySafe: row.retry_safe === 1,
        externalIdentity: row.external_identity,
      };
    case "retry_authorized":
      if (row.retry_safe !== 1)
        throw new Error("Corrupt retry authorization without safe observation");
      return {
        kind: "retry_authorized",
        authorizedAt: required(row.retry_authorized_at),
        observation: {
          observedAt: required(row.outcome_at),
          source: required(row.outcome_source),
          result: "not_applied",
          retrySafe: true,
        },
      };
    case "rejected":
      return {
        kind: "rejected",
        observedAt: required(row.outcome_at),
        reason: required(row.outcome_reason),
      };
    default:
      return exhaustive(row.outcome_kind);
  }
}

function required<T>(value: T | null): T {
  if (value === null) throw new Error("Corrupt Operation outcome row");
  return value;
}

function exhaustive(value: never): never {
  throw new Error(`Unhandled persisted variant: ${JSON.stringify(value)}`);
}
