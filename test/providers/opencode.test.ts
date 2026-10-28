import { afterEach, expect, test } from "bun:test";
import { OpenCodeAdapter } from "../../src/providers/opencode";
import type { Operation } from "../../src/domain";

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

function startFixture(
  fetch: (request: Request) => Response | Promise<Response>,
): string {
  server = Bun.serve({ port: 0, fetch });
  return `http://127.0.0.1:${server.port}/`;
}

const operation: Operation = {
  id: "commission:assignment:attempt:1:continue|1|none||",
  logicalKey: "commission:assignment:attempt:1:continue|1|none||",
  commissionId: "commission",
  kind: "continue",
  target: "assignment:assignment",
  controllerId: "controller",
  ownerEpoch: 1,
  specificationGeneration: 1,
  assignmentId: "assignment",
  attemptId: "attempt",
  instructionSequence: 1,
  retryCount: 0,
  candidateRevision: null,
  findingIds: [],
  directive: "Continue the approved Commission work.",
  createdAt: 1,
  outcome: { kind: "prepared" },
};

test("OpenCode V2 adapter follows the pinned session/model/prompt API with bounded IDs", async () => {
  const seen: { path: string; authorization: string | null; body: unknown }[] =
    [];
  const baseUrl = startFixture(async (request) => {
    const url = new URL(request.url);
    const body =
      request.method === "POST" ? await request.json().catch(() => null) : null;
    seen.push({
      path: `${url.pathname}${url.search}`,
      authorization: request.headers.get("authorization"),
      body,
    });
    if (url.pathname === "/api/info")
      return Response.json({ version: "2.0.26+fixture" });
    if (url.pathname === "/api/session" && request.method === "POST")
      return Response.json({ data: { id: "session-fixture" } });
    if (url.pathname === "/api/session/active")
      return Response.json({
        data: { "session-fixture": { type: "running" } },
      });
    if (url.pathname === "/api/session/session-fixture/model")
      return new Response(null, { status: 204 });
    if (url.pathname === "/api/session/session-fixture/prompt")
      return Response.json({ data: { id: (body as { id: string }).id } });
    if (url.pathname === "/api/session/session-fixture/message")
      return Response.json({ data: [] });
    return Response.json({ message: "not found" }, { status: 404 });
  });
  const adapter = new OpenCodeAdapter({
    baseUrl,
    password: "fixture-password",
  });
  expect(await adapter.health()).toEqual({
    ok: true,
    value: { version: "2.0.26+fixture" },
  });
  expect(await adapter.createSession()).toEqual({
    ok: true,
    value: { id: "session-fixture" },
  });
  expect(await adapter.activeSessions()).toEqual({
    ok: true,
    value: [{ id: "session-fixture", status: "running" }],
  });
  const sent = await adapter.dispatchInstruction("session-fixture", operation, {
    providerId: "fixture-provider",
    modelId: "fixture-model",
  });
  expect(sent.ok).toBe(true);
  const id = OpenCodeAdapter.messageIdForOperation(operation.id);
  expect(id).toMatch(/^anvil_[a-f0-9]{40}$/);
  expect(seen.map(({ path }) => path)).toEqual([
    "/api/info",
    "/api/session",
    "/api/session/active",
    "/api/session/session-fixture/model",
    "/api/session/session-fixture/prompt",
  ]);
  expect(
    seen.every(({ authorization }) => authorization?.startsWith("Basic ")),
  ).toBe(true);
  expect(seen[3]?.body).toEqual({
    providerID: "fixture-provider",
    modelID: "fixture-model",
  });
  expect(seen[4]?.body).toEqual({
    id,
    text: "Continue the approved Commission work.",
  });
  expect(
    await adapter.inspectInstruction("session-fixture", operation),
  ).toEqual({
    ok: true,
    value: null,
  });
});

