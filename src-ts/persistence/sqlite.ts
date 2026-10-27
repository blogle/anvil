import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  commissionSchema,
  decideCommission,
  operationMatchesDecision,
  operationSchema,
  type Commission,
  type Operation,
} from "../domain";

const migration = readFileSync(
  fileURLToPath(new URL("./migrations/0001_initial.sql", import.meta.url)),
  "utf8",
);

export class CommissionStore {
  readonly #database: Database;

  constructor(path: string) {
    this.#database = new Database(path, { create: true, strict: true });
    this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.#database.exec(migration);
    this.#database
      .query(
        "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, datetime('now'))",
      )
      .run();
  }

  close(): void {
    this.#database.close();
  }

  create(commission: Commission): boolean {
    const parsed = commissionSchema.parse(commission);
    if (parsed.lifecycle === "concluded") {
      throw new Error(
        "A Commission must be admitted and reconciled before conclusion",
      );
    }
    if (parsed.operations.length > 0) {
      throw new Error(
        "Create the Commission before authorizing external Operations",
      );
    }
    const transaction = this.#database.transaction(() => {
      const result = this.#database
        .query(
          "INSERT OR IGNORE INTO commissions(id, generation, document, updated_at) VALUES (?, ?, ?, datetime('now'))",
        )
        .run(parsed.id, parsed.generation, JSON.stringify(parsed));
      if (result.changes !== 1) return false;
      this.#writeOperations(parsed.id, parsed.operations);
      return true;
    });
    return transaction();
  }

  get(commissionId: string): Commission | null {
    const row = this.#database
      .query("SELECT document FROM commissions WHERE id = ?")
      .get(commissionId);
    if (row === null) return null;
    const document = rowDocumentSchema.parse(row).document;
    return commissionSchema.parse(JSON.parse(document));
  }

  save(commission: Commission, expectedGeneration: number): boolean {
    return this.#saveCommission(commission, expectedGeneration);
  }

  conclude(
    commissionId: string,
    expectedGeneration: number,
    now: number,
  ): Commission | null {
    const current = this.get(commissionId);
    if (current === null || current.generation !== expectedGeneration)
      return null;
    const decision = decideCommission(current, now);
    if (decision.kind !== "conclude") return null;
    const concluded: Commission = {
      ...current,
      generation: current.generation + 1,
      lifecycle: "concluded",
    };
    return this.#saveCommission(concluded, expectedGeneration, undefined, true)
      ? concluded
      : null;
  }

  #saveCommission(
    commission: Commission,
    expectedGeneration: number,
    authorizedNewOperationId?: string,
    authorizedConclusion = false,
  ): boolean {
    const parsed = commissionSchema.parse(commission);
    if (parsed.generation !== expectedGeneration + 1) {
      throw new Error("A Commission save must advance exactly one generation");
    }
    const transaction = this.#database.transaction(() => {
      const current = this.get(parsed.id);
      if (current === null || current.generation !== expectedGeneration)
        return false;
      assertMonotonicUpdate(
        current,
        parsed,
        authorizedNewOperationId,
        authorizedConclusion,
      );
      const result = this.#database
        .query(
          "UPDATE commissions SET generation = ?, document = ?, updated_at = datetime('now') WHERE id = ? AND generation = ?",
        )
        .run(
          parsed.generation,
          JSON.stringify(parsed),
          parsed.id,
          expectedGeneration,
        );
      if (result.changes !== 1) return false;
      this.#database
        .query("DELETE FROM operations WHERE commission_id = ?")
        .run(parsed.id);
      this.#writeOperations(parsed.id, parsed.operations);
      return true;
    });
    return transaction();
  }

  prepareOperation(
    commissionId: string,
    expectedGeneration: number,
    operation: Operation,
    authorizedAt: number,
  ): Commission | null {
    const parsedOperation = operationSchema.parse(operation);
    if (parsedOperation.state.kind !== "prepared") {
      throw new Error(
        "An external Operation must be persisted as prepared before submission",
      );
    }
    const current = this.get(commissionId);
    if (current === null) return null;
    const previous = current.operations.find(
      ({ id }) => id === parsedOperation.id,
    );
    if (previous !== undefined) {
      return previous.state.kind === "prepared" &&
        JSON.stringify(previous) === JSON.stringify(parsedOperation)
        ? current
        : null;
    }
    if (current.generation !== expectedGeneration) return null;
    if (parsedOperation.authorizedGeneration !== expectedGeneration) {
      throw new Error(
        "Operation precondition does not match the current Commission generation",
      );
    }
    if (
      parsedOperation.assignmentId !== current.assignmentId ||
      parsedOperation.attemptId !== current.attempt.id
    ) {
      throw new Error(
        "Operation is outside the current Assignment and Attempt",
      );
    }
    if (
      current.owner === null ||
      current.owner.leaseExpiresAt <= authorizedAt
    ) {
      throw new Error(
        "Cannot authorize an Operation without current Commission ownership",
      );
    }
    const decision = decideCommission(current, authorizedAt);
    if (!operationMatchesDecision(decision, parsedOperation)) {
      throw new Error(
        `Operation ${parsedOperation.kind} is not authorized by the current ${decision.kind} decision`,
      );
    }
    const next: Commission = {
      ...current,
      generation: current.generation + 1,
      operations: [...current.operations, parsedOperation],
    };
    return this.#saveCommission(next, expectedGeneration, parsedOperation.id)
      ? next
      : null;
  }

  #writeOperations(commissionId: string, operations: Operation[]): void {
    const insert = this.#database.query(
      "INSERT INTO operations(id, commission_id, kind, target, state, document, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const operation of operations) {
      insert.run(
        operation.id,
        commissionId,
        operation.kind,
        operation.target,
        operation.state.kind,
        JSON.stringify(operation),
        operation.createdAt,
      );
    }
  }
}

