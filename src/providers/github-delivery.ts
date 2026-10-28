import {
  GitHubAppBroker,
  parseGitHubRepository,
  type GitHubBrokerError,
  type GitHubCredentialPurpose,
} from "./github-app";

export type GitHubPullRequestFact = Readonly<{
  number: number;
  url: string;
  repository: string;
  state: "open" | "closed" | "merged";
  headSha: string;
  headRef: string;
  baseRef: string;
  observedAt: number;
  source: "github-rest";
}>;

export type GitHubCheckRun = Readonly<{
  id: number;
  name: string;
  headSha: string;
  status: "queued" | "in_progress" | "completed" | "unknown";
  conclusion: string | null;
  detailsUrl: string | null;
}>;

export type GitHubCheckSnapshot = Readonly<{
  revision: string;
  totalCount: number;
  complete: boolean;
  checkRuns: readonly GitHubCheckRun[];
  observedAt: number;
  source: "github-rest";
}>;

export type GitHubBranchFact = Readonly<{
  name: string;
  revision: string;
  observedAt: number;
  source: "github-rest";
}>;

export type GitHubDeliveryError = Readonly<{
  kind: "credentials" | "not_found" | "unavailable" | "invalid_response";
  message: string;
  upstreamStatus?: number;
  requestId?: string;
}>;

export type GitHubDeliveryResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: GitHubDeliveryError }>;

export type GitHubDeliveryConfig = Readonly<{
  apiUrl?: string;
  timeoutMs?: number;
  now?: () => number;
}>;

const maximumBodyBytes = 2 * 1024 * 1024;

export class GitHubDeliveryClient {
  readonly #credentials: GitHubAppBroker;
  readonly #apiUrl: URL;
  readonly #timeoutMs: number;
  readonly #now: () => number;

  constructor(credentials: GitHubAppBroker, config: GitHubDeliveryConfig = {}) {
    const apiUrl = new URL(config.apiUrl ?? "https://api.github.com/");
    if (apiUrl.protocol !== "https:" && apiUrl.protocol !== "http:")
      throw new Error("GitHub API URL must use HTTP or HTTPS");
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
    this.#credentials = credentials;
    this.#apiUrl = apiUrl;
    this.#timeoutMs = config.timeoutMs ?? 10_000;
    this.#now = config.now ?? Date.now;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1)
      throw new Error("GitHub API timeout must be a positive integer");
  }

  async pullRequest(
    repositoryUrl: string,
    number: number,
  ): Promise<GitHubDeliveryResult<GitHubPullRequestFact>> {
    if (!Number.isSafeInteger(number) || number < 1)
      return {
        ok: false,
        error: {
          kind: "invalid_response",
          message: "Pull request number is invalid",
        },
      };
    const repo = parseGitHubRepository(repositoryUrl);
    if (!repo.ok)
      return {
        ok: false,
        error: {
          kind: "invalid_response",
          message: repo.error.diagnostic.message,
        },
      };
    const result = await this.#get(repositoryUrl, `pulls/${number}`, "gh_read");
    if (!result.ok) return result;
    const data = asRecord(result.value);
    const head = asRecord(data?.["head"]);
    const base = asRecord(data?.["base"]);
    const state = data?.["state"];
    const merged = data?.["merged"];
    const factNumber = data?.["number"];
    const url = data?.["html_url"];
    const headSha = head?.["sha"];
    const headRef = head?.["ref"];
    const baseRef = base?.["ref"];
    if (
      factNumber !== number ||
      typeof url !== "string" ||
      typeof headSha !== "string" ||
      typeof headRef !== "string" ||
      typeof baseRef !== "string" ||
      (state !== "open" && state !== "closed") ||
      typeof merged !== "boolean"
    ) {
      return {
        ok: false,
        error: {
          kind: "invalid_response",
          message: "GitHub pull request response was malformed",
        },
      };
    }
    return {
      ok: true,
      value: {
        number,
        url,
        repository: repo.value,
        state: merged ? "merged" : state,
        headSha,
        headRef,
        baseRef,
        observedAt: this.#now(),
        source: "github-rest",
      },
    };
  }

