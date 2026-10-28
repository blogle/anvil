import type {
  ProviderFailure,
  ProviderPort,
  ProviderResult,
} from "../application";
import type {
  Commission,
  Observation,
  Operation,
  OperationOutcome,
} from "../domain";
import { AgentSandboxClient, type SandboxIntent } from "./agent-sandbox";
import { GitHubDeliveryClient } from "./github-delivery";
import { OpenCodeAdapter } from "./opencode";

export type WorldObservationPort = Readonly<{
  observe(
    commission: Commission,
    now: number,
  ): Promise<ProviderResult<Omit<Observation, "execution">>>;
}>;

export type ProviderCompositionConfig = Readonly<{
  sandbox: AgentSandboxClient;
  world: WorldObservationPort;
  openCodeForSandbox: (sandboxResourceName: string) => OpenCodeAdapter;
  sandboxIntent: (commission: Commission) => SandboxIntent;
  github?: GitHubDeliveryClient;
  workBranch?: (commission: Commission) => string;
  model: Readonly<{ providerId: string; modelId: string }>;
}>;

type RuntimeBinding = Readonly<{
  sandboxResourceName: string;
  openCodeSessionId: string | null;
}>;

export class ProviderComposition implements ProviderPort {
  readonly #config: ProviderCompositionConfig;
  readonly #bindings = new Map<string, RuntimeBinding>();

  constructor(config: ProviderCompositionConfig) {
    this.#config = config;
  }

