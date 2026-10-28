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
      return Response.json({ data: [{ id: "session-fixture" }] });
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
    value: [{ id: "session-fixture" }],
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
  ).toThrow("require HTTPS");
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