  async checkRuns(
    repositoryUrl: string,
    revision: string,
  ): Promise<GitHubDeliveryResult<GitHubCheckSnapshot>> {
    if (revision.length === 0 || /[\u0000-\u0020]/.test(revision))
      return {
        ok: false,
        error: { kind: "invalid_response", message: "Git revision is invalid" },
      };
    const repo = parseGitHubRepository(repositoryUrl);
    if (!repo.ok)
      return {
        ok: false,
        error: {
          kind: "invalid_response",
          message: repo.error.diagnostic.message,
        },
      };
    const result = await this.#get(
      repositoryUrl,
      `commits/${encodeURIComponent(revision)}/check-runs?per_page=100`,
      "gh_read",
    );
    if (!result.ok) return result;
    const data = asRecord(result.value);
    const totalCount = data?.["total_count"];
    const rows = data?.["check_runs"];
    if (
      !Number.isSafeInteger(totalCount) ||
      (totalCount as number) < 0 ||
      !Array.isArray(rows)
    ) {
      return {
        ok: false,
        error: {
          kind: "invalid_response",
          message: "GitHub check-run response was malformed",
        },
      };
    }
    const checkRuns: GitHubCheckRun[] = [];
    for (const row of rows) {
      const item = asRecord(row);
      const id = item?.["id"];
      const name = item?.["name"];
      const headSha = item?.["head_sha"];
      const status = item?.["status"];
      const conclusion = item?.["conclusion"];
      const detailsUrl = item?.["details_url"];
      if (
        !Number.isSafeInteger(id) ||
        typeof name !== "string" ||
        typeof headSha !== "string" ||
        typeof status !== "string" ||
        !(conclusion === null || typeof conclusion === "string") ||
        !(detailsUrl === null || typeof detailsUrl === "string")
      ) {
        return {
          ok: false,
          error: {
            kind: "invalid_response",
            message: "GitHub returned a malformed check run",
          },
        };
      }
      checkRuns.push({
        id: id as number,
        name,
        headSha,
        status:
          status === "queued" ||
          status === "in_progress" ||
          status === "completed"
            ? status
            : "unknown",
        conclusion,
        detailsUrl,
      });
    }
    return {
      ok: true,
      value: {
        revision,
        totalCount: totalCount as number,
        complete: (totalCount as number) === checkRuns.length,
        checkRuns,
        observedAt: this.#now(),
        source: "github-rest",
      },
    };
  }

  async branch(
    repositoryUrl: string,
    branchName: string,
  ): Promise<GitHubDeliveryResult<GitHubBranchFact>> {
    if (branchName.length === 0 || /[\u0000-\u001f\u007f]/.test(branchName))
      return {
        ok: false,
        error: {
          kind: "invalid_response",
          message: "Git branch name is invalid",
        },
      };
    const repo = parseGitHubRepository(repositoryUrl);
    if (!repo.ok)
      return {
        ok: false,
        error: {
          kind: "invalid_response",
          message: repo.error.diagnostic.message,
        },
      };
    const result = await this.#get(
      repositoryUrl,
      `branches/${encodeURIComponent(branchName)}`,
      "gh_read",
    );
    if (!result.ok) return result;
    const data = asRecord(result.value);
    const commit = asRecord(data?.["commit"]);
    const name = data?.["name"];
    const revision = commit?.["sha"];
    return typeof name === "string" && typeof revision === "string"
      ? {
          ok: true,
          value: {
            name,
            revision,
            observedAt: this.#now(),
            source: "github-rest",
          },
        }
      : {
          ok: false,
          error: {
            kind: "invalid_response",
            message: "GitHub branch response was malformed",
          },
        };
  }

  async #get(
    repositoryUrl: string,
    path: string,
    purpose: GitHubCredentialPurpose,
  ): Promise<GitHubDeliveryResult<unknown>> {
    const repo = parseGitHubRepository(repositoryUrl);
    if (!repo.ok)
      return {
        ok: false,
        error: {
          kind: "invalid_response",
          message: repo.error.diagnostic.message,
        },
      };
    const credential = await this.#credentials.credential(
      repositoryUrl,
      purpose,
    );
    if (!credential.ok) return credentialError(credential.error);
    const [owner, name] = repo.value.split("/") as [string, string];
    const url = new URL(
      `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${path}`,
      this.#apiUrl,
    );
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "anvil-github-observer/0.1",
          "x-github-api-version": "2022-11-28",
          authorization: `Bearer ${credential.value.token}`,
        },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      return {
        ok: false,
        error: { kind: "unavailable", message: "GitHub API is unavailable" },
      };
    }
    const requestId = cleanHeader(response.headers.get("x-github-request-id"));
    let text: string;
    try {
      text = await readBounded(response, maximumBodyBytes);
    } catch {
      return {
        ok: false,
        error: {
          kind: "unavailable",
          message: "GitHub API response was oversized or unreadable",
          upstreamStatus: response.status,
          ...(requestId === undefined ? {} : { requestId }),
        },
      };
    }
    let value: unknown;
    try {
      value = text === "" ? null : JSON.parse(text);
    } catch {
      return {
        ok: false,
        error: {
          kind: "invalid_response",
          message: "GitHub API returned invalid JSON",
        },
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        error: {
          kind:
            response.status === 404
              ? "not_found"
              : response.status === 401 || response.status === 403
                ? "credentials"
                : "unavailable",
          message: `GitHub API returned HTTP ${response.status}`,
          upstreamStatus: response.status,
          ...(requestId === undefined ? {} : { requestId }),
        },
      };
    }
    return { ok: true, value };
  }
}

function credentialError(
  error: GitHubBrokerError,
): GitHubDeliveryResult<never> {
  return {
    ok: false,
    error: {
      kind: error.kind === "repository" ? "invalid_response" : "credentials",
      message: error.diagnostic.message,
      ...(error.diagnostic.upstreamStatus === undefined
        ? {}
        : { upstreamStatus: error.diagnostic.upstreamStatus }),
      ...(error.diagnostic.requestId === undefined
        ? {}
        : { requestId: error.diagnostic.requestId }),
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cleanHeader(value: string | null): string | undefined {
  return value === null
    ? undefined
    : value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 128);
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
