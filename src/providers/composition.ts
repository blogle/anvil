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
  WorkerClaim,
} from "../domain";
import { AgentSandboxClient, type SandboxIntent } from "./agent-sandbox";
import { GitHubDeliveryClient } from "./github-delivery";
import { OpenCodeAdapter } from "./opencode";
import type { WorkerBootstrap } from "./worker-bootstrap";

export type WorldObservationPort = Readonly<{
  observe(
    commission: Commission,
    now: number,
  ): Promise<ProviderResult<Omit<Observation, "execution">>>;
}>;

export type ProviderCompositionConfig = Readonly<{
  workerBootstrap?: WorkerBootstrap;
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
  readonly #openCodeAdapters = new Map<string, OpenCodeAdapter>();
  readonly #executionVersions = new Map<string, number>();
  readonly #executionListeners = new Set<(commissionId: string) => void>();
  readonly #executionWatchers = new Map<
    string,
    Readonly<{ sessionId: string; controller: AbortController }>
  >();

  constructor(config: ProviderCompositionConfig) {
    this.#config = config;
  }

  async validateWorkerBinding(
    commission: Commission,
    scope: import("../application").WorkerGitCapabilityScope,
  ): Promise<boolean> {
    const workspace = await this.#config.sandbox.inspectIntent(
      this.#config.sandboxIntent(commission),
    );
    if (
      !workspace.ok ||
      workspace.value.name !== scope.workspaceId ||
      workspace.value.environmentState !== "ready"
    )
      return false;
    const session = await this.#openCode(scope.workspaceId).sessionExists(
      scope.sessionId,
    );
    if (!session.ok || !session.value) return false;
    const active = await this.#openCode(scope.workspaceId).activeSessions();
    return active.ok && active.value.every(({ id }) => id === scope.sessionId);
  }

  subscribeExecutionEvents(
    onCommission: (commissionId: string) => void,
  ): () => void {
    this.#executionListeners.add(onCommission);
    for (const [commissionId, binding] of this.#bindings) {
      if (binding.openCodeSessionId !== null)
        this.#ensureExecutionWatcher(
          commissionId,
          binding.sandboxResourceName,
          binding.openCodeSessionId,
        );
    }
    return () => {
      this.#executionListeners.delete(onCommission);
      if (this.#executionListeners.size === 0) {
        for (const watcher of this.#executionWatchers.values())
          watcher.controller.abort();
        this.#executionWatchers.clear();
      }
    };
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
      this.#executionVersions.delete(commission.id);
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
      this.#stopExecutionWatcher(commission.id);
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
    this.#ensureExecutionWatcher(
      commission.id,
      sandboxResourceName,
      openCodeSessionId,
    );
    const execution = await this.#openCode(
      sandboxResourceName,
    ).observeExecution(
      openCodeSessionId,
      now,
      this.#config.model,
      this.#executionVersions.get(commission.id) !== commission.version ||
        operations.some(
          (operation) =>
            operation.kind === "steer" && operation.outcome.kind === "prepared",
        ),
    );
    this.#executionVersions.set(commission.id, commission.version);
    const messages =
      await this.#openCode(sandboxResourceName).messages(openCodeSessionId);
    if (!messages.ok) return messages;
    const active = await this.#openCode(sandboxResourceName).activeSessions();
    if (!active.ok) return active;
    const foreign = active.value
      .filter(({ id }) => id !== openCodeSessionId)
      .map(({ id }) => id);
    return {
      ok: true,
      value: {
        ...world.value,
        execution,
        ...(foreign.length === 0
          ? {}
          : {
              workspaceConflict: {
                workspaceId: sandboxResourceName,
                sessionIds: foreign,
                source: "opencode-active-sessions",
              },
            }),
        workerClaims: [
          ...world.value.workerClaims,
          ...workerClaimsFromMessages(
            commission,
            openCodeSessionId,
            world.value.candidateRevision,
            messages.value,
            now,
            now + 60_000,
          ),
        ],
      },
    };
  }

  async dispatch(
    commission: Commission,
    operation: Operation,
    now: number,
    authorizeEffect?: () => Promise<boolean>,
  ): Promise<ProviderResult<Exclude<OperationOutcome, { kind: "prepared" }>>> {
    if (operation.kind === "bootstrap_worker") {
      const binding = this.#bindings.get(commission.id);
      if (
        !binding?.openCodeSessionId ||
        this.#config.workerBootstrap === undefined
      )
        return rejected(
          "Secure worker bootstrap transport/configuration is unavailable",
        );
      const result = await this.#openCode(
        binding.sandboxResourceName,
      ).bootstrapWorker(
        this.#config.workerBootstrap,
        commission,
        operation,
        binding.sandboxResourceName,
        binding.openCodeSessionId,
        now,
        authorizeEffect,
      );
      return result.ok && result.value
        ? {
            ok: true,
            value: {
              kind: "observed",
              observedAt: now,
              source: "opencode-2.0.32-worker-bootstrap",
              result: "applied",
              retrySafe: false,
              externalIdentity: this.#config.workerBootstrap.receipt(operation),
            },
          }
        : result.ok
          ? rejected("Worker bootstrap postcondition is not verified")
          : result;
    }
    if (operation.kind === "provision_sandbox") {
      const result = await this.#config.sandbox.create(
        this.#config.sandboxIntent(commission),
        authorizeEffect,
      );
      if (!result.ok) return { ok: false, error: sandboxFailure(result.error) };
      return {
        ok: true,
        value: {
          kind: "observed",
          observedAt: now,
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
      const result =
        await this.#openCode(sandboxResourceName).createSession(
          authorizeEffect,
        );
      if (!result.ok) return result;
      this.#bindings.set(commission.id, {
        sandboxResourceName,
        openCodeSessionId: result.value.id,
      });
      return {
        ok: true,
        value: {
          kind: "observed",
          observedAt: now,
          source: "opencode-v2",
          result: "applied",
          retrySafe: false,
          externalIdentity: result.value.id,
        },
      };
    }
    if (operation.kind === "interrupt") {
      const binding = this.#bindings.get(commission.id);
      const sessionId = operation.target.slice("session:".length);
      if (
        binding?.openCodeSessionId === null ||
        binding === undefined ||
        binding.openCodeSessionId !== sessionId
      )
        return rejected("Watchdog interrupt does not target the bound Session");
      const interrupted = await this.#openCode(
        binding.sandboxResourceName,
      ).interruptSession(sessionId, this.#config.model, now, authorizeEffect);
      if (!interrupted.ok) return interrupted;
      return {
        ok: true,
        value: {
          kind: "observed",
          observedAt: now,
          source: "opencode-v2-session-interrupt",
          result: "applied",
          retrySafe: false,
          externalIdentity: sessionId,
        },
      };
    }
    if (
      operation.kind === "steer" ||
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
      if (
        operation.kind === "steer" &&
        operation.target !== `session:${binding.openCodeSessionId}`
      )
        return rejected(
          "Steering does not target the recorded OpenCode Session",
        );
      const instruction =
        operation.kind === "continue" || operation.kind === "repair"
          ? {
              ...operation,
              directive: `${operation.directive}\n\nAfter publishing a Candidate, include one final line per completed approved obligation in this exact format: ANVIL_EVIDENCE <obligation-id> <full-candidate-sha>: <short factual worker claim>. The SHA must be the commit you published. This is submitted worker evidence, not independent acceptance.`,
            }
          : operation;
      return this.#openCode(binding.sandboxResourceName)
        .dispatchInstruction(
          binding.openCodeSessionId,
          instruction,
          this.#config.model,
          authorizeEffect,
        )
        .then((result) =>
          result.ok
            ? {
                ok: true,
                value: {
                  kind: "observed",
                  observedAt: now,
                  source: "opencode-v2",
                  result: "applied",
                  retrySafe: false,
                  externalIdentity: result.value.messageId,
                },
              }
            : result,
        );
    }
    if (operation.kind === "verify") {
      if (operation.candidateRevision === null)
        return rejected("Candidate verification is not configured");
      const world = await this.#config.world.observe(commission, now);
      if (!world.ok) return world;
      if (
        world.value.candidateRevision !== operation.candidateRevision ||
        world.value.checks?.revision !== operation.candidateRevision
      )
        return rejected(
          "Observed required-check evidence differs from the verified Candidate",
        );
      const checks = world.value.checks;
      if (checks === null)
        return rejected("Required-check evidence is unavailable for Candidate");
      return {
        ok: true,
        value: {
          kind: "observed",
          observedAt: now,
          source: checks.source,
          result: "applied",
          retrySafe: false,
          externalIdentity: checks.runId,
        },
      };
    }
    if (operation.kind === "integrate") {
      if (
        this.#config.github === undefined ||
        this.#config.workBranch === undefined
      )
        return rejected("GitHub pull request integration is not configured");
      const branch = await this.#config.github.branch(
        commission.repository,
        this.#config.workBranch(commission),
      );
      if (!branch.ok) return { ok: false, error: githubFailure(branch.error) };
      if (branch.value.revision !== operation.candidateRevision)
        return rejected(
          "Worker branch no longer points at the authorized Candidate",
        );
      const pullRequest = await this.#config.github.createOrFindPullRequest(
        {
          repositoryUrl: commission.repository,
          headRef: this.#config.workBranch(commission),
          baseRef: commission.integrationTarget,
          title: commission.objective,
          body: `Anvil Commission ${commission.id}\nCandidate ${operation.candidateRevision ?? "unknown"}`,
        },
        authorizeEffect,
      );
      if (!pullRequest.ok)
        return { ok: false, error: githubFailure(pullRequest.error) };
      if (
        pullRequest.value.headSha !== operation.candidateRevision ||
        pullRequest.value.headRef !== this.#config.workBranch(commission) ||
        pullRequest.value.baseRef !== commission.integrationTarget
      )
        return rejected(
          "Observed pull request head or target differs from the authorized Candidate",
        );
      return {
        ok: true,
        value: {
          kind: "observed",
          observedAt: now,
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
    now: number,
  ): Promise<ProviderResult<OperationOutcome | null>> {
    if (operation.kind === "bootstrap_worker") {
      const binding = this.#bindings.get(commission.id);
      if (
        !binding?.openCodeSessionId ||
        this.#config.workerBootstrap === undefined
      )
        return { ok: true, value: null };
      const result = await this.#openCode(
        binding.sandboxResourceName,
      ).bootstrapWorker(
        this.#config.workerBootstrap,
        commission,
        operation,
        binding.sandboxResourceName,
        binding.openCodeSessionId,
        now,
        undefined,
        true,
      );
      return result.ok
        ? {
            ok: true,
            value: result.value
              ? {
                  kind: "observed",
                  observedAt: now,
                  source: "opencode-worker-bootstrap-inspection",
                  result: "applied",
                  retrySafe: false,
                  externalIdentity:
                    this.#config.workerBootstrap.receipt(operation),
                }
              : null,
          }
        : result;
    }
    if (operation.kind === "provision_sandbox") {
      const result = await this.#config.sandbox.inspectIntent(
        this.#config.sandboxIntent(commission),
      );
      if (result.ok)
        return {
          ok: true,
          value: {
            kind: "observed",
            observedAt: now,
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
    if (operation.kind === "interrupt") {
      const binding = this.#bindings.get(commission.id);
      const sessionId = operation.target.slice("session:".length);
      if (
        binding?.openCodeSessionId === null ||
        binding === undefined ||
        binding.openCodeSessionId !== sessionId
      )
        return { ok: true, value: null };
      const active = await this.#openCode(
        binding.sandboxResourceName,
      ).activeSessions();
      if (!active.ok) return active;
      if (active.value.some(({ id }) => id === sessionId))
        return { ok: true, value: null };
      return {
        ok: true,
        value: {
          kind: "observed",
          observedAt: now,
          source: "opencode-v2-session-interrupt-inspection",
          result: "applied",
          retrySafe: false,
          externalIdentity: sessionId,
        },
      };
    }
    if (
      operation.kind === "steer" ||
      operation.kind === "continue" ||
      operation.kind === "repair" ||
      operation.kind === "refresh_context" ||
      operation.kind === "change_strategy"
    ) {
      const binding = this.#bindings.get(commission.id);
      if (binding?.openCodeSessionId === null || binding === undefined)
        return { ok: true, value: null };
      if (
        operation.kind === "steer" &&
        operation.target !== `session:${binding.openCodeSessionId}`
      )
        return { ok: true, value: null };
      return this.#openCode(binding.sandboxResourceName).inspectInstruction(
        binding.openCodeSessionId,
        operation,
        now,
      );
    }
    if (operation.kind === "verify" && operation.candidateRevision !== null) {
      const world = await this.#config.world.observe(commission, now);
      if (!world.ok) return world;
      if (
        world.value.candidateRevision !== operation.candidateRevision ||
        world.value.checks?.revision !== operation.candidateRevision ||
        world.value.checks === null
      )
        return { ok: true, value: null };
      const checks = world.value.checks;
      return {
        ok: true,
        value: {
          kind: "observed",
          observedAt: now,
          source: checks.source,
          result: "applied",
          retrySafe: false,
          externalIdentity: checks.runId,
        },
      };
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
        pullRequest.value.headSha !== operation.candidateRevision ||
        pullRequest.value.headRef !== this.#config.workBranch(commission) ||
        pullRequest.value.baseRef !== commission.integrationTarget
      ) {
        return { ok: true, value: null };
      }
      return {
        ok: true,
        value: {
          kind: "observed",
          observedAt: now,
          source: "github-pull-request-inspection",
          result: "accepted",
          retrySafe: false,
          externalIdentity: pullRequest.value.url,
        },
      };
    }
    return { ok: true, value: null };
  }

  #openCode(sandboxResourceName: string): OpenCodeAdapter {
    const existing = this.#openCodeAdapters.get(sandboxResourceName);
    if (existing !== undefined) return existing;
    const adapter = this.#config.openCodeForSandbox(sandboxResourceName);
    this.#openCodeAdapters.set(sandboxResourceName, adapter);
    return adapter;
  }

  #ensureExecutionWatcher(
    commissionId: string,
    sandboxResourceName: string,
    sessionId: string,
  ): void {
    if (this.#executionListeners.size === 0) return;
    const existing = this.#executionWatchers.get(commissionId);
    if (existing?.sessionId === sessionId) return;
    existing?.controller.abort();
    const controller = new AbortController();
    this.#executionWatchers.set(commissionId, { sessionId, controller });
    void this.#openCode(sandboxResourceName)
      .watchActivity(
        sessionId,
        () => {
          if (
            this.#executionWatchers.get(commissionId)?.controller !== controller
          )
            return;
          for (const listener of this.#executionListeners)
            listener(commissionId);
        },
        controller.signal,
      )
      .catch(() => {});
  }

  #stopExecutionWatcher(commissionId: string): void {
    this.#executionWatchers.get(commissionId)?.controller.abort();
    this.#executionWatchers.delete(commissionId);
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

function workerClaimsFromMessages(
  commission: Commission,
  sessionId: string,
  candidateRevision: string | null,
  messages: readonly Readonly<{
    id: string;
    type: string;
    completedAt?: number;
    text?: string;
  }>[],
  observedAt: number,
  expiresAt: number,
): readonly WorkerClaim[] {
  if (candidateRevision === null) return [];
  const obligations = new Set(commission.obligations.map(({ id }) => id));
  const claims: WorkerClaim[] = [];
  const line =
    /^ANVIL_EVIDENCE ([A-Za-z0-9_.:-]{1,128}) ([A-Za-z0-9._-]{1,128}): ([^\r\n]{1,1000})$/gm;
  for (const message of messages) {
    if (message.type !== "assistant" || message.completedAt === undefined)
      continue;
    for (const match of message.text?.matchAll(line) ?? []) {
      const obligationId = match[1];
      const claimedRevision = match[2];
      const claim = match[3]?.trim();
      if (
        obligationId === undefined ||
        claimedRevision !== candidateRevision ||
        !obligations.has(obligationId) ||
        claim === undefined ||
        claim.length === 0
      )
        continue;
      claims.push({
        id: `opencode-claim:${sessionId}:${message.id}:${obligationId}`,
        obligationId,
        claim,
        observedAt,
        expiresAt,
        sourceIdentity: `opencode-session:${sessionId}`,
      });
    }
  }
  return claims.slice(-commission.obligations.length);
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
