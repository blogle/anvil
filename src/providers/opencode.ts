import { createHash } from "node:crypto";
import type { ProviderResult } from "../application";
import type { ExecutionObservation, Operation } from "../domain";

const maxResponseBytes = 2 * 1024 * 1024;
const maxEventFrameBytes = 2 * 1024 * 1024;
const watchdogPollIntervalMs = 5_000;
const contextPressureRatio = 0.85;
const watchdogEventTypes = [
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.status",
  "session.idle",
  "session.step.started",
  "session.step.streamed",
  "session.step.failed",
  "session.step.ended",
  "session.tool.called",
  "session.tool.failed",
  "session.tool.success",
  "session.tool.progress",
  "session.retry.scheduled",
  "session.compaction.ended",
  "session.compaction.failed",
] as const;

export type OpenCodeInfo = Readonly<{ version: string }>;
export type OpenCodeSession = Readonly<{ id: string }>;
export type OpenCodeActiveSession = Readonly<{
  id: string;
  status: "busy" | "running" | "retry";
}>;
type OpenCodeToolState = Readonly<{
  name: string;
  status: "streaming" | "running" | "completed" | "error";
  progressAt: number | null;
}>;
export type OpenCodeMessage = Readonly<{
  id: string;
  type: string;
  parentID?: string;
  createdAt?: number;
  streamedAt?: number;
  completedAt?: number;
  tokenCount?: number;
  tools?: readonly OpenCodeToolState[];
}>;