  async observe(
    commission: Commission,
    now: number,
    operations: readonly Operation[],
  ): Promise<ProviderResult<Observation>> {
    const world = await this.#config.world.observe(commission, now);
    if (!world.ok) return world;

    const sandboxOperation = completedOperation(
      commission.id,
      operations,
      "provision_sandbox",
    );
    if (sandboxOperation === null) {
      this.#bindings.delete(commission.id);
      return {
        ok: true,
        value: {
          ...world.value,
          execution: {
            kind: "unknown",
            reason: "Sandbox provisioning has not completed",
            observedAt: now,
            expiresAt: now + 1_000,
            source: "anvil-provider-composition",
          },
        },
      };
    }
    const sandboxResourceName = sandboxOperation.outcome.externalIdentity;
    if (sandboxResourceName === null)
      return {
        ok: false,
        error: {
          kind: "unavailable",
          message: "Provisioned Sandbox Operation has no resource identity",
        },
      };
    const sandbox = await this.#config.sandbox.inspectIntent(
      this.#config.sandboxIntent(commission),
    );
    if (!sandbox.ok) {
      if (sandbox.error.kind === "not_found") {
        this.#bindings.set(commission.id, {
          sandboxResourceName,
          openCodeSessionId: null,
        });
        return {
          ok: true,
          value: {
            ...world.value,
            execution: {
              kind: "unavailable",
              reason: "Previously provisioned Sandbox is not observable",
              observedAt: now,
              expiresAt: now + 1_000,
              source: "agent-sandbox",
            },
          },
        };
      }
      return { ok: false, error: sandboxFailure(sandbox.error) };
    }
    if (sandbox.value.name !== sandboxResourceName)
      return {
        ok: false,
        error: {
          kind: "unavailable",
          message:
            "Observed Sandbox identity differs from the recorded Operation",
        },
      };
    const sessionOperation = completedOperation(
      commission.id,
      operations,
      "create_session",
      `opencode:${sandboxResourceName}`,
    );
    const openCodeSessionId =
      sessionOperation?.outcome.externalIdentity ?? null;
    this.#bindings.set(commission.id, {
      sandboxResourceName,
      openCodeSessionId,
    });
    if (sandbox.value.environmentState !== "ready") {
      return {
        ok: true,
        value: {
          ...world.value,
          execution: {
            kind: "unavailable",
            reason: `Sandbox is ${sandbox.value.environmentState}`,
            observedAt: now,
            expiresAt: now + 1_000,
            source: "agent-sandbox",
          },
        },
      };
    }
    if (openCodeSessionId === null) {
      return {
        ok: true,
        value: {
          ...world.value,
          execution: {
            kind: "idle",
            sessionId: "unbound-opencode-session",
            observedAt: now,
            expiresAt: now + 1_000,
            source: "agent-sandbox",
          },
        },
      };
    }
    const openCode = this.#config.openCodeForSandbox(sandboxResourceName);
    const active = await openCode.activeSessions();
    if (!active.ok) return active;
    const isRunning = active.value.some(({ id }) => id === openCodeSessionId);
    return {
      ok: true,
      value: {
        ...world.value,
        execution: isRunning
          ? {
              kind: "running",
              sessionId: openCodeSessionId,
              contextPressure: false,
              repeatedToolFailures: [],
              observedAt: now,
              expiresAt: now + 1_000,
              source: "opencode-v2",
            }
          : {
              kind: "idle",
              sessionId: openCodeSessionId,
              observedAt: now,
              expiresAt: now + 1_000,
              source: "opencode-v2",
            },
      },
    };
  }

  async dispatch(
    commission: Commission,
    operation: Operation,
  ): Promise<ProviderResult<Exclude<OperationOutcome, { kind: "prepared" }>>> {
    if (operation.kind === "provision_sandbox") {
      const result = await this.#config.sandbox.create(
        this.#config.sandboxIntent(commission),
      );
      if (!result.ok) return { ok: false, error: sandboxFailure(result.error) };
      return {
        ok: true,
        value: {
          kind: "observed",
          observedAt: Date.now(),
          source: "agent-sandbox-v1beta1",
          result: "applied",
          retrySafe: false,
          externalIdentity: result.value.name,
        },
      };
    }
    if (operation.kind === "create_session") {
      const sandboxResourceName = operation.target.slice("opencode:".length);
      if (sandboxResourceName.length === 0)
        return rejected("OpenCode Session Operation has no Sandbox identity");
      const result = await this.#config
        .openCodeForSandbox(sandboxResourceName)
        .createSession();
      if (!result.ok) return result;
      this.#bindings.set(commission.id, {
        sandboxResourceName,
        openCodeSessionId: result.value.id,
      });
      return {
        ok: true,
        value: {
          kind: "observed",
          observedAt: Date.now(),
          source: "opencode-v2",
          result: "applied",
          retrySafe: false,
          externalIdentity: result.value.id,
        },
      };
    }
    if (
      operation.kind === "continue" ||
      operation.kind === "repair" ||
      operation.kind === "refresh_context" ||
      operation.kind === "change_strategy"
    ) {
      const binding = this.#bindings.get(commission.id);
      if (binding?.openCodeSessionId === null || binding === undefined)
        return rejected(
          "No observed OpenCode Session is bound to the Commission",
        );
      return this.#config
        .openCodeForSandbox(binding.sandboxResourceName)
        .dispatchInstruction(
          binding.openCodeSessionId,
          operation,
          this.#config.model,
        )
        .then((result) =>
          result.ok
            ? {
                ok: true,
                value: {
                  kind: "observed",
                  observedAt: Date.now(),
                  source: "opencode-v2",
                  result: "applied",
                  retrySafe: false,
                  externalIdentity: result.value.messageId,
                },
              }
            : result,
        );
    }
    if (operation.kind === "integrate") {
      if (
        this.#config.github === undefined ||
        this.#config.workBranch === undefined
      )
        return rejected("GitHub pull request integration is not configured");
      const pullRequest = await this.#config.github.createOrFindPullRequest({
        repositoryUrl: commission.repository,
        headRef: this.#config.workBranch(commission),
        baseRef: commission.integrationTarget,
        title: commission.objective,
        body: `Anvil Commission ${commission.id}\nCandidate ${operation.candidateRevision ?? "unknown"}`,
      });
      if (!pullRequest.ok)
        return { ok: false, error: githubFailure(pullRequest.error) };
      return {
        ok: true,
        value: {
          kind: "observed",
          observedAt: Date.now(),
          source: "github-pull-request-rest",
          result: "accepted",
          retrySafe: false,
          externalIdentity: pullRequest.value.url,
        },
      };
    }
    return rejected(
      `${operation.kind} is not configured in this provider composition`,
    );
  }

  async inspectOperation(
    commission: Commission,
    operation: Operation,
  ): Promise<ProviderResult<OperationOutcome | null>> {
    if (operation.kind === "provision_sandbox") {
      const result = await this.#config.sandbox.inspectIntent(
        this.#config.sandboxIntent(commission),
      );
      if (result.ok)
        return {
          ok: true,
          value: {
            kind: "observed",
            observedAt: Date.now(),
            source: "agent-sandbox-v1beta1-inspection",
            result: "applied",
            retrySafe: false,
            externalIdentity: result.value.name,
          },
        };
      if (result.error.kind === "not_found") return { ok: true, value: null };
      return { ok: false, error: sandboxFailure(result.error) };
    }
    if (operation.kind === "create_session") {
      // V2 session creation has no caller-selected durable ID. A lost create
      // acknowledgement therefore stays unknown instead of creating another.
      return { ok: true, value: null };
    }
    if (
      operation.kind === "continue" ||
      operation.kind === "repair" ||
      operation.kind === "refresh_context" ||
      operation.kind === "change_strategy"
    ) {
      const binding = this.#bindings.get(commission.id);
      if (binding?.openCodeSessionId === null || binding === undefined)
        return { ok: true, value: null };
      return this.#config
        .openCodeForSandbox(binding.sandboxResourceName)
        .inspectInstruction(binding.openCodeSessionId, operation);
    }
    if (
      operation.kind === "integrate" &&
      this.#config.github !== undefined &&
      this.#config.workBranch !== undefined
    ) {
      const pullRequest = await this.#config.github.findPullRequestByHead(
        commission.repository,
        this.#config.workBranch(commission),
        commission.integrationTarget,
      );
      if (!pullRequest.ok)
        return { ok: false, error: githubFailure(pullRequest.error) };
      if (
        pullRequest.value === null ||
        pullRequest.value.headSha !== operation.candidateRevision
      ) {
        return { ok: true, value: null };
      }
      return {
        ok: true,
        value: {
          kind: "observed",
          observedAt: Date.now(),
          source: "github-pull-request-inspection",
          result: "accepted",
          retrySafe: false,
          externalIdentity: pullRequest.value.url,
        },
      };
    }
    return { ok: true, value: null };
  }
}