test("OpenCode watchdog derives active failures, progress, boundary, and token pressure from provider state", async () => {
  const now = 1_800_000_000_000;
  const baseUrl = startFixture((request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/session/active")
      return Response.json({
        data: { "session-watchdog": { type: "running" } },
      });
    if (url.pathname === "/api/session/session-watchdog/message")
      return Response.json({
        data: [
          {
            id: "assistant-latest",
            type: "assistant",
            time: {
              created: now - 120_000,
              streamed: now - 20_000,
              completed: now - 5_000,
            },
            tokens: {
              input: 8_600,
              output: 300,
              reasoning: 100,
              cache: { read: 100, write: 0 },
            },
            content: [
              {
                type: "tool",
                name: "test",
                time: {
                  created: now - 40_000,
                  ran: now - 38_000,
                  completed: now - 35_000,
                },
                state: {
                  status: "error",
                  input: {},
                  error: { name: "TestFailure" },
                },
              },
              {
                type: "tool",
                name: "lint",
                time: {
                  created: now - 30_000,
                  ran: now - 28_000,
                  completed: now - 25_000,
                },
                state: {
                  status: "error",
                  input: {},
                  error: { name: "LintFailure" },
                },
              },
              {
                type: "tool",
                name: "test",
                time: {
                  created: now - 20_000,
                  ran: now - 18_000,
                  completed: now - 15_000,
                },
                state: {
                  status: "error",
                  input: {},
                  error: { name: "TestFailure" },
                },
              },
            ],
          },
        ],
        cursor: { previous: null, next: null },
      });
    if (url.pathname === "/api/model")
      return Response.json({
        data: [
          {
            providerID: "fixture-provider",
            modelID: "fixture-model",
            limit: { context: 10_000 },
          },
        ],
      });
    return Response.json({ message: "not found" }, { status: 404 });
  });
  const adapter = new OpenCodeAdapter({ baseUrl });
  expect(
    await adapter.observeExecution("session-watchdog", now, {
      providerId: "fixture-provider",
      modelId: "fixture-model",
    }),
  ).toEqual({
    kind: "running",
    sessionId: "session-watchdog",
    contextPressure: true,
    contextTokens: 8_600,
    contextLimitTokens: 10_000,
    repeatedToolFailures: [
      "tool:test:error",
      "tool:lint:error",
      "tool:test:error",
    ],
    lastProgressAt: now - 5_000,
    safeBoundary: true,
    observedAt: now,
    expiresAt: now + 5_000,
    source: "opencode-v2",
  });
});

