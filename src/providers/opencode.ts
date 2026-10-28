import { createHash } from "node:crypto";
import type { ProviderResult } from "../application";
import type { Operation } from "../domain";

const maxResponseBytes = 2 * 1024 * 1024;

export type OpenCodeInfo = Readonly<{ version: string }>;
export type OpenCodeSession = Readonly<{ id: string }>;
export type OpenCodeActiveSession = Readonly<{ id: string }>;
export type OpenCodeMessage = Readonly<{
  id: string;
  type: string;
  parentID?: string;
}>;

export class OpenCodeAdapter {
  readonly #base: URL;
  readonly #password: string | undefined;
  readonly #timeoutMs: number;

  constructor(
    options: Readonly<{
      baseUrl: string;
      password?: string;
      timeoutMs?: number;
    }>,
  ) {
    const base = new URL(options.baseUrl);
    if (base.protocol !== "https:" && base.protocol !== "http:")
      throw new Error("OpenCode URL must use HTTP or HTTPS");
    if (
      base.username !== "" ||
      base.password !== "" ||
      base.search !== "" ||
      base.hash !== ""
    )
      throw new Error(
        "OpenCode base URL must not include credentials, query, or fragment",
      );
    if (
      options.password !== undefined &&
      base.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "::1"].includes(base.hostname)
    ) {
      throw new Error(
        "OpenCode Basic credentials require HTTPS outside loopback",
      );
    }
    base.pathname = base.pathname.endsWith("/")
      ? base.pathname
      : `${base.pathname}/`;
    this.#base = base;
    this.#password = options.password;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1)
      throw new Error("OpenCode request timeout must be a positive integer");
  }

  async health(): Promise<ProviderResult<OpenCodeInfo>> {
    const result = await this.#request("api/info", { method: "GET" });
    if (!result.ok) return result;
    const version = record(result.value)?.["version"];
    return typeof version === "string" && version.startsWith("2.")
      ? { ok: true, value: { version } }
      : {
          ok: false,
          error: {
            kind: "rejected",
            message: "OpenCode API version is not a supported V2 contract",
          },
        };
  }

  async createSession(): Promise<ProviderResult<OpenCodeSession>> {
    const result = await this.#request("api/session", {
      method: "POST",
      body: "{}",
    });
    if (!result.ok) return result;
    const data = record(result.value)?.["data"];
    const id = record(data)?.["id"];
    return typeof id === "string" && id.length > 0
      ? { ok: true, value: { id } }
      : {
          ok: false,
          error: {
            kind: "acknowledgement_lost",
            message: "OpenCode session response did not include a session ID",
          },
        };
  }

  async sessionExists(sessionId: string): Promise<ProviderResult<boolean>> {
    const result = await this.#request(
      `api/session/${encodeURIComponent(sessionId)}`,
      { method: "GET" },
    );
    if (!result.ok && result.error.kind === "rejected") {
      if (result.error.message === "OpenCode returned HTTP 404")
        return { ok: true, value: false };
    }
    return result.ok ? { ok: true, value: true } : result;
  }

  async messages(
    sessionId: string,
  ): Promise<ProviderResult<readonly OpenCodeMessage[]>> {
    const path = `api/session/${encodeURIComponent(sessionId)}/message?limit=100`;
    const result = await this.#request(path, { method: "GET" });
    if (!result.ok) return result;
    const rows = record(result.value)?.["data"];
    if (!Array.isArray(rows))
      return {
        ok: false,
        error: {
          kind: "unavailable",
          message: "OpenCode message response did not contain a data array",
        },
      };
    const parsed: OpenCodeMessage[] = [];
    for (const row of rows) {
      const item = record(row);
      if (
        item === null ||
        typeof item["id"] !== "string" ||
        typeof item["type"] !== "string"
      ) {
        return {
          ok: false,
          error: {
            kind: "unavailable",
            message: "OpenCode message response contained an invalid message",
          },
        };
      }
      parsed.push({
        id: item["id"],
        type: item["type"],
        ...(typeof item["parentID"] === "string"
          ? { parentID: item["parentID"] }
          : {}),
      });
    }
    return { ok: true, value: parsed };
  }

  async activeSessions(): Promise<
    ProviderResult<readonly OpenCodeActiveSession[]>
  > {
    const result = await this.#request("api/session/active", { method: "GET" });
    if (!result.ok) return result;
    const rows = record(result.value)?.["data"];
    if (!Array.isArray(rows))
      return {
        ok: false,
        error: {
          kind: "unavailable",
          message:
            "OpenCode active-session response did not contain a data array",
        },
      };
    const sessions: OpenCodeActiveSession[] = [];
    for (const row of rows) {
      const id = typeof row === "string" ? row : record(row)?.["id"];
      if (typeof id !== "string" || id.length === 0)
        return {
          ok: false,
          error: {
            kind: "unavailable",
            message:
              "OpenCode active-session response contained an invalid session",
          },
        };
      sessions.push({ id });
    }
    return { ok: true, value: sessions };
  }

  async dispatchInstruction(
    sessionId: string,
    operation: Operation,
    model: Readonly<{ providerId: string; modelId: string }>,
  ): Promise<ProviderResult<Readonly<{ messageId: string }>>> {
    if (
      operation.kind !== "continue" &&
      operation.kind !== "repair" &&
      operation.kind !== "refresh_context" &&
      operation.kind !== "change_strategy"
    ) {
      return {
        ok: false,
        error: {
          kind: "rejected",
          message: "Operation is not an OpenCode instruction",
        },
      };
    }
    const id = openCodeMessageId(operation.id);
    const sessionPath = `api/session/${encodeURIComponent(sessionId)}`;
    const selected = await this.#request(`${sessionPath}/model`, {
      method: "POST",
      body: JSON.stringify({
        providerID: model.providerId,
        modelID: model.modelId,
      }),
    });
    if (!selected.ok) return selected;

    const prompt = await this.#request(`${sessionPath}/prompt`, {
      method: "POST",
      body: JSON.stringify({ id, text: operation.directive }),
    });
    if (!prompt.ok) return prompt;
    const responseId = record(record(prompt.value)?.["data"])?.["id"];
    return responseId === id
      ? { ok: true, value: { messageId: id } }
      : {
          ok: false,
          error: {
            kind: "acknowledgement_lost",
            message: "OpenCode prompt response did not confirm its message ID",
          },
        };
  }

  async inspectInstruction(
    sessionId: string,
    operation: Operation,
  ): Promise<ProviderResult<Operation["outcome"] | null>> {
    if (
      operation.kind !== "continue" &&
      operation.kind !== "repair" &&
      operation.kind !== "refresh_context" &&
      operation.kind !== "change_strategy"
    ) {
      return {
        ok: false,
        error: {
          kind: "rejected",
          message: "Operation is not an OpenCode instruction",
        },
      };
    }
    const result = await this.messages(sessionId);
    if (!result.ok) return result;
    const expectedId = openCodeMessageId(operation.id);
    const userMessages = result.value.filter(
      (message) => message.type === "user" && message.id === expectedId,
    );
    if (userMessages.length !== 1) {
      // Message absence does not prove a timed-out request cannot still arrive.
      // Duplicate or absent identities therefore stay ambiguous and are never
      // converted into retrySafe evidence.
      return { ok: true, value: null };
    }
    const assistantReplies = result.value.filter(
      (message) =>
        message.type === "assistant" && message.parentID === expectedId,
    );
    if (assistantReplies.length > 1) return { ok: true, value: null };
    return {
      ok: true,
      value: {
        kind: "observed",
        observedAt: Date.now(),
        source: "OpenCode V2 message inspection",
        result: "applied",
        retrySafe: false,
        externalIdentity: expectedId,
      },
    };
  }

  static messageIdForOperation(operationId: string): string {
    return openCodeMessageId(operationId);
  }

  async #request(
    path: string,
    options: Readonly<{ method: "GET" | "POST"; body?: string }>,
  ): Promise<ProviderResult<unknown>> {
    const url = new URL(path, this.#base);
    const headers = new Headers({ accept: "application/json" });
    if (options.body !== undefined)
      headers.set("content-type", "application/json");
    if (this.#password !== undefined) {
      const credentials = Buffer.from(`opencode:${this.#password}`).toString(
        "base64",
      );
      headers.set("authorization", `Basic ${credentials}`);
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method: options.method,
        headers,
        ...(options.body === undefined ? {} : { body: options.body }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      return {
        ok: false,
        error: {
          kind:
            options.method === "POST" ? "acknowledgement_lost" : "unavailable",
          message:
            options.method === "POST"
              ? "OpenCode request acknowledgement was lost; inspect before any retry"
              : "OpenCode service is unavailable",
        },
      };
    }
    if (response.status === 404)
      return {
        ok: false,
        error: { kind: "rejected", message: "OpenCode returned HTTP 404" },
      };
    if (!response.ok) {
      return {
        ok: false,
        error: {
          kind:
            options.method === "POST" &&
            (response.status >= 500 || response.status === 409)
              ? "acknowledgement_lost"
              : "rejected",
          message: `OpenCode returned HTTP ${response.status}`,
        },
      };
    }
    try {
      const bytes = await readBounded(response, maxResponseBytes);
      return {
        ok: true,
        value: bytes.length === 0 ? null : JSON.parse(bytes),
      };
    } catch {
      return {
        ok: false,
        error: {
          kind:
            options.method === "POST" ? "acknowledgement_lost" : "unavailable",
          message: "OpenCode response was invalid or exceeded its size limit",
        },
      };
    }
  }
}

function openCodeMessageId(operationId: string): string {
  return `anvil_${createHash("sha256").update(operationId).digest("hex").slice(0, 40)}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function readBounded(
  response: Response,
  maximum: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximum)
    throw new Error("OpenCode response exceeded size limit");
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
        throw new Error("OpenCode response exceeded size limit");
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