function completedOperation(
  commissionId: string,
  operations: readonly Operation[],
  kind: "provision_sandbox" | "create_session",
  target?: string,
):
  | (Operation & { outcome: Extract<OperationOutcome, { kind: "observed" }> })
  | null {
  return (
    operations.find(
      (
        item,
      ): item is Operation & {
        outcome: Extract<OperationOutcome, { kind: "observed" }>;
      } =>
        item.commissionId === commissionId &&
        item.kind === kind &&
        (target === undefined || item.target === target) &&
        item.outcome.kind === "observed" &&
        item.outcome.result === "applied" &&
        item.outcome.externalIdentity !== null,
    ) ?? null
  );
}

function sandboxFailure(error: {
  kind: string;
  message: string;
}): ProviderFailure {
  return error.kind === "ambiguous"
    ? { kind: "acknowledgement_lost", message: error.message }
    : error.kind === "rejected" || error.kind === "conflict"
      ? { kind: "rejected", message: error.message }
      : { kind: "unavailable", message: error.message };
}

function githubFailure(error: {
  kind: string;
  message: string;
}): ProviderFailure {
  return error.kind === "ambiguous"
    ? { kind: "acknowledgement_lost", message: error.message }
    : error.kind === "credentials" ||
        error.kind === "rejected" ||
        error.kind === "conflict"
      ? { kind: "rejected", message: error.message }
      : { kind: "unavailable", message: error.message };
}

function rejected(message: string): ProviderResult<never> {
  return { ok: false, error: { kind: "rejected", message } };
}
