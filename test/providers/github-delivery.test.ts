import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { GitHubAppBroker } from "../../src/providers/github-app";
import { GitHubDeliveryClient } from "../../src/providers/github-delivery";

const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = keyPair.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
const epoch = 1_800_000_000_000;
let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

test("GitHub read adapter preserves PR, branch, check and truncation facts from local REST fixtures", async () => {
  const requests: { path: string; authorization: string | null }[] = [];
  let tokenRequests = 0;
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push({
        path: `${url.pathname}${url.search}`,
        authorization: request.headers.get("authorization"),
      });
      if (url.pathname === "/api/app/installations/42/access_tokens") {
        tokenRequests += 1;
        const payload = (await request.json()) as {
          repositories: string[];
          permissions: Record<string, string>;
        };
        expect(payload).toEqual({
          repositories: ["demo"],
          permissions: {
            administration: "read",
            actions: "read",
            checks: "read",
            contents: "read",
            metadata: "read",
            pull_requests: "read",
            statuses: "read",
          },
        });
        return Response.json(
          {
            token: "ghs_read_only_fixture",
            expires_at: new Date(epoch + 3_600_000).toISOString(),
            permissions: { ...payload.permissions },
          },
          { status: 201 },
        );
      }
      if (url.pathname === "/api/repos/acme/demo/pulls/17")
        return Response.json({
          number: 17,
          html_url: "https://github.com/acme/demo/pull/17",
          state: "closed",
          merged: true,
          head: { sha: "merge-sha", ref: "anvil/work" },
          base: { ref: "main" },
        });
      if (url.pathname === "/api/repos/acme/demo/commits/merge-sha/check-runs")
        return Response.json({
          total_count: 2,
          check_runs: [
            {
              id: 91,
              name: "test / unit",
              head_sha: "merge-sha",
              status: "completed",
              conclusion: "success",
              details_url: "https://github.com/acme/demo/actions/runs/91",
            },
          ],
        });
      if (url.pathname === "/api/repos/acme/demo/branches/anvil%2Fwork")
        return Response.json({
          name: "anvil/work",
          commit: { sha: "branch-sha" },
        });
      return Response.json(
        { message: "fixture route not found" },
        { status: 404 },
      );
    },
  });
  const apiUrl = `http://127.0.0.1:${server.port}/api/`;
  const broker = new GitHubAppBroker({
    appId: "app-id",
    installationId: 42,
    privateKey,
    apiUrl,
    now: () => epoch,
  });
  const client = new GitHubDeliveryClient(broker, {
    apiUrl,
    now: () => epoch + 1,
  });

  const pullRequest = await client.pullRequest(
    "https://github.com/acme/demo.git",
    17,
  );
  expect(pullRequest).toEqual({
    ok: true,
    value: {
      number: 17,
      url: "https://github.com/acme/demo/pull/17",
      repository: "acme/demo",
      state: "merged",
      headSha: "merge-sha",
      headRef: "anvil/work",
      baseRef: "main",
      observedAt: epoch + 1,
      source: "github-rest",
    },
  });
  const checks = await client.checkRuns(
    "https://github.com/acme/demo",
    "merge-sha",
  );
  expect(checks).toMatchObject({
    ok: true,
    value: {
      revision: "merge-sha",
      totalCount: 2,
      complete: false,
      checkRuns: [
        {
          id: 91,
          name: "test / unit",
          headSha: "merge-sha",
          status: "completed",
          conclusion: "success",
        },
      ],
    },
  });
  const branch = await client.branch(
    "https://github.com/acme/demo",
    "anvil/work",
  );
  expect(branch).toMatchObject({
    ok: true,
    value: {
      name: "anvil/work",
      revision: "branch-sha",
      source: "github-rest",
    },
  });
  expect(tokenRequests).toBe(1);
  expect(
    requests.filter(({ path }) => path.includes("access_tokens")),
  ).toHaveLength(1);
  expect(
    requests
      .filter(({ path }) => path.includes("/repos/"))
      .every(
        ({ authorization }) => authorization === "Bearer ghs_read_only_fixture",
      ),
  ).toBe(true);
});

test("GitHub read adapter distinguishes missing PRs from authorization and provider failures", async () => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/app/installations/42/access_tokens") {
        const payload = (await request.json()) as { permissions: object };
        return Response.json(
          {
            token: "ghs_fixture",
            expires_at: new Date(epoch + 3_600_000).toISOString(),
            permissions: payload.permissions,
          },
          { status: 201 },
        );
      }
      if (url.pathname.endsWith("/pulls/404"))
        return Response.json({ message: "Not Found" }, { status: 404 });
      return Response.json({ message: "denied" }, { status: 403 });
    },
  });
  const apiUrl = `http://127.0.0.1:${server.port}/api/`;
  const broker = new GitHubAppBroker({
    appId: "app-id",
    installationId: 42,
    privateKey,
    apiUrl,
    now: () => epoch,
  });
  const client = new GitHubDeliveryClient(broker, { apiUrl });
  expect(
    await client.pullRequest("https://github.com/acme/demo", 404),
  ).toMatchObject({
    ok: false,
    error: { kind: "not_found", upstreamStatus: 404 },
  });
  expect(
    await client.pullRequest("https://github.com/acme/demo", 17),
  ).toMatchObject({
    ok: false,
    error: { kind: "credentials", upstreamStatus: 403 },
  });
});

