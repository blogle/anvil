import { importPKCS8, SignJWT } from "jose";

export type GitHubCredentialPurpose = "git" | "gh_read" | "gh";
export type GitHubPermission = "read" | "write";
export type GitHubCredential = Readonly<{
  token: string;
  tokenType: "installation";
  expiresAt: string;
  repository: string;
  permissions: Readonly<Record<string, GitHubPermission>>;
}>;

export type GitHubDiagnostic = Readonly<{
  code: string;
  message: string;
  upstreamStatus?: number;
  requestId?: string;
  documentationUrl?: string;
}>;

export type GitHubBrokerError = Readonly<{
  kind:
    | "repository"
    | "configuration"
    | "jwt"
    | "transport"
    | "upstream"
    | "malformed_response"
    | "scope_mismatch";
  diagnostic: GitHubDiagnostic;
}>;

export type GitHubBrokerResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: GitHubBrokerError }>;

export type GitHubAppBrokerConfig = Readonly<{
  appId: string;
  installationId: number;
  privateKey: string;
  apiUrl?: string;
  timeoutMs?: number;
  refreshMarginMs?: number;
  now?: () => number;
}>;

const permissionProfiles: Readonly<
  Record<GitHubCredentialPurpose, Readonly<Record<string, GitHubPermission>>>
> = {
  git: { contents: "write" },
  gh_read: {
    administration: "read",
    actions: "read",
    checks: "read",
    contents: "read",
    metadata: "read",
    pull_requests: "read",
    statuses: "read",
  },
  gh: {
    actions: "read",
    checks: "read",
    contents: "read",
    metadata: "read",
    pull_requests: "write",
  },
};
const maxResponseBytes = 64 * 1024;
const refreshMarginMs = 60_000;

type CachedCredential = Readonly<{
  value: GitHubCredential;
  expiresAtMs: number;
}>;

export class GitHubAppBroker {
  readonly #appId: string;
  readonly #installationId: number;
  readonly #privateKey: string;
  readonly #apiUrl: URL;
  readonly #timeoutMs: number;
  readonly #refreshMarginMs: number;
  readonly #now: () => number;
  readonly #cache = new Map<string, CachedCredential>();
  readonly #inFlight = new Map<
    string,
    Promise<GitHubBrokerResult<GitHubCredential>>
  >();

  constructor(config: GitHubAppBrokerConfig) {
    if (
      !config.appId ||
      !Number.isSafeInteger(config.installationId) ||
      config.installationId < 1
    )
      throw new Error("GitHub App and installation IDs must be configured");
    const apiUrl = new URL(config.apiUrl ?? "https://api.github.com/");
    if (apiUrl.protocol !== "https:" && apiUrl.protocol !== "http:")
      throw new Error("GitHub API URL must use HTTP or HTTPS");
    if (
      apiUrl.username !== "" ||
      apiUrl.password !== "" ||
      apiUrl.search !== "" ||
      apiUrl.hash !== ""
    )
      throw new Error(
        "GitHub API URL must not contain credentials, query, or fragment",
      );
    if (
      apiUrl.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "::1"].includes(apiUrl.hostname)
    ) {
      throw new Error(
        "GitHub API HTTP is permitted only for loopback fixtures",
      );
    }
    apiUrl.pathname = apiUrl.pathname.endsWith("/")
      ? apiUrl.pathname
      : `${apiUrl.pathname}/`;
    apiUrl.search = "";
    apiUrl.hash = "";
    this.#appId = config.appId;
    this.#installationId = config.installationId;
    this.#privateKey = config.privateKey.replaceAll("\\n", "\n");
    this.#apiUrl = apiUrl;
    this.#timeoutMs = config.timeoutMs ?? 10_000;
    this.#refreshMarginMs = config.refreshMarginMs ?? refreshMarginMs;
    this.#now = config.now ?? Date.now;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1)
      throw new Error("GitHub API timeout must be a positive integer");
    if (
      !Number.isSafeInteger(this.#refreshMarginMs) ||
      this.#refreshMarginMs < 0
    )
      throw new Error("GitHub token refresh margin must be nonnegative");
  }

