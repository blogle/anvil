import { afterEach, expect, test } from "bun:test";
import { MergifyQueueClient } from "../../src/providers/mergify";

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

test("Mergify queue adapter reads authoritative queue state from its REST contract", async () => {
  const requests: string[] = [];
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      expect(request.headers.get("authorization")).toBe(
        "Bearer local-mergify-token",
      );
      return Response.json({
        number: 19,
        queued_at: "2026-10-28T10:00:00Z",
        position: 2,
        ci_state: "pending",
        state: "waiting_for_checks",
        checks: [
          { name: "tests", state: "success" },
          { name: "merge-group", state: "pending" },
        ],
      });
    },
  });
  const client = new MergifyQueueClient({
    apiUrl: `http://127.0.0.1:${server.port}/v1/`,
    bearerToken: "local-mergify-token",
  });
  expect(
    await client.pullRequestQueue("https://github.com/acme/demo", 19),
  ).toEqual({
    ok: true,
    value: {
      pullRequestNumber: 19,
      queuedAt: "2026-10-28T10:00:00Z",
      position: 2,
      ciState: "pending",
      state: "waiting_for_checks",
      checks: [
        { name: "tests", state: "success" },
        { name: "merge-group", state: "pending" },
      ],
    },
  });
  expect(requests).toEqual(["GET /v1/repos/acme/demo/merge-queue/pull/19"]);
});

test("Mergify explicitly reports not-queued and preserves auth/unavailable distinctions", async () => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/pull/20"))
        return Response.json(
          { error_code: "PULL_REQUEST_NOT_QUEUED", detail: "not queued" },
          { status: 404 },
        );
      if (url.pathname.endsWith("/pull/21"))
        return Response.json({ detail: "denied" }, { status: 403 });
      return Response.json({ detail: "unavailable" }, { status: 503 });
    },
  });
  const client = new MergifyQueueClient({
    apiUrl: `http://127.0.0.1:${server.port}/v1/`,
    bearerToken: "local-mergify-token",
  });
  expect(
    await client.pullRequestQueue("https://github.com/acme/demo", 20),
  ).toEqual({ ok: true, value: null });
  expect(
    await client.pullRequestQueue("https://github.com/acme/demo", 21),
  ).toMatchObject({
    ok: false,
    error: { kind: "credentials", upstreamStatus: 403 },
  });
  expect(
    await client.pullRequestQueue("https://github.com/acme/demo", 22),
  ).toMatchObject({
    ok: false,
    error: { kind: "unavailable", upstreamStatus: 503 },
  });
});