test("OpenCode interrupt uses the provider endpoint and reports whether it interrupted active work", async () => {
  const paths: string[] = [];
  const baseUrl = startFixture((request) => {
    const url = new URL(request.url);
    paths.push(`${request.method} ${url.pathname}${url.search}`);
    if (url.pathname === "/api/session/active")
      return Response.json({
        data: { "session-fixture": { type: "running" } },
      });
    if (url.pathname === "/api/session/session-fixture/message")
      return Response.json({
        data: [
          {
            id: "assistant-complete",
            type: "assistant",
            time: { created: 1, completed: 2 },
            tokens: {
              input: 100,
              output: 20,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            content: [],
          },
        ],
      });
    if (url.pathname === "/api/model")
      return Response.json({
        data: [
          {
            providerID: "provider",
            modelID: "model",
            limit: { context: 10_000 },
          },
        ],
      });
    return Response.json({ data: { interrupted: true } });
  });
  const adapter = new OpenCodeAdapter({ baseUrl });
  expect(
    await adapter.interruptSession(
      "session-fixture",
      {
        providerId: "provider",
        modelId: "model",
      },
      10,
    ),
  ).toEqual({
    ok: true,
    value: true,
  });
  expect(paths).toEqual([
    "GET /api/session/active",
    "GET /api/session/session-fixture/message?limit=50&order=desc",
    "GET /api/model",
    "POST /api/session/session-fixture/interrupt?resume=false",
  ]);
});

test("OpenCode refuses to interrupt when a tool is still running at dispatch time", async () => {
  let interruptHits = 0;
  const baseUrl = startFixture((request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/session/active")
      return Response.json({
        data: { "session-fixture": { type: "running" } },
      });
    if (url.pathname === "/api/session/session-fixture/message")
      return Response.json({
        data: [
          {
            id: "assistant-running-tool",
            type: "assistant",
            time: { created: 1 },
            content: [
              {
                type: "tool",
                name: "shell",
                time: { created: 2, ran: 3 },
                state: { status: "running", input: {}, metadata: {} },
              },
            ],
          },
        ],
      });
    if (url.pathname === "/api/model")
      return Response.json({
        data: [
          {
            providerID: "provider",
            modelID: "model",
            limit: { context: 10_000 },
          },
        ],
      });
    if (url.pathname.endsWith("/interrupt")) {
      interruptHits += 1;
      return Response.json({ data: { interrupted: true } });
    }
    return Response.json({ message: "not found" }, { status: 404 });
  });
  const adapter = new OpenCodeAdapter({ baseUrl });
  expect(
    await adapter.interruptSession(
      "session-fixture",
      {
        providerId: "provider",
        modelId: "model",
      },
      10,
    ),
  ).toEqual({
    ok: false,
    error: {
      kind: "rejected",
      message: "OpenCode no longer reports a safe interruption boundary",
    },
  });
  expect(interruptHits).toBe(0);
});

test("OpenCode event activity invalidates cached watchdog state and triggers a refresh", async () => {
  const now = 1_800_000_000_000;
  let tokenInput = 1_000;
  let activeReads = 0;
  let eventRequestPath = "";
  const baseUrl = startFixture((request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/session/active") {
      activeReads += 1;
      return Response.json({ data: { "session-events": { type: "running" } } });
    }
    if (url.pathname === "/api/session/session-events/message")
      return Response.json({
        data: [
          {
            id: "assistant-event-state",
            type: "assistant",
            time: { created: now - 1_000, completed: now - 100 },
            tokens: {
              input: tokenInput,
              output: 10,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            content: [],
          },
        ],
        cursor: { previous: null, next: null },
      });
    if (url.pathname === "/api/model")
      return Response.json({
        data: [
          {
            providerID: "provider",
            modelID: "model",
            limit: { context: 10_000 },
          },
        ],
      });
    if (url.pathname === "/api/event") {
      eventRequestPath = `${url.pathname}${url.search}`;
      tokenInput = 9_000;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"session.tool.failed","sessionID":"session-events"}\n\n',
            ),
          );
          controller.close();
        },
      });
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return Response.json({ message: "not found" }, { status: 404 });
  });
  const adapter = new OpenCodeAdapter({ baseUrl });
  const model = { providerId: "provider", modelId: "model" };
  expect(
    (await adapter.observeExecution("session-events", now, model)).kind,
  ).toBe("running");
  const controller = new AbortController();
  let wakes = 0;
  await adapter.watchActivity(
    "session-events",
    () => {
      wakes += 1;
      if (wakes === 2) controller.abort();
    },
    controller.signal,
  );
  expect(wakes).toBe(2);
  expect(eventRequestPath).toBe("/api/event");
  const refreshed = await adapter.observeExecution(
    "session-events",
    now,
    model,
  );
  expect(refreshed.kind).toBe("running");
  if (refreshed.kind !== "running")
    throw new Error("Expected refreshed active-session observation");
  expect(refreshed.contextPressure).toBe(true);
  expect(activeReads).toBe(2);
});

test("OpenCode event disconnects reconnect with backoff and force a fresh observation", async () => {
  let connections = 0;
  let eventRequestPath = "";
  const baseUrl = startFixture((request) => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/event")
      return Response.json({ message: "not found" }, { status: 404 });
    connections += 1;
    eventRequestPath = `${url.pathname}${url.search}`;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (connections === 1) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"session.tool.failed","sessionID":"other-session"}\n\ndata: {"type":"session.tool.failed","sessionID":"session-reconnect"}\n\n',
            ),
          );
        }
        controller.close();
      },
    });
    return new Response(body, {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const adapter = new OpenCodeAdapter({ baseUrl });
  const controller = new AbortController();
  let wakes = 0;
  await adapter.watchActivity(
    "session-reconnect",
    () => {
      wakes += 1;
      if (wakes === 4) controller.abort();
    },
    controller.signal,
  );
  expect(connections).toBe(2);
  expect(wakes).toBe(4);
  expect(eventRequestPath).toBe("/api/event");
});

