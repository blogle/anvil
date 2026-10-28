import type {
  Commission,
  LeaseGrant,
  Observation,
  Operation,
  OperationOutcome,
} from "../../src/domain";
import type {
  AuthorizationPort,
  LeasePort,
  ProviderPort,
  ProviderResult,
} from "../../src/application";
import { epoch } from "./fixtures";

export class FakeWorld implements LeasePort, ProviderPort, AuthorizationPort {
  grant: LeaseGrant = {
    owner: { controllerId: "controller-1", epoch: 1 },
    resourceVersion: "lease-rv-1",
    observedAt: epoch,
    validUntil: epoch + 3_600_000,
  };
  revision: string | null = null;
  executionKind: "idle" | "running" = "idle";
  claims = new Map<string, string>();
  checks: Observation["checks"] = null;
  integration: Observation["integration"] = { kind: "none" };
  verificationCount = 0;
  loseRepairAcknowledgement = true;
  reportFirstInstructionNotApplied = false;
  unknownRecovery = false;
  readonly dispatchCount = new Map<string, number>();
  readonly dispatchKinds: string[] = [];
  readonly sideEffects = new Map<string, OperationOutcome>();

  async approve(request: Readonly<{ principalId: string }>): Promise<boolean> {
    return request.principalId === "operator-1";
  }

  async current(
    _commissionId: string,
    controllerId: string,
    now: number,
  ): Promise<ProviderResult<LeaseGrant>> {
    if (controllerId !== this.grant.owner.controllerId) {
      return {
        ok: false,
        error: {
          kind: "unavailable",
          message: "controller does not hold the Lease",
        },
      };
    }
    return { ok: true, value: { ...this.grant, observedAt: now } };
  }

  async observe(
    commission: Commission,
    now: number,
  ): Promise<ProviderResult<Observation>> {
    return {
      ok: true,
      value: {
        candidateRevision: this.revision,
        candidateObservedAt: now,
        candidateExpiresAt: now + 30_000,
        candidateSource: "fake-git",
        execution:
          this.executionKind === "idle"
            ? {
                kind: "idle",
                sessionId: "session-1",
                observedAt: now,
                expiresAt: now + 30_000,
                source: "fake-opencode",
              }
            : {
                kind: "running",
                sessionId: "session-1",
                contextPressure: false,
                repeatedToolFailures: [],
                observedAt: now,
                expiresAt: now + 30_000,
                source: "fake-opencode",
              },
        checks:
          this.checks === null
            ? null
            : { ...this.checks, observedAt: now, expiresAt: now + 30_000 },
        integration:
          this.integration.kind === "none"
            ? this.integration
            : {
                ...this.integration,
                repository: commission.repository,
                target: commission.integrationTarget,
                observedAt: now,
                expiresAt: now + 30_000,
              },
        workerClaims:
          this.revision === null
            ? []
            : [...this.claims]
                .filter(([revision]) => revision === this.revision)
                .map(([revision, claim]) => ({
                  id: `worker-claim:${revision}`,
                  obligationId: "acceptance-1",
                  claim,
                  observedAt: now,
                  expiresAt: now + 30_000,
                  sourceIdentity: "session-1",
                })),
        independentReviews: [],
      },
    };
  }

  async dispatch(
    operation: Operation,
  ): Promise<ProviderResult<Exclude<OperationOutcome, { kind: "prepared" }>>> {
    const count = (this.dispatchCount.get(operation.id) ?? 0) + 1;
    this.dispatchCount.set(operation.id, count);
    this.dispatchKinds.push(operation.kind);
    if (
      operation.kind === "continue" &&
      this.reportFirstInstructionNotApplied
    ) {
      this.reportFirstInstructionNotApplied = false;
      const notApplied: OperationOutcome = {
        kind: "observed",
        observedAt: epoch + count,
        source: "fake-opencode-inspection",
        result: "not_applied",
        retrySafe: true,
        externalIdentity: null,
      };
      this.sideEffects.set(operation.id, notApplied);
      return { ok: true, value: notApplied };
    }
    const effect: OperationOutcome = {
      kind: "observed",
      observedAt: epoch + count,
      source: `fake-${operation.kind}`,
      result: operation.kind === "integrate" ? "accepted" : "applied",
      retrySafe: false,
      externalIdentity:
        operation.kind === "integrate" ? "github:repo/pull/1" : null,
    };

    switch (operation.kind) {
      case "continue":
        this.revision ??= "revision-1";
        this.claims.set(
          this.revision,
          "Implemented current Commission obligations",
        );
        break;
      case "verify":
        this.verificationCount += 1;
        this.checks =
          this.revision === "revision-1"
            ? {
                runId: "check-run-fail",
                revision: this.revision,
                state: "failing",
                failureIds: ["lint:E42"],
                observedAt: epoch,
                expiresAt: epoch + 30_000,
                source: "fake-ci",
              }
            : {
                runId: "check-run-pending",
                revision: this.revision ?? "",
                state: "pending",
                failureIds: [],
                observedAt: epoch,
                expiresAt: epoch + 30_000,
                source: "fake-ci",
              };
        break;
      case "repair":
        this.revision = "revision-2";
        this.claims.set(
          this.revision,
          "Repaired lint:E42 and retained behavior",
        );
        this.checks = null;
        this.sideEffects.set(operation.id, effect);
        if (this.loseRepairAcknowledgement) {
          this.loseRepairAcknowledgement = false;
          return {
            ok: false,
            error: {
              kind: "acknowledgement_lost",
              message: "simulated lost acknowledgement after applying repair",
            },
          };
        }
        break;
      case "integrate":
        this.integration = {
          kind: "queued",
          revision: operation.candidateRevision ?? "",
          providerIdentity: "github:repo/pull/1",
          repository: "https://github.com/example/repository",
          target: "main",
          observedAt: epoch,
          expiresAt: epoch + 30_000,
          source: "fake-mergify",
        };
        break;
      case "refresh_context":
      case "change_strategy":
        break;
      default:
        return exhaustive(operation.kind);
    }
    this.sideEffects.set(operation.id, effect);
    return { ok: true, value: effect };
  }

  async inspectOperation(
    operation: Operation,
  ): Promise<ProviderResult<OperationOutcome | null>> {
    if (this.unknownRecovery) return { ok: true, value: null };
    return { ok: true, value: this.sideEffects.get(operation.id) ?? null };
  }

  completePendingCheck(): void {
    if (this.checks?.state !== "pending")
      throw new Error("No pending check run to complete");
    this.checks = { ...this.checks, state: "passing" };
  }

  mergeCandidate(): void {
    if (this.revision === null) throw new Error("No Candidate to merge");
    this.integration = {
      kind: "merged",
      revision: this.revision,
      providerIdentity: "github:repo/pull/1",
      repository: "https://github.com/example/repository",
      target: "main",
      observedAt: epoch,
      expiresAt: epoch + 30_000,
      source: "fake-github",
    };
  }
}

function exhaustive(value: never): never {
  throw new Error(`Unknown fake provider Operation: ${value satisfies string}`);
}
