import { createHash } from "node:crypto";

const apiGroupVersion = "agents.x-k8s.io/v1beta1";
const sandboxPlural = "sandboxes";
const managedLabel = "app.kubernetes.io/managed-by";
const commissionAnnotation = "anvil.example/commission-id";
const specHashAnnotation = "anvil.example/spec-sha256";
const maxResponseBytes = 2 * 1024 * 1024;

export type SandboxIntent = Readonly<{
  commissionId: string;
  project: string;
  repository: string;
  baseRef: string;
  imageDigest: string;
  workspaceSize: string;
  openCodePort: number;
  profileClaim: string;
  sharedNixClaim: string;
  environment: Readonly<Record<string, string>>;
  secretReferences: readonly Readonly<{
    name: string;
    secretName: string;
    secretKey: string;
  }>[];
}>;

export type SandboxEnvironmentState =
  | "provisioning"
  | "ready"
  | "failed"
  | "suspended";

export type SandboxObservation = Readonly<{
  name: string;
  namespace: string;
  commissionId: string;
  uid: string;
  operatingMode: "Running" | "Suspended";
  environmentState: SandboxEnvironmentState;
  reason: string | null;
  resourceVersion: string;
  specHash: string;
}>;

export type SandboxAdapterError = Readonly<{
  kind:
    | "not_found"
    | "conflict"
    | "rejected"
    | "unavailable"
    | "ambiguous"
    | "invalid_resource";
  message: string;
  status?: number;
}>;

export type SandboxAdapterResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: SandboxAdapterError }>;

export type AgentSandboxConfig = Readonly<{
  apiServerUrl: string;
  namespace: string;
  bearerToken: string;
  caCertificate?: string;
  timeoutMs?: number;
}>;

type KubernetesResource = Readonly<{
  apiVersion: string;
  kind: string;
  metadata: Readonly<{
    name: string;
    namespace: string;
    uid?: string;
    resourceVersion?: string;
    labels?: Readonly<Record<string, string>>;
    annotations?: Readonly<Record<string, string>>;
  }>;
  spec?: Readonly<{ operatingMode?: string }>;
  status?: Readonly<{
    conditions?: readonly Readonly<{
      type?: string;
      status?: string;
      reason?: string;
      message?: string;
    }>[];
    phase?: string;
  }>;
}>;

export class AgentSandboxClient {
  readonly #base: URL;
  readonly #namespace: string;
  readonly #bearerToken: string;
  readonly #caCertificate: string | undefined;
  readonly #timeoutMs: number;

