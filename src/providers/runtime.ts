import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { GitHubAppBroker } from "./github-app";
import { GitHubDeliveryClient } from "./github-delivery";
import { GitHubWorldObserver } from "./github-world";
import { MergifyQueueClient } from "./mergify";
import { AgentSandboxClient } from "./agent-sandbox";
import { OpenCodeAdapter } from "./opencode";
import { ProviderComposition } from "./composition";
import type {
  ProviderFailure,
  LeasePort,
  ProviderPort,
  ProviderResult,
} from "../application";
import type { Commission, Operation, OperationOutcome } from "../domain";
import type { CommissionStore } from "../persistence/sqlite";
import { KubernetesLeaseClient } from "./kubernetes-lease";
import { WorkerGitCapabilitySigner } from "./git-credentials";
import { WorkerBootstrap } from "./worker-bootstrap";

export function createControllerAuthority(
  environment: NodeJS.ProcessEnv,
  store: CommissionStore,
  clock: Readonly<{ now: () => number; monotonicNow?: () => number }> = {
    now: Date.now,
  },
): Readonly<{
  controllerId: string;
  lease: LeasePort;
  stop: () => Promise<void>;
}> {
  const mode = environment["ANVIL_PROVIDER_MODE"] ?? "unavailable";
  if (mode === "configured") {
    const lease = new KubernetesLeaseClient({
      apiServerUrl:
        environment["ANVIL_LEASE_API_URL"] ??
        required(environment, "ANVIL_KUBERNETES_API_URL"),
      namespace: required(environment, "ANVIL_LEASE_NAMESPACE"),
      controllerIdentity: required(environment, "ANVIL_CONTROLLER_ID"),
      bearerToken: () => readSecretFile(environment, "ANVIL_LEASE_TOKEN_FILE"),
      ...(environment["ANVIL_KUBERNETES_CA_FILE"] === undefined
        ? {}
        : {
            caCertificate: readSecretFile(
              environment,
              "ANVIL_KUBERNETES_CA_FILE",
            ),
          }),
      durationSeconds: positiveInteger(
        environment["ANVIL_LEASE_DURATION_SECONDS"],
        30,
        "ANVIL_LEASE_DURATION_SECONDS",
      ),
      timeoutMs: positiveInteger(
        environment["ANVIL_LEASE_TIMEOUT_MS"],
        2000,
        "ANVIL_LEASE_TIMEOUT_MS",
      ),
      maxClockSkewMs: positiveInteger(
        environment["ANVIL_LEASE_MAX_CLOCK_SKEW_MS"],
        2000,
        "ANVIL_LEASE_MAX_CLOCK_SKEW_MS",
      ),
      epochFloor: (id) => store.get(id)?.owner?.epoch ?? 0,
      ...clock,
    });
    // Validate explicit credential configuration at startup; reread for rotation.
    readSecretFile(environment, "ANVIL_LEASE_TOKEN_FILE");
    return {
      controllerId: lease.controllerId,
      lease,
      stop: async () => {
        for (const result of await lease.stop())
          if (!result.ok)
            console.error(
              JSON.stringify({
                event: "lease_release_failed",
                error: result.error,
              }),
            );
      },
    };
  }
  if (mode !== "unavailable")
    throw new Error("ANVIL_PROVIDER_MODE must be unavailable or configured");
  const controllerId =
    environment["ANVIL_CONTROLLER_ID"] ?? "anvil-local-controller";
  return {
    controllerId,
    lease: {
      current: async (commissionId, requested, now) =>
        requested !== controllerId
          ? { ok: false, error: unavailable("local controller mismatch") }
          : {
              ok: true,
              value: {
                owner: { controllerId, epoch: 1 },
                resourceVersion: `local:${commissionId}:1`,
                observedAt: now,
                validUntil: now + 60000,
              },
            },
    },
    stop: async () => {},
  };
}