  async credential(
    repositoryUrl: string,
    purpose: GitHubCredentialPurpose,
  ): Promise<GitHubBrokerResult<GitHubCredential>> {
    const repository = parseGitHubRepository(repositoryUrl);
    if (!repository.ok) return repository;
    const cacheKey = `${repository.value.toLowerCase()}\0${purpose}`;
    const cached = this.#cache.get(cacheKey);
    if (
      cached !== undefined &&
      cached.expiresAtMs > this.#now() + this.#refreshMarginMs
    )
      return { ok: true, value: cached.value };
    const active = this.#inFlight.get(cacheKey);
    if (active !== undefined) return active;
    const request = this.#requestCredential(repository.value, purpose);
    this.#inFlight.set(cacheKey, request);
    let result: GitHubBrokerResult<GitHubCredential>;
    try {
      result = await request;
    } catch {
      result = failure(
        "transport",
        "github_transport_error",
        "GitHub token service is unavailable",
      );
    } finally {
      this.#inFlight.delete(cacheKey);
    }
    if (result.ok) {
      const expiresAtMs = Date.parse(result.value.expiresAt);
      if (Number.isFinite(expiresAtMs))
        this.#cache.set(cacheKey, { value: result.value, expiresAtMs });
    }
    return result;
  }

  async #requestCredential(
    repository: string,
    purpose: GitHubCredentialPurpose,
  ): Promise<GitHubBrokerResult<GitHubCredential>> {
    let appJwt: string;
    try {
      const key = await importPKCS8(this.#privateKey, "RS256");
      const issuedAt = Math.floor(this.#now() / 1000);
      appJwt = await new SignJWT({})
        .setProtectedHeader({ alg: "RS256", typ: "JWT" })
        .setIssuer(this.#appId)
        .setIssuedAt(issuedAt - 60)
        .setExpirationTime(issuedAt + 9 * 60)
        .sign(key);
    } catch {
      return failure(
        "jwt",
        "github_app_jwt_error",
        "GitHub App JWT could not be created",
      );
    }

    let response: Response;
    try {
      response = await fetch(
        new URL(
          `app/installations/${this.#installationId}/access_tokens`,
          this.#apiUrl,
        ),
        {
          method: "POST",
          headers: {
            accept: "application/vnd.github+json",
            "content-type": "application/json",
            "user-agent": "anvil-github-broker/0.1",
            "x-github-api-version": "2022-11-28",
            authorization: `Bearer ${appJwt}`,
          },
          body: JSON.stringify({
            repositories: [repository.split("/")[1]],
            permissions: permissionProfiles[purpose],
          }),
          signal: AbortSignal.timeout(this.#timeoutMs),
        },
      );
    } catch {
      return failure(
        "transport",
        "github_transport_error",
        "GitHub token service is unavailable",
      );
    }

    const requestId = safeHeader(response.headers.get("x-github-request-id"));
    let bodyText: string;
    try {
      bodyText = await readBounded(response, maxResponseBytes);
    } catch {
      return {
        ok: false,
        error: {
          kind: response.ok ? "malformed_response" : "upstream",
          diagnostic: {
            code: "github_malformed_response",
            message: "GitHub returned an oversized or unreadable response",
            upstreamStatus: response.status,
            ...(requestId === undefined ? {} : { requestId }),
          },
        },
      };
    }
    let body: unknown;
    try {
      body = bodyText === "" ? null : JSON.parse(bodyText);
    } catch {
      body = null;
    }
    if (!response.ok) {
      const parsed = asRecord(body);
      const code = upstreamCode(response.status);
      const documentationUrl = sanitize(parsed?.["documentation_url"]);
      return {
        ok: false,
        error: {
          kind: "upstream",
          diagnostic: {
            code,
            message: `GitHub rejected the request (HTTP ${response.status})`,
            upstreamStatus: response.status,
            ...(requestId === undefined ? {} : { requestId }),
            ...(documentationUrl === undefined ? {} : { documentationUrl }),
          },
        },
      };
    }

    const parsed = asRecord(body);
    const token = parsed?.["token"];
    const expiresAt = parsed?.["expires_at"];
    const expiresAtMs =
      typeof expiresAt === "string" ? Date.parse(expiresAt) : NaN;
    const actualPermissions = parsePermissions(parsed?.["permissions"]);
    if (
      typeof token !== "string" ||
      token.length === 0 ||
      typeof expiresAt !== "string" ||
      !Number.isFinite(expiresAtMs) ||
      expiresAtMs <= this.#now() ||
      actualPermissions === null
    ) {
      return {
        ok: false,
        error: {
          kind: "malformed_response",
          diagnostic: {
            code: "github_malformed_response",
            message: "GitHub returned a malformed installation-token response",
            upstreamStatus: response.status,
            ...(requestId === undefined ? {} : { requestId }),
          },
        },
      };
    }
    if (!permissionsWithin(actualPermissions, permissionProfiles[purpose])) {
      return failure(
        "scope_mismatch",
        "github_token_scope_mismatch",
        "GitHub returned permissions broader than the requested profile",
        response.status,
        requestId,
      );
    }
    return {
      ok: true,
      value: {
        token,
        tokenType: "installation",
        expiresAt,
        repository,
        permissions: permissionProfiles[purpose],
      },
    };
  }
}

export function parseGitHubRepository(
  value: string,
): GitHubBrokerResult<string> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return failure(
      "repository",
      "github_repository_validation_failed",
      "Repository URL is invalid",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return failure(
      "repository",
      "github_repository_validation_failed",
      "GitHub credentials require an HTTPS github.com repository URL",
    );
  }
  const parts = url.pathname.split("/").filter((part) => part.length > 0);
  if (
    parts.length !== 2 ||
    parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part)) ||
    parts.some((part) => part === "." || part === "..")
  ) {
    return failure(
      "repository",
      "github_repository_validation_failed",
      "Repository URL must identify exactly github.com/<owner>/<repository>",
    );
  }
  const name = parts[1]!.replace(/\.git$/i, "");
  return name.length === 0
    ? failure(
        "repository",
        "github_repository_validation_failed",
        "Repository name is empty",
      )
    : { ok: true, value: `${parts[0]}/${name}` };
}