  constructor(config: AgentSandboxConfig) {
    const base = new URL(config.apiServerUrl);
    if (base.protocol !== "https:" && base.protocol !== "http:")
      throw new Error("Kubernetes API URL must use HTTP or HTTPS");
    if (
      base.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "::1"].includes(base.hostname)
    ) {
      throw new Error(
        "Kubernetes API HTTP is permitted only for loopback fixtures",
      );
    }
    if (
      base.username !== "" ||
      base.password !== "" ||
      base.search !== "" ||
      base.hash !== ""
    )
      throw new Error(
        "Kubernetes API URL must not contain credentials, query, or fragment",
      );
    if (!/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(config.namespace))
      throw new Error("Kubernetes namespace is invalid");
    if (config.bearerToken.length === 0)
      throw new Error("Kubernetes bearer token must not be empty");
    base.pathname = base.pathname.endsWith("/")
      ? base.pathname
      : `${base.pathname}/`;
    this.#base = base;
    this.#namespace = config.namespace;
    this.#bearerToken = config.bearerToken;
    this.#caCertificate = config.caCertificate;
    this.#timeoutMs = config.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1)
      throw new Error("Kubernetes request timeout must be a positive integer");
  }

  async create(
    intent: SandboxIntent,
  ): Promise<SandboxAdapterResult<SandboxObservation>> {
    const desired = buildSandboxResource(intent, this.#namespace);
    const metadata = asRecord(desired["metadata"]);
    const name = metadata?.["name"];
    if (typeof name !== "string")
      return {
        ok: false,
        error: {
          kind: "invalid_resource",
          message: "Generated Sandbox name is invalid",
        },
      };
    const existing = await this.inspect(intent.commissionId);
    if (existing.ok) return verifySameIntent(existing.value, desired);
    if (existing.error.kind !== "not_found") return existing;

    const created = await this.#request(
      this.#collectionPath(),
      "POST",
      desired,
    );
    if (created.ok) {
      const observed = observeResource(created.value, intent.commissionId);
      return observed.ok ? verifySameIntent(observed.value, desired) : observed;
    }
    if (created.error.kind === "ambiguous" || created.error.status === 409) {
      const recovered = await this.inspect(intent.commissionId);
      if (recovered.ok) return verifySameIntent(recovered.value, desired);
      if (recovered.error.kind !== "not_found") return recovered;
      return {
        ok: false,
        error: {
          kind: "ambiguous",
          message: `Sandbox create outcome for ${name} is unknown; reobserve before retry`,
        },
      };
    }
    return created;
  }

  async inspect(
    commissionId: string,
  ): Promise<SandboxAdapterResult<SandboxObservation>> {
    const name = sandboxName(commissionId);
    const result = await this.#request(
      `${this.#collectionPath()}/${encodeURIComponent(name)}`,
      "GET",
    );
    if (!result.ok) return result;
    const parsed = observeResource(result.value, commissionId);
    if (!parsed.ok) return parsed;
    if (
      parsed.value.name !== name ||
      parsed.value.namespace !== this.#namespace
    )
      return {
        ok: false,
        error: {
          kind: "invalid_resource",
          message: "Sandbox identity differs from requested resource",
        },
      };
    return parsed;
  }

  async inspectIntent(
    intent: SandboxIntent,
  ): Promise<SandboxAdapterResult<SandboxObservation>> {
    const existing = await this.inspect(intent.commissionId);
    if (!existing.ok) return existing;
    return verifySameIntent(
      existing.value,
      buildSandboxResource(intent, this.#namespace),
    );
  }

  async suspend(
    commissionId: string,
  ): Promise<SandboxAdapterResult<SandboxObservation>> {
    return this.#setOperatingMode(commissionId, "Suspended");
  }

  async resume(
    commissionId: string,
  ): Promise<SandboxAdapterResult<SandboxObservation>> {
    return this.#setOperatingMode(commissionId, "Running");
  }

  async delete(commissionId: string): Promise<SandboxAdapterResult<void>> {
    const name = sandboxName(commissionId);
    const existing = await this.inspect(commissionId);
    if (!existing.ok) {
      return existing.error.kind === "not_found"
        ? { ok: true, value: undefined }
        : existing;
    }
    const result = await this.#request(
      `${this.#collectionPath()}/${encodeURIComponent(name)}`,
      "DELETE",
      {
        apiVersion: "v1",
        kind: "DeleteOptions",
        preconditions: {
          uid: existing.value.uid,
          resourceVersion: existing.value.resourceVersion,
        },
      },
    );
    return result.ok || result.error.kind === "not_found"
      ? { ok: true, value: undefined }
      : result;
  }

  async #setOperatingMode(
    commissionId: string,
    operatingMode: "Running" | "Suspended",
  ): Promise<SandboxAdapterResult<SandboxObservation>> {
    const name = sandboxName(commissionId);
    const existing = await this.inspect(commissionId);
    if (!existing.ok) return existing;
    if (existing.value.operatingMode === operatingMode) return existing;
    const result = await this.#request(
      `${this.#collectionPath()}/${encodeURIComponent(name)}`,
      "PATCH",
      [
        {
          op: "test",
          path: "/metadata/resourceVersion",
          value: existing.value.resourceVersion,
        },
        { op: "add", path: "/spec/operatingMode", value: operatingMode },
      ],
      "application/json-patch+json",
    );
    if (result.ok) return observeResource(result.value, commissionId);
    if (result.error.kind === "conflict") {
      const latest = await this.inspect(commissionId);
      if (latest.ok && latest.value.operatingMode === operatingMode)
        return latest;
    }
    return result;
  }

  #collectionPath(): string {
    return `apis/${apiGroupVersion}/namespaces/${encodeURIComponent(this.#namespace)}/${sandboxPlural}`;
  }

  async #request(
    path: string,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    body?: unknown,
    contentType = "application/json",
  ): Promise<SandboxAdapterResult<unknown>> {
    const headers = new Headers({
      accept: "application/json",
      authorization: `Bearer ${this.#bearerToken}`,
    });
    if (body !== undefined) headers.set("content-type", contentType);
    let response: Response;
    try {
      response = await fetch(new URL(path, this.#base), {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.#timeoutMs),
        ...(this.#caCertificate === undefined
          ? {}
          : { tls: { ca: this.#caCertificate } }),
      });
    } catch {
      return {
        ok: false,
        error: {
          kind: method === "GET" ? "unavailable" : "ambiguous",
          message:
            method === "GET"
              ? "Kubernetes API is unavailable"
              : "Kubernetes mutation acknowledgement was lost; inspect before retry",
        },
      };
    }
    if (response.status === 404)
      return {
        ok: false,
        error: {
          kind: "not_found",
          message: "Sandbox resource was not found",
          status: 404,
        },
      };
    if (response.status === 409)
      return {
        ok: false,
        error: {
          kind: "conflict",
          message: "Sandbox resource version conflict",
          status: 409,
        },
      };
    if (response.status === 401 || response.status === 403)
      return {
        ok: false,
        error: {
          kind: "rejected",
          message: `Kubernetes API authorization failed (${response.status})`,
          status: response.status,
        },
      };
    if (!response.ok)
      return {
        ok: false,
        error: {
          kind: method === "GET" ? "unavailable" : "ambiguous",
          message: `Kubernetes API returned HTTP ${response.status}`,
          status: response.status,
        },
      };
    if (method === "DELETE") {
      await response.body?.cancel();
      return { ok: true, value: null };
    }
    try {
      const bodyText = await readBounded(response, maxResponseBytes);
      return { ok: true, value: JSON.parse(bodyText) };
    } catch {
      return {
        ok: false,
        error: {
          kind: method === "GET" ? "invalid_resource" : "ambiguous",
          message:
            "Kubernetes API response was invalid or exceeded the size limit",
        },
      };
    }
  }
}

const nixDaemonSocketSubPath = "var/nix/daemon-socket/socket";

function isPathPrefix(
  prefix: readonly string[],
  path: readonly string[],
): boolean {
  return (
    prefix.length <= path.length &&
    prefix.every((segment, index) => segment === path[index])
  );
}

export function assertOpenCodeCannotMountSharedNixDaemonSocket(
  volumes: readonly Readonly<Record<string, unknown>>[],
  volumeMounts: readonly Readonly<Record<string, unknown>>[],
  sharedNixClaim: string,
): void {
  const sharedNixVolumeNames = new Set(
    volumes.flatMap((volume) => {
      const claim = volume["persistentVolumeClaim"] as
        | Readonly<Record<string, unknown>>
        | undefined;
      const name = volume["name"];
      return claim?.["claimName"] === sharedNixClaim && typeof name === "string"
        ? [name]
        : [];
    }),
  );
  const socketPath = nixDaemonSocketSubPath.split("/");
  for (const mount of volumeMounts) {
    if (
      typeof mount["name"] !== "string" ||
      !sharedNixVolumeNames.has(mount["name"])
    )
      continue;
    if ("subPathExpr" in mount)
      throw new Error(
        "OpenCode main container cannot mount the shared Nix daemon socket",
      );
    const subPath = mount["subPath"];
    if (typeof subPath !== "string")
      throw new Error(
        "OpenCode main container cannot mount the shared Nix daemon socket",
      );
    const sourcePath = subPath === "" ? [] : subPath.split("/");
    if (
      sourcePath.some(
        (segment) =>
          segment.length === 0 || segment === "." || segment === "..",
      ) ||
      isPathPrefix(sourcePath, socketPath) ||
      isPathPrefix(socketPath, sourcePath)
    )
      throw new Error(
        "OpenCode main container cannot mount the shared Nix daemon socket",
      );
  }
}

export function buildSandboxResource(
  intent: SandboxIntent,
  namespace: string,
): Readonly<Record<string, unknown>> {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(intent.commissionId))
    throw new Error("Commission identity is invalid for Sandbox provisioning");
  if (!/^.+@sha256:[a-f0-9]{64}$/.test(intent.imageDigest))
    throw new Error("Sandbox image must use an immutable sha256 digest");
  if (
    !Number.isSafeInteger(intent.openCodePort) ||
    intent.openCodePort < 1 ||
    intent.openCodePort > 65535
  )
    throw new Error("OpenCode port must be between 1 and 65535");
  if (!intent.workspaceSize || !intent.profileClaim || !intent.sharedNixClaim)
    throw new Error(
      "Workspace, profile, and shared Nix storage must be configured",
    );
  for (const name of Object.keys(intent.environment)) {
    if (/(TOKEN|PASSWORD|PRIVATE.?KEY|SECRET)/i.test(name))
      throw new Error(
        `Sensitive environment variable ${name} must use a Kubernetes Secret reference`,
      );
  }
  if (
    ["ANVIL_PROJECT", "ANVIL_REPOSITORY", "ANVIL_REF", "OPENCODE_CONFIG"].some(
      (protectedName) => protectedName in intent.environment,
    )
  ) {
    throw new Error(
      "Sandbox intent cannot override Anvil-owned runtime identity",
    );
  }
  for (const reference of intent.secretReferences) {
    if (!reference.name || !reference.secretName || !reference.secretKey)
      throw new Error(
        "Kubernetes Secret references must name a variable, Secret, and key",
      );
  }
  const name = sandboxName(intent.commissionId);
  const spec = {
    service: true,
    podTemplate: {
      spec: {
        initContainers: [
          {
            name: "verify-worker-store-closure",
            image: intent.imageDigest,
            command: ["/bin/anvil-verify-worker-store-closure"],
            args: [
              "daemon",
              "/etc/anvil/worker-image-closure.paths",
              "/run/anvil/shared-nix/store",
              "/bin/nix",
            ],
            volumeMounts: [
              {
                name: "shared-nix",
                mountPath: "/run/anvil/shared-nix/store",
                subPath: "store",
                readOnly: true,
              },
              {
                name: "shared-nix",
                mountPath: "/nix/var/nix/daemon-socket",
                subPath: "var/nix/daemon-socket",
                readOnly: true,
              },
            ],
          },
          {
            name: "initialize-workspace",
            image: intent.imageDigest,
            command: ["/bin/bash", "-c"],
            args: [
              "mkdir -p /home/anvil/workspace && chown -R 1000:1000 /home/anvil",
            ],
            securityContext: { runAsUser: 0, runAsGroup: 0 },
            volumeMounts: [{ name: "workspace", mountPath: "/home/anvil" }],
          },
        ],
        automountServiceAccountToken: false,
        containers: [
          {
            name: "sandbox",
            image: intent.imageDigest,
            ports: [{ name: "opencode", containerPort: intent.openCodePort }],
            env: [
              { name: "ANVIL_PROJECT", value: intent.project },
              { name: "ANVIL_REPOSITORY", value: intent.repository },
              { name: "ANVIL_REF", value: intent.baseRef },
              {
                name: "OPENCODE_CONFIG",
                value: "/anvil/profile/config/opencode.jsonc",
              },
              ...Object.entries(intent.environment).map(([envName, value]) => ({
                name: envName,
                value,
              })),
              ...intent.secretReferences.map((reference) => ({
                name: reference.name,
                valueFrom: {
                  secretKeyRef: {
                    name: reference.secretName,
                    key: reference.secretKey,
                  },
                },
              })),
            ],
            volumeMounts: [
              { name: "workspace", mountPath: "/home/anvil" },
              { name: "shared-profile", mountPath: "/anvil/profile" },
              {
                name: "shared-nix",
                mountPath: "/nix/store",
                subPath: "store",
                readOnly: true,
              },
            ],
          },
        ],
        volumes: [
          {
            name: "shared-profile",
            persistentVolumeClaim: { claimName: intent.profileClaim },
          },
          {
            name: "shared-nix",
            persistentVolumeClaim: { claimName: intent.sharedNixClaim },
          },
        ],
      },
    },
    volumeClaimTemplates: [
      {
        metadata: { name: "workspace" },
        spec: {
          accessModes: ["ReadWriteOnce"],
          resources: { requests: { storage: intent.workspaceSize } },
        },
      },
    ],
  };
  const mainContainer = spec.podTemplate.spec.containers[0];
  if (mainContainer === undefined)
    throw new Error(
      "Sandbox PodTemplate is missing the OpenCode main container",
    );
  assertOpenCodeCannotMountSharedNixDaemonSocket(
    spec.podTemplate.spec.volumes,
    mainContainer.volumeMounts,
    intent.sharedNixClaim,
  );
  const specHash = createHash("sha256")
    .update(
      JSON.stringify({
        commissionId: intent.commissionId,
        namespace,
        project: intent.project,
        repository: intent.repository,
        baseRef: intent.baseRef,
        spec,
      }),
    )
    .digest("hex");
  return {
    apiVersion: apiGroupVersion,
    kind: "Sandbox",
    metadata: {
      name,
      namespace,
      labels: {
        [managedLabel]: "anvil",
        "app.kubernetes.io/name": "sandbox",
      },
      annotations: {
        [commissionAnnotation]: intent.commissionId,
        [specHashAnnotation]: specHash,
        "anvil.example/project": intent.project,
        "anvil.example/repository": intent.repository,
        "anvil.example/base-ref": intent.baseRef,
      },
    },
    spec,
  };
}

export function sandboxName(commissionId: string): string {
  const normalized = commissionId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42);
  const hash = createHash("sha256")
    .update(commissionId)
    .digest("hex")
    .slice(0, 12);
  return `anvil-${normalized || "commission"}-${hash}`.slice(0, 63);
}