export function createProviderPort(
  environment: NodeJS.ProcessEnv,
  onGitHubBroker?: (
    broker: GitHubAppBroker,
    signer: WorkerGitCapabilitySigner,
  ) => void,
): ProviderPort {
  const mode = environment["ANVIL_PROVIDER_MODE"] ?? "unavailable";
  if (mode === "unavailable") return new UnavailableProvider();
  if (mode !== "configured")
    throw new Error("ANVIL_PROVIDER_MODE must be unavailable or configured");

  const namespace = required(environment, "ANVIL_SANDBOX_NAMESPACE");
  const sandboxImage = required(environment, "ANVIL_SANDBOX_IMAGE_DIGEST");
  const workspaceSize = required(environment, "ANVIL_WORKSPACE_SIZE");
  const profileClaim = required(environment, "ANVIL_PROFILE_PVC");
  const sharedNixClaim = required(environment, "ANVIL_NIX_PVC");
  const openCodeUrlTemplate = required(
    environment,
    "ANVIL_OPENCODE_URL_TEMPLATE",
  );
  if (
    !openCodeUrlTemplate.includes("{sandbox}") ||
    !openCodeUrlTemplate.includes("{namespace}")
  ) {
    throw new Error(
      "ANVIL_OPENCODE_URL_TEMPLATE must contain {sandbox} and {namespace}",
    );
  }
  const appId = required(environment, "ANVIL_GITHUB_APP_ID");
  const installationId = Number(
    required(environment, "ANVIL_GITHUB_INSTALLATION_ID"),
  );
  if (!Number.isSafeInteger(installationId) || installationId < 1)
    throw new Error("ANVIL_GITHUB_INSTALLATION_ID must be a positive integer");
  const privateKey = readSecretFile(
    environment,
    "ANVIL_GITHUB_PRIVATE_KEY_FILE",
  );
  const mergifyToken = readSecretFile(environment, "ANVIL_MERGIFY_TOKEN_FILE");
  const kubernetesToken = readSecretFile(
    environment,
    "ANVIL_KUBERNETES_TOKEN_FILE",
  );
  const openCodePasswordFile = environment["ANVIL_OPENCODE_PASSWORD_FILE"];
  const openCodePassword =
    openCodePasswordFile === undefined
      ? undefined
      : readSecretFile(environment, "ANVIL_OPENCODE_PASSWORD_FILE");
  const openCodeSecretName = environment["ANVIL_OPENCODE_SECRET_NAME"];
  const openCodeSecretKey = environment["ANVIL_OPENCODE_SECRET_KEY"];
  if (
    openCodePassword !== undefined &&
    (openCodeSecretName === undefined || openCodeSecretKey === undefined)
  ) {
    throw new Error(
      "OpenCode password requires ANVIL_OPENCODE_SECRET_NAME and ANVIL_OPENCODE_SECRET_KEY for the Sandbox reference",
    );
  }

  const sandbox = new AgentSandboxClient({
    apiServerUrl: required(environment, "ANVIL_KUBERNETES_API_URL"),
    namespace,
    bearerToken: kubernetesToken,
    ...(environment["ANVIL_KUBERNETES_CA_FILE"] === undefined
      ? {}
      : {
          caCertificate: readSecretFile(
            environment,
            "ANVIL_KUBERNETES_CA_FILE",
          ),
        }),
  });
  const githubApiUrl = environment["ANVIL_GITHUB_API_URL"];
  const githubCredentials = new GitHubAppBroker({
    appId,
    installationId,
    privateKey,
    ...(githubApiUrl === undefined ? {} : { apiUrl: githubApiUrl }),
  });
  const signer = new WorkerGitCapabilitySigner(
    readSecretFile(environment, "ANVIL_GIT_CAPABILITY_SECRET_FILE"),
  );
  onGitHubBroker?.(githubCredentials, signer);
  const github = new GitHubDeliveryClient(
    githubCredentials,
    githubApiUrl === undefined ? {} : { apiUrl: githubApiUrl },
  );
  const mergifyApiUrl = environment["ANVIL_MERGIFY_API_URL"];
  const mergify = new MergifyQueueClient({
    bearerToken: mergifyToken,
    ...(mergifyApiUrl === undefined ? {} : { apiUrl: mergifyApiUrl }),
  });
  const maxObservationAgeMs = positiveInteger(
    environment["ANVIL_MAX_OBSERVATION_AGE_MS"],
    60_000,
    "ANVIL_MAX_OBSERVATION_AGE_MS",
  );
  const world = new GitHubWorldObserver({
    delivery: github,
    mergify,
    workBranch: workBranchFor,
    maxObservationAgeMs,
  });
  return new ProviderComposition({
    workerBootstrap: new WorkerBootstrap({
      signer,
      credentialUrl: required(environment, "ANVIL_GIT_CREDENTIAL_URL"),
      repositoryDirectory:
        environment["ANVIL_WORKER_REPOSITORY_DIRECTORY"] ??
        "/home/anvil/workspace",
      privateDirectory:
        environment["ANVIL_WORKER_PRIVATE_DIRECTORY"] ??
        "/home/anvil/.anvil-worker",
      imageHelper:
        environment["ANVIL_WORKER_GIT_HELPER"] ?? "/bin/anvil-git-credential",
      targetRef: (c) => `refs/heads/${workBranchFor(c)}`,
    }),
    sandbox,
    world,
    openCodeForSandbox: (sandboxResourceName) => {
      const url = openCodeUrlTemplate
        .replaceAll("{sandbox}", encodeURIComponent(sandboxResourceName))
        .replaceAll("{namespace}", encodeURIComponent(namespace));
      return new OpenCodeAdapter({
        baseUrl: url,
        ...(openCodePassword === undefined
          ? {}
          : { password: openCodePassword }),
      });
    },
    sandboxIntent: (commission) => ({
      commissionId: commission.id,
      project: commission.campaignId,
      repository: commission.repository,
      baseRef: commission.integrationTarget,
      imageDigest: sandboxImage,
      workspaceSize,
      openCodePort: positiveInteger(
        environment["ANVIL_OPENCODE_PORT"],
        4096,
        "ANVIL_OPENCODE_PORT",
      ),
      profileClaim,
      sharedNixClaim,
      environment: {
        OPENCODE_CONFIG_DIR: "/anvil/profile/config",
      },
      secretReferences:
        openCodeSecretName === undefined || openCodeSecretKey === undefined
          ? []
          : [
              {
                name: "OPENCODE_SERVER_PASSWORD",
                secretName: openCodeSecretName,
                secretKey: openCodeSecretKey,
              },
            ],
    }),
    github,
    workBranch: workBranchFor,
    model: {
      providerId: required(environment, "ANVIL_OPENCODE_MODEL_PROVIDER"),
      modelId: required(environment, "ANVIL_OPENCODE_MODEL_ID"),
    },
  });
}