function parsePermissions(
  value: unknown,
): Record<string, GitHubPermission> | null {
  const record = asRecord(value);
  if (record === null) return null;
  const permissions: Record<string, GitHubPermission> = {};
  for (const [name, permission] of Object.entries(record)) {
    if (permission !== "read" && permission !== "write") return null;
    permissions[name] = permission;
  }
  return Object.keys(permissions).length === 0 ? null : permissions;
}

function permissionsWithin(
  actual: Readonly<Record<string, GitHubPermission>>,
  requested: Readonly<Record<string, GitHubPermission>>,
): boolean {
  return Object.entries(actual).every(([name, permission]) => {
    if (name === "metadata" && permission === "read") return true;
    const allowed = requested[name];
    return (
      allowed !== undefined && !(allowed === "read" && permission === "write")
    );
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sanitize(value: unknown): string | undefined {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 512)
    : undefined;
}

function safeHeader(value: string | null): string | undefined {
  return value === null
    ? undefined
    : value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 128);
}

function upstreamCode(status: number): string {
  if (status === 401) return "github_app_authentication_failed";
  if (status === 403) return "github_upstream_forbidden";
  if (status === 404) return "github_installation_repository_mismatch";
  if (status === 422) return "github_token_scope_rejected";
  if (status >= 500) return "github_upstream_failure";
  return "github_upstream_rejected";
}

function failure(
  kind: GitHubBrokerError["kind"],
  code: string,
  message: string,
  upstreamStatus?: number,
  requestId?: string,
): GitHubBrokerResult<never> {
  return {
    ok: false,
    error: {
      kind,
      diagnostic: {
        code,
        message,
        ...(upstreamStatus === undefined ? {} : { upstreamStatus }),
        ...(requestId === undefined ? {} : { requestId }),
      },
    },
  };
}

async function readBounded(
  response: Response,
  maximum: number,
): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximum)
    throw new Error("GitHub response too large");
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
        throw new Error("GitHub response too large");
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