const rowDocumentSchema = z.object({ document: z.string() });

function assertMonotonicUpdate(
  previous: Commission,
  next: Commission,
  authorizedNewOperationId?: string,
  authorizedConclusion = false,
): void {
  if (
    previous.lifecycle !== next.lifecycle &&
    (!authorizedConclusion || next.lifecycle !== "concluded")
  ) {
    throw new Error(
      "Commission lifecycle changes require their authorized application operation",
    );
  }
  const oldBudget = previous.budget;
  const newBudget = next.budget;
  if (
    oldBudget.maxAttempts !== newBudget.maxAttempts ||
    oldBudget.maxRepairs !== newBudget.maxRepairs ||
    oldBudget.costLimitMicros !== newBudget.costLimitMicros ||
    oldBudget.deadlineAt !== newBudget.deadlineAt ||
    newBudget.attemptsUsed < oldBudget.attemptsUsed ||
    newBudget.repairsUsed < oldBudget.repairsUsed ||
    newBudget.costUsedMicros < oldBudget.costUsedMicros
  ) {
    throw new Error(
      "Commission budget limits are immutable and usage cannot decrease",
    );
  }

  for (const oldOperation of previous.operations) {
    const newOperation = next.operations.find(
      ({ id }) => id === oldOperation.id,
    );
    if (newOperation === undefined) {
      throw new Error(
        "A durable Operation cannot be removed from Commission history",
      );
    }
    const oldIntent = { ...oldOperation, state: null };
    const newIntent = { ...newOperation, state: null };
    if (JSON.stringify(oldIntent) !== JSON.stringify(newIntent)) {
      throw new Error(
        "A durable Operation identity, target, or precondition cannot change",
      );
    }
    if (
      oldOperation.state.kind === newOperation.state.kind &&
      JSON.stringify(oldOperation.state) !== JSON.stringify(newOperation.state)
    ) {
      throw new Error("An Operation state observation cannot be rewritten");
    }
    const previousState = oldOperation.state.kind;
    const nextState = newOperation.state.kind;
    const allowed =
      previousState === nextState ||
      (previousState === "prepared" && nextState !== "prepared") ||
      (previousState === "submitted" &&
        ["ambiguous", "observed", "rejected"].includes(nextState)) ||
      (previousState === "ambiguous" &&
        ["observed", "rejected"].includes(nextState));
    if (!allowed)
      throw new Error(
        `Invalid Operation state transition: ${previousState} -> ${nextState}`,
      );
  }
  const addedOperations = next.operations.filter(
    ({ id }) =>
      !previous.operations.some((oldOperation) => oldOperation.id === id),
  );
  if (
    addedOperations.length !==
      (authorizedNewOperationId === undefined ? 0 : 1) ||
    addedOperations.some(
      (operation) =>
        operation.id !== authorizedNewOperationId ||
        operation.state.kind !== "prepared",
    )
  ) {
    throw new Error(
      "New external Operations must pass through authorization and preparation",
    );
  }
}