export function workBranchFor(commission: Commission): string {
  const slug = commission.id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const suffix = createHash("sha256")
    .update(commission.id)
    .digest("hex")
    .slice(0, 10);
  return `anvil/${slug || "commission"}-${suffix}`;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (value === undefined || value.trim().length === 0)
    throw new Error(`${name} is required when ANVIL_PROVIDER_MODE=configured`);
  return value.trim();
}

function readSecretFile(environment: NodeJS.ProcessEnv, name: string): string {
  const path = required(environment, name);
  try {
    const secret = readFileSync(path, "utf8").trim();
    if (secret.length === 0) throw new Error();
    return secret;
  } catch {
    throw new Error(`${name} could not be read`);
  }
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

class UnavailableProvider implements ProviderPort {
  async observe(): Promise<ProviderResult<never>> {
    return { ok: false, error: unavailable("No provider adapter configured") };
  }

  async dispatch(
    _commission: Commission,
    _operation: Operation,
  ): Promise<ProviderResult<Exclude<OperationOutcome, { kind: "prepared" }>>> {
    return { ok: false, error: unavailable("No provider adapter configured") };
  }

  async inspectOperation(): Promise<ProviderResult<OperationOutcome | null>> {
    return { ok: true, value: null };
  }
}

function unavailable(message: string): ProviderFailure {
  return { kind: "unavailable", message };
}