export class OpenCodeAdapter {
  readonly #base: URL;
  readonly #password: string | undefined;
  readonly #timeoutMs: number;
  #modelLimits: ReadonlyMap<string, number> | undefined;
  readonly #executionSnapshots = new Map<
    string,
    Readonly<{ refreshAfter: number; observation: ExecutionObservation }>
  >();

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
      base.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "::1"].includes(base.hostname)
    ) {
      throw new Error("OpenCode HTTP is permitted only for loopback fixtures");
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
    const path = `api/session/${encodeURIComponent(sessionId)}/message?limit=50&order=desc`;
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
      const createdAt = optionalTime(record(item["time"])?.["created"]);
      const streamedAt = optionalTime(record(item["time"])?.["streamed"]);
      const completedAt = optionalTime(record(item["time"])?.["completed"]);
      const tokens = record(item["tokens"]);
      const tokenInput = optionalCount(tokens?.["input"]);
      const toolParts = Array.isArray(item["content"]) ? item["content"] : [];
      const tools: OpenCodeToolState[] = [];
      for (const partValue of toolParts) {
        const part = record(partValue);
        if (part?.["type"] !== "tool") continue;
        const state = record(part["state"]);
        const status = state?.["status"];
        const name = part["name"];
        if (
          typeof name !== "string" ||
          (status !== "streaming" &&
            status !== "running" &&
            status !== "completed" &&
            status !== "error")
        ) {
          return {
            ok: false,
            error: {
              kind: "unavailable",
              message: "OpenCode message contained an invalid tool part",
            },
          };
        }
        const time = record(part["time"]);
        tools.push({
          name,
          status,
          progressAt:
            optionalTime(time?.["completed"]) ??
            optionalTime(time?.["ran"]) ??
            optionalTime(time?.["created"]),
        });
      }
      parsed.push({
        id: item["id"],
        type: item["type"],
        ...(typeof item["parentID"] === "string"
          ? { parentID: item["parentID"] }
          : {}),
        ...(createdAt === null ? {} : { createdAt }),
        ...(streamedAt === null ? {} : { streamedAt }),
        ...(completedAt === null ? {} : { completedAt }),
        ...(tokenInput === null ? {} : { tokenCount: tokenInput }),
        tools,
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
    if (rows === null || typeof rows !== "object" || Array.isArray(rows))
      return {
        ok: false,
        error: {
          kind: "unavailable",
          message:
            "OpenCode active-session response did not contain a data array",
        },
      };
    const sessions: OpenCodeActiveSession[] = [];
    for (const [id, value] of Object.entries(rows)) {
      const status = record(value)?.["type"];
      if (
        id.length === 0 ||
        (status !== "busy" && status !== "running" && status !== "retry")
      )
        return {
          ok: false,
          error: {
            kind: "unavailable",
            message:
              "OpenCode active-session response contained an invalid session",
          },
        };
      sessions.push({ id, status });
    }
    return { ok: true, value: sessions };
  }

  async observeExecution(
    sessionId: string,
    now: number,
    model: Readonly<{ providerId: string; modelId: string }>,
  ): Promise<ExecutionObservation> {
    const cached = this.#executionSnapshots.get(sessionId);
    if (cached !== undefined && now < cached.refreshAfter)
      return cached.observation;
    const observation = await this.#readExecution(sessionId, now, model);
    const snapshot = {
      ...observation,
      expiresAt: now + watchdogPollIntervalMs,
    };
    this.#executionSnapshots.set(sessionId, {
      refreshAfter: now + watchdogPollIntervalMs,
      observation: snapshot,
    });
    return snapshot;
  }

  async #readExecution(
    sessionId: string,
    now: number,
    model: Readonly<{ providerId: string; modelId: string }>,
  ): Promise<ExecutionObservation> {
    const active = await this.activeSessions();
    if (!active.ok)
      return {
        kind: "unavailable",
        reason: active.error.message,
        observedAt: now,
        expiresAt: now + 1_000,
        source: "opencode-v2",
      };
    if (!active.value.some(({ id }) => id === sessionId))
      return {
        kind: "idle",
        sessionId,
        observedAt: now,
        expiresAt: now + 1_000,
        source: "opencode-v2",
      };
    const messages = await this.messages(sessionId);
    if (!messages.ok)
      return {
        kind: "unknown",
        reason: messages.error.message,
        observedAt: now,
        expiresAt: now + 1_000,
        source: "opencode-v2",
      };
    const assistants = messages.value.filter(
      ({ type }) => type === "assistant",
    );
    const latest = assistants[0];
    const contextLimit = await this.#contextLimit(
      model.providerId,
      model.modelId,
    );
    const contextTokens = latest?.tokenCount ?? null;
    const toolParts = latest?.tools ?? [];
    const repeatedToolFailures = toolParts
      .filter(({ status }) => status === "error")
      .slice(0, 12)
      .map(({ name }) => `tool:${name}:error`);
    const progressTimes = messages.value.flatMap((message) => [
      ...(message.streamedAt === undefined ? [] : [message.streamedAt]),
      ...(message.completedAt === undefined ? [] : [message.completedAt]),
      ...(message.createdAt === undefined ? [] : [message.createdAt]),
      ...(message.tools ?? []).flatMap(({ progressAt }) =>
        progressAt === null ? [] : [progressAt],
      ),
    ]);
    const lastProgressAt =
      progressTimes.length === 0 ? null : Math.max(...progressTimes);
    const hasActiveTool = toolParts.some(
      ({ status }) => status === "running" || status === "streaming",
    );
    return {
      kind: "running",
      sessionId,
      contextPressure:
        contextLimit !== null &&
        contextTokens !== null &&
        contextTokens / contextLimit >= contextPressureRatio,
      contextTokens,
      contextLimitTokens: contextLimit,
      repeatedToolFailures,
      lastProgressAt,
      safeBoundary: !hasActiveTool && latest?.completedAt !== undefined,
      observedAt: now,
      expiresAt: now + 1_000,
      source: "opencode-v2",
    };
  }

  async interruptSession(
    sessionId: string,
    model: Readonly<{ providerId: string; modelId: string }>,
    now: number,
  ): Promise<ProviderResult<boolean>> {
    const current = await this.#readExecution(sessionId, now, model);
    if (current.kind === "unknown" || current.kind === "unavailable")
      return {
        ok: false,
        error: { kind: "unavailable", message: current.reason },
      };
    if (current.kind === "idle") return { ok: true, value: false };
    if (current.kind !== "running")
      return {
        ok: false,
        error: { kind: "unavailable", message: "OpenCode status is unknown" },
      };
    if (!current.safeBoundary)
      return {
        ok: false,
        error: {
          kind: "rejected",
          message: "OpenCode no longer reports a safe interruption boundary",
        },
      };
    const result = await this.#request(
      `api/session/${encodeURIComponent(sessionId)}/interrupt?resume=false`,
      { method: "POST" },
    );
    if (!result.ok) return result;
    const response = record(result.value);
    const payload = response?.["data"] ?? result.value;
    const interrupted = record(payload)?.["interrupted"];
    return typeof interrupted === "boolean"
      ? { ok: true, value: interrupted }
      : {
          ok: false,
          error: {
            kind: "unavailable",
            message: "OpenCode interrupt response omitted its result",
          },
        };
  }

  async watchActivity(
    sessionId: string,
    onActivity: () => void,
    signal: AbortSignal,
  ): Promise<void> {
    const url = new URL("api/event", this.#base);
    const headers = new Headers({ accept: "text/event-stream" });
    if (this.#password !== undefined) {
      const credentials = Buffer.from(`opencode:${this.#password}`).toString(
        "base64",
      );
      headers.set("authorization", `Basic ${credentials}`);
    }
    let retryDelayMs = 250;
    while (!signal.aborted) {
      let response: Response;
      try {
        response = await fetch(url, { headers, signal });
      } catch {
        if (signal.aborted) return;
        retryDelayMs = await reconnectDelay(retryDelayMs, signal);
        continue;
      }
      if ([400, 401, 403, 404].includes(response.status)) {
        await response.body?.cancel();
        return;
      }
      if (!response.ok || response.body === null) {
        await response.body?.cancel();
        retryDelayMs = await reconnectDelay(retryDelayMs, signal);
        continue;
      }
      onActivity();
      retryDelayMs = 250;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer = (buffer + decoder.decode(value, { stream: true })).replace(
            /\r\n/g,
            "\n",
          );
          if (buffer.length > maxEventFrameBytes) {
            await reader.cancel();
            break;
          }
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (eventWakesSession(frame, sessionId)) {
              this.#executionSnapshots.clear();
              onActivity();
            }
            boundary = buffer.indexOf("\n\n");
          }
        }
      } catch {
        if (signal.aborted) return;
      } finally {
        reader.releaseLock();
      }
      if (signal.aborted) return;
      this.#executionSnapshots.clear();
      onActivity();
      retryDelayMs = await reconnectDelay(retryDelayMs, signal);
    }
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
    observedAt = Date.now(),
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
        observedAt,
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

  async #contextLimit(
    providerId: string,
    modelId: string,
  ): Promise<number | null> {
    if (this.#modelLimits === undefined) {
      const result = await this.#request("api/model", { method: "GET" });
      if (!result.ok) return null;
      const rows = record(result.value)?.["data"];
      const limits = new Map<string, number>();
      if (Array.isArray(rows)) {
        for (const row of rows) {
          const item = record(row);
          const provider = item?.["providerID"];
          const model = item?.["modelID"];
          const limit = record(item?.["limit"])?.["context"];
          if (
            typeof provider === "string" &&
            typeof model === "string" &&
            typeof limit === "number" &&
            Number.isSafeInteger(limit) &&
            limit > 0
          )
            limits.set(`${provider}/${model}`, limit);
        }
      }
      if (limits.size === 0) return null;
      this.#modelLimits = limits;
    }
    return this.#modelLimits.get(`${providerId}/${modelId}`) ?? null;
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

function optionalTime(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function optionalCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function eventWakesSession(frame: string, sessionId: string): boolean {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
  if (data.length === 0) return false;
  let decoded: unknown;
  try {
    decoded = JSON.parse(data);
  } catch {
    return true;
  }
  const event = record(decoded);
  if (event === null) return true;
  const type = event["type"];
  if (type === "server.connected") return true;
  if (
    typeof type !== "string" ||
    !watchdogEventTypes.includes(type as (typeof watchdogEventTypes)[number])
  )
    return false;
  return (
    typeof event["sessionID"] !== "string" || event["sessionID"] === sessionId
  );
}

async function reconnectDelay(
  delayMs: number,
  signal: AbortSignal,
): Promise<number> {
  if (signal.aborted) return delayMs;
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    timer = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
  return Math.min(delayMs * 2, 10_000);
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