test("GitHub PR creation discovers an existing registered branch and inspects after lost acknowledgement", async () => {
  let currentPullRequest: Record<string, unknown> | null = null;
  let createRequests = 0;
  let tokenRequests = 0;
  let loseNextCreateAck = false;
  const paths: string[] = [];
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      paths.push(`${request.method} ${url.pathname}${url.search}`);
      if (url.pathname === "/api/app/installations/42/access_tokens") {
        tokenRequests += 1;
        const body = (await request.json()) as {
          permissions: Record<string, string>;
        };
        expect(body.permissions["pull_requests"]).toBe(
          tokenRequests === 1 ? "read" : "write",
        );
        return Response.json(
          {
            token: "ghs_write_fixture",
            expires_at: new Date(epoch + 3_600_000).toISOString(),
            permissions: body.permissions,
          },
          { status: 201 },
        );
      }
      if (
        url.pathname === "/api/repos/acme/demo/pulls" &&
        request.method === "GET"
      )
        return Response.json(
          currentPullRequest === null ? [] : [currentPullRequest],
        );
      if (
        url.pathname === "/api/repos/acme/demo/pulls" &&
        request.method === "POST"
      ) {
        createRequests += 1;
        const body = (await request.json()) as {
          head: string;
          base: string;
          title: string;
          body: string;
          draft: boolean;
        };
        expect(body).toEqual({
          head: `acme:${body.head.slice("acme:".length)}`,
          base: "main",
          title: "Implement runtime support",
          body: "Commission: runtime-1",
          draft: false,
        });
        const requestedHead = body.head.split(":").slice(1).join(":");
        currentPullRequest = {
          number: 24,
          html_url: "https://github.com/acme/demo/pull/24",
          state: "open",
          merged: false,
          head: { sha: "candidate-1", ref: requestedHead },
          base: { ref: "main" },
        };
        if (loseNextCreateAck) {
          loseNextCreateAck = false;
          return Response.json(
            { message: "acknowledgement lost" },
            { status: 504 },
          );
        }
        return Response.json(currentPullRequest, { status: 201 });
      }
      return Response.json(
        { message: "fixture route not found" },
        { status: 404 },
      );
    },
  });
  const apiUrl = `http://127.0.0.1:${server.port}/api/`;
  const broker = new GitHubAppBroker({
    appId: "app-id",
    installationId: 42,
    privateKey,
    apiUrl,
    now: () => epoch,
  });
  const client = new GitHubDeliveryClient(broker, {
    apiUrl,
    now: () => epoch + 1,
  });
  const input = {
    repositoryUrl: "https://github.com/acme/demo",
    headRef: "feature/runtime",
    baseRef: "main",
    title: "Implement runtime support",
    body: "Commission: runtime-1",
  };

  const created = await client.createOrFindPullRequest(input);
  expect(created).toMatchObject({
    ok: true,
    value: {
      number: 24,
      repository: "acme/demo",
      headSha: "candidate-1",
      headRef: "feature/runtime",
      baseRef: "main",
    },
  });
  expect(createRequests).toBe(1);
  const discovered = await client.createOrFindPullRequest(input);
  expect(discovered).toEqual(created);
  expect(createRequests).toBe(1);

  currentPullRequest = null;
  loseNextCreateAck = true;
  const recovered = await client.createOrFindPullRequest({
    ...input,
    headRef: "feature/runtime-2",
  });
  expect(recovered).toMatchObject({ ok: true, value: { number: 24 } });
  expect(createRequests).toBe(2);
  expect(
    paths.filter((path) => path.startsWith("POST /api/repos/acme/demo/pulls")),
  ).toHaveLength(2);
});

test("GitHub PR create with no observable postcondition remains ambiguous and is not replayed", async () => {
  let createRequests = 0;
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/app/installations/42/access_tokens") {
        const body = (await request.json()) as {
          permissions: Record<string, string>;
        };
        return Response.json(
          {
            token: "ghs_write_fixture",
            expires_at: new Date(epoch + 3_600_000).toISOString(),
            permissions: body.permissions,
          },
          { status: 201 },
        );
      }
      if (
        url.pathname === "/api/repos/acme/demo/pulls" &&
        request.method === "GET"
      )
        return Response.json([]);
      if (
        url.pathname === "/api/repos/acme/demo/pulls" &&
        request.method === "POST"
      ) {
        createRequests += 1;
        return Response.json(
          { message: "acknowledgement lost" },
          { status: 504 },
        );
      }
      return Response.json(
        { message: "fixture route not found" },
        { status: 404 },
      );
    },
  });
  const apiUrl = `http://127.0.0.1:${server.port}/api/`;
  const client = new GitHubDeliveryClient(
    new GitHubAppBroker({
      appId: "app-id",
      installationId: 42,
      privateKey,
      apiUrl,
      now: () => epoch,
    }),
    { apiUrl },
  );
  const result = await client.createOrFindPullRequest({
    repositoryUrl: "https://github.com/acme/demo",
    headRef: "feature/unknown",
    baseRef: "main",
    title: "Unknown postcondition",
    body: "Do not duplicate",
  });
  expect(result).toMatchObject({ ok: false, error: { kind: "ambiguous" } });
  expect(createRequests).toBe(1);
});
