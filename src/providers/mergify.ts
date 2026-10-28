import { parseGitHubRepository } from "./github-app";

export type MergifyCheck = Readonly<{
  name: string;
  state: string;
}>;

export type MergifyQueueFact = Readonly<{
  pullRequestNumber: number;
  queuedAt: string;
  position: number;
  ciState: "pending" | "success" | "failed";
  state: string;
  checks: readonly MergifyCheck[];
}>;

export type MergifyError = Readonly<{
  kind: "credentials" | "unavailable" | "invalid_response";
  message: string;
  upstreamStatus?: number;
}>;

export type MergifyResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: MergifyError }>;

export type MergifyClientConfig = Readonly<{
  apiUrl?: string;
  bearerToken: string;
  timeoutMs?: number;
}>;

export class MergifyQueueClient {
  readonly #base: URL;
  readonly #token: string;
  readonly #timeoutMs: number;

  constructor(config: MergifyClientConfig) {
    const base = new URL(config.apiUrl ?? "https://api.mergify.com/v1/");
    if (base.protocol !== "https:" && base.protocol !== "http:")
      throw new Error("Mergify API URL must use HTTP or HTTPS");
    if (
      base.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "::1"].includes(base.hostname)
    ) {
      throw new Error(
        "Mergify API HTTP is permitted only for loopback fixtures",
      );
    }
    if (base.username || base.password || base.search || base.hash)
      throw new Error(
        "Mergify API URL must not contain credentials, query, or fragment",
      );
    if (config.bearerToken.length === 0)
      throw new Error("Mergify API bearer token must not be empty");
    base.pathname = base.pathname.endsWith("/")
      ? base.pathname
      : `${base.pathname}/`;
    this.#base = base;
    this.#token = config.bearerToken;
    this.#timeoutMs = config.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1)
      throw new Error("Mergify API timeout must be a positive integer");
  }

  async pullRequestQueue(
    repositoryUrl: string,
    pullRequestNumber: number,
  ): Promise<MergifyResult<MergifyQueueFact | null>> {
    const repository = parseGitHubRepository(repositoryUrl);
    if (!repository.ok)
      return {
        ok: false,
        error: {
          kind: "invalid_response",
          message: repository.error.diagnostic.message,
        },
      };
    if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1)
      return {
        ok: false,
        error: {
          kind: "invalid_response",
          message: "Pull request number is invalid",
        },
      };
    const [owner, name] = repository.value.split("/") as [string, string];
    let response: Response;
    try {
      response = await fetch(
        new URL(
          `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/merge-queue/pull/${pullRequestNumber}`,
          this.#base,
        ),
        {
          headers: {
            accept: "application/json",
            authorization: `Bearer ${this.#token}`,
          },
          signal: AbortSignal.timeout(this.#timeoutMs),
        },
      );
    } catch {
      return {
        ok: false,
        error: { kind: "unavailable", message: "Mergify API is unavailable" },
      };
    }
    let bodyText: string;
    try {
      bodyText = await boundedBody(response, 1_048_576);
    } catch {
      return {
        ok: false,
        error: {
          kind: "unavailable",
          message: "Mergify API response was oversized or unreadable",
          upstreamStatus: response.status,
        },
      };
    }
    let value: unknown;
    try {
      value = bodyText === "" ? null : JSON.parse(bodyText);
    } catch {
      return {
        ok: false,
        error: {
          kind: "invalid_response",
          message: "Mergify API returned invalid JSON",
        },
      };
    }
    if (response.status === 404) {
      const record = asRecord(value);
      return record?.["error_code"] === "PULL_REQUEST_NOT_QUEUED"
        ? { ok: true, value: null }
        : {
            ok: false,
            error: {
              kind: "unavailable",
              message: "Mergify repository or pull request was not found",
              upstreamStatus: 404,
            },
          };
    }
    if (response.status === 401 || response.status === 403)
      return {
        ok: false,
        error: {
          kind: "credentials",
          message: `Mergify API authorization failed (${response.status})`,
          upstreamStatus: response.status,
        },
      };
    if (!response.ok)
      return {
        ok: false,
        error: {
          kind: "unavailable",
          message: `Mergify API returned HTTP ${response.status}`,
          upstreamStatus: response.status,
        },
      };
    return parseQueueFact(value, pullRequestNumber);
  }
}

function parseQueueFact(
  value: unknown,
  expectedNumber: number,
): MergifyResult<MergifyQueueFact> {
  const item = asRecord(value);
  const number = item?.["number"];
  const queuedAt = item?.["queued_at"];
  const position = item?.["position"];
  const ciState = item?.["ci_state"];
  const state = item?.["state"];
  const checks = item?.["checks"];
  if (
    number !== expectedNumber ||
    typeof queuedAt !== "string" ||
    !Number.isFinite(Date.parse(queuedAt)) ||
    !Number.isSafeInteger(position) ||
    (ciState !== "pending" && ciState !== "success" && ciState !== "failed") ||
    typeof state !== "string" ||
    !Array.isArray(checks)
  ) {
    return {
      ok: false,
      error: {
        kind: "invalid_response",
        message: "Mergify queue response was malformed",
      },
    };
  }
  const parsedChecks: MergifyCheck[] = [];
  for (const check of checks) {
    const row = asRecord(check);
    if (typeof row?.["name"] !== "string" || typeof row["state"] !== "string")
      return {
        ok: false,
        error: {
          kind: "invalid_response",
          message: "Mergify check response was malformed",
        },
      };
    parsedChecks.push({ name: row["name"], state: row["state"] });
  }
  return {
    ok: true,
    value: {
      pullRequestNumber: number,
      queuedAt,
      position: position as number,
      ciState,
      state,
      checks: parsedChecks,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function boundedBody(
  response: Response,
  maximum: number,
): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximum)
    throw new Error("Mergify response exceeded limit");
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
        throw new Error("Mergify response exceeded limit");
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