function verifySameIntent(
  observation: SandboxObservation,
  desired: Readonly<Record<string, unknown>>,
): SandboxAdapterResult<SandboxObservation> {
  const metadata = asRecord(desired["metadata"]);
  const annotations = asRecord(metadata?.["annotations"]);
  const desiredHash = annotations?.[specHashAnnotation];
  if (typeof desiredHash !== "string")
    return {
      ok: false,
      error: {
        kind: "invalid_resource",
        message: "Desired Sandbox spec hash is missing",
      },
    };
  return observation.specHash === desiredHash
    ? { ok: true, value: observation }
    : {
        ok: false,
        error: {
          kind: "conflict",
          message: "Sandbox exists but the desired spec cannot be verified",
        },
      };
}

function observeResource(
  value: unknown,
  expectedCommissionId: string,
): SandboxAdapterResult<SandboxObservation> {
  const resource = asRecord(value) as KubernetesResource | null;
  const metadata = resource?.metadata;
  const commissionId = metadata?.annotations?.[commissionAnnotation];
  const specHash = metadata?.annotations?.[specHashAnnotation];
  if (
    resource?.apiVersion !== apiGroupVersion ||
    resource.kind !== "Sandbox" ||
    typeof metadata?.name !== "string" ||
    typeof metadata.namespace !== "string" ||
    typeof metadata.uid !== "string" ||
    typeof metadata.resourceVersion !== "string" ||
    metadata.labels?.[managedLabel] !== "anvil" ||
    commissionId !== expectedCommissionId ||
    typeof specHash !== "string"
  ) {
    return {
      ok: false,
      error: {
        kind: "invalid_resource",
        message: "Kubernetes returned a Sandbox with invalid identity or shape",
      },
    };
  }
  const operatingMode = resource.spec?.operatingMode ?? "Running";
  if (operatingMode !== "Running" && operatingMode !== "Suspended")
    return {
      ok: false,
      error: {
        kind: "invalid_resource",
        message: "Sandbox operating mode is unknown",
      },
    };
  if (operatingMode === "Suspended")
    return {
      ok: true,
      value: {
        name: metadata.name,
        namespace: metadata.namespace,
        commissionId,
        uid: metadata.uid,
        operatingMode,
        environmentState: "suspended",
        reason: null,
        resourceVersion: metadata.resourceVersion,
        specHash,
      },
    };
  const conditions = resource.status?.conditions ?? [];
  const failed = conditions.find(
    (condition) =>
      (condition.type === "Failed" && condition.status === "True") ||
      /fail|error/i.test(
        `${condition.reason ?? ""} ${condition.message ?? ""}`,
      ),
  );
  const ready = conditions.some(
    (condition) => condition.type === "Ready" && condition.status === "True",
  );
  return {
    ok: true,
    value: {
      name: metadata.name,
      namespace: metadata.namespace,
      commissionId,
      uid: metadata.uid,
      operatingMode,
      environmentState: failed ? "failed" : ready ? "ready" : "provisioning",
      reason: failed?.reason ?? (ready ? "Ready" : null),
      resourceVersion: metadata.resourceVersion,
      specHash,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function readBounded(
  response: Response,
  maximum: number,
): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximum)
    throw new Error("Kubernetes response too large");
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximum) {
        await reader.cancel();
        throw new Error("Kubernetes response too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(output);
}