test("an unsupported OpenCode event route leaves bounded reconciliation as the fallback", async () => {
  let requests = 0;
  const baseUrl = startFixture(() => {
    requests += 1;
    return Response.json({ message: "not found" }, { status: 404 });
  });
  const adapter = new OpenCodeAdapter({ baseUrl });
  let wakes = 0;
  await adapter.watchActivity(
    "session-fixture",
    () => {
      wakes += 1;
    },
    new AbortController().signal,
  );
  expect(requests).toBe(1);
  expect(wakes).toBe(0);
});

test("an acknowledged-lost prompt is reconciled by message identity and never automatically replayed", async () => {
  let promptHits = 0;
  let userMessageId: string | null = null;
  const baseUrl = startFixture(async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/session/session-recovery/model")
      return new Response(null, { status: 204 });
    if (url.pathname === "/api/session/session-recovery/prompt") {
      promptHits += 1;
      const body = (await request.json()) as { id: string };
      userMessageId = body.id;
      // The protocol fixture models a durable remote acceptance followed by a
      // lost server acknowledgement. The observer must inspect before retry.
      return Response.json(
        { message: "gateway response was lost" },
        { status: 504 },
      );
    }
    if (url.pathname === "/api/session/session-recovery/message")
      return Response.json({
        data: [{ id: userMessageId, type: "user", text: operation.directive }],
      });
    return Response.json({ message: "not found" }, { status: 404 });
  });
  const adapter = new OpenCodeAdapter({ baseUrl });
  const dispatched = await adapter.dispatchInstruction(
    "session-recovery",
    operation,
    { providerId: "provider", modelId: "model" },
  );
  expect(dispatched).toEqual({
    ok: false,
    error: {
      kind: "acknowledgement_lost",
      message: "OpenCode returned HTTP 504",
    },
  });
  const inspected = await adapter.inspectInstruction(
    "session-recovery",
    operation,
  );
  expect(inspected).toMatchObject({
    ok: true,
    value: {
      kind: "observed",
      result: "applied",
      retrySafe: false,
      externalIdentity: OpenCodeAdapter.messageIdForOperation(operation.id),
    },
  });
  expect(promptHits).toBe(1);
});

test("message absence remains unknown, not safe-to-retry, and invalid credentials never reach remote HTTP", async () => {
  let promptHits = 0;
  const baseUrl = startFixture(async (request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/model"))
      return new Response(null, { status: 204 });
    if (url.pathname.endsWith("/prompt")) {
      promptHits += 1;
      return Response.json(
        { message: "accepted but unobserved" },
        { status: 504 },
      );
    }
    if (url.pathname.endsWith("/message")) return Response.json({ data: [] });
    return Response.json({ version: "2.0.26+fixture" });
  });
  const adapter = new OpenCodeAdapter({ baseUrl });
  expect(
    await adapter.dispatchInstruction("session-unknown", operation, {
      providerId: "provider",
      modelId: "model",
    }),
  ).toMatchObject({ ok: false, error: { kind: "acknowledgement_lost" } });
  expect(
    await adapter.inspectInstruction("session-unknown", operation),
  ).toEqual({ ok: true, value: null });
  expect(promptHits).toBe(1);
  expect(
    () =>
      new OpenCodeAdapter({
        baseUrl: "http://opencode.example.invalid/",
        password: "must-not-travel-over-http",
      }),
  ).toThrow("loopback fixtures");
});

test("duplicate parent messages are not promoted to a successful Operation outcome", async () => {
  const id = OpenCodeAdapter.messageIdForOperation(operation.id);
  const baseUrl = startFixture((request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/message"))
      return Response.json({
        data: [
          { id, type: "user" },
          { id: "assistant-1", type: "assistant", parentID: id },
          { id: "assistant-2", type: "assistant", parentID: id },
        ],
      });
    return Response.json({ version: "2.0.26+fixture" });
  });
  const adapter = new OpenCodeAdapter({ baseUrl });
  expect(
    await adapter.inspectInstruction("session-duplicate", operation),
  ).toEqual({
    ok: true,
    value: null,
  });
});
