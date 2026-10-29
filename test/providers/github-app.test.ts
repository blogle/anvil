import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { importSPKI, jwtVerify } from "jose";
import {
  GitHubAppBroker,
  parseGitHubRepository,
  type GitHubCredentialPurpose,
} from "../../src/providers/github-app";

const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = keyPair.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
const publicKey = keyPair.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const epoch = 1_800_000_000_000;
let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

function startFixture(
  fetch: (request: Request) => Response | Promise<Response>,
): string {
  server = Bun.serve({ port: 0, fetch });
  return `http://127.0.0.1:${server.port}/api/`;
}

function permissionProfile(purpose: GitHubCredentialPurpose) {
  switch (purpose) {
    case "git":
      return { contents: "write" };
    case "gh_read":
      return {
        administration: "read",
        actions: "read",
        checks: "read",
        contents: "read",
        metadata: "read",
        pull_requests: "read",
        statuses: "read",
      };
    case "gh":
      return {
        actions: "read",
        checks: "read",
        contents: "read",
        metadata: "read",
        pull_requests: "write",
      };
  }
}

test("GitHub App broker signs short-lived JWTs, requests repository-scoped least-privilege tokens, and caches by profile", async () => {
  let now = epoch;
  let requests = 0;
  const requestsSeen: { body: unknown; authorization: string | null }[] = [];
  const baseUrl = startFixture(async (request) => {
    requests += 1;
    const body = await request.json();
    requestsSeen.push({
      body,
      authorization: request.headers.get("authorization"),
    });
    return Response.json(
      {
        token: `ghs_fixture_${requests}`,
        expires_at: new Date(now + 120_000).toISOString(),
        permissions: {
          ...(body as { permissions: Record<string, string> }).permissions,
          metadata: "read",
        },
      },
      { status: 201 },
    );
  });
  const broker = new GitHubAppBroker({
    appId: "app-123",
    installationId: 42,
    privateKey,
    apiUrl: baseUrl,
    now: () => now,
    refreshMarginMs: 60_000,
  });

  const git = await broker.credential(
    "https://github.com/acme/demo.git",
    "git",
  );
  expect(git.ok).toBe(true);
  if (!git.ok) throw new Error("GitHub App token request failed");
  expect(git.value).toMatchObject({
    token: "ghs_fixture_1",
    tokenType: "installation",
    repository: "acme/demo",
    permissions: permissionProfile("git"),
  });
  expect(requests).toBe(1);

  const jwt = requestsSeen[0]?.authorization?.replace(/^Bearer /, "");
  if (jwt === undefined) throw new Error("GitHub request omitted App JWT");
  const verified = await jwtVerify(jwt, await importSPKI(publicKey, "RS256"), {
    issuer: "app-123",
  });
  expect(verified.payload.iat).toBe(Math.floor(epoch / 1000) - 60);
  expect(verified.payload.exp).toBe(Math.floor(epoch / 1000) + 9 * 60);
  expect(requestsSeen[0]?.body).toEqual({
    repositories: ["demo"],
    permissions: permissionProfile("git"),
  });

  expect(
    await broker.credential("https://github.com/acme/demo", "git"),
  ).toEqual(git);
  expect(requests).toBe(1);
  const read = await broker.credential(
    "https://github.com/acme/demo",
    "gh_read",
  );
  expect(read.ok).toBe(true);
  expect(requests).toBe(2);

  now += 70_000;
  const refreshed = await broker.credential(
    "https://github.com/acme/demo",
    "git",
  );
  expect(refreshed.ok).toBe(true);
  expect(requests).toBe(3);
});

test("Git-purpose App credential is repository-scoped contents-only and excludes PR authority", async () => {
  const requestsSeen: {
    repositories: string[];
    permissions: Record<string, string>;
  }[] = [];
  let tokenNumber = 0;
  const baseUrl = startFixture(async (request) => {
    const body = (await request.json()) as {
      repositories: string[];
      permissions: Record<string, string>;
    };
    requestsSeen.push(body);
    tokenNumber += 1;
    return Response.json(
      {
        token: `ghs_git_${tokenNumber}`,
        expires_at: new Date(epoch + 3_600_000).toISOString(),
        permissions: body.permissions,
      },
      { status: 201 },
    );
  });
  const broker = new GitHubAppBroker({
    appId: "app-123",
    installationId: 42,
    privateKey,
    apiUrl: baseUrl,
    now: () => epoch,
  });
  const repoToken = await broker.credential(
    "https://github.com/acme/demo",
    "git",
  );
  const otherRepoToken = await broker.credential(
    "https://github.com/acme/other",
    "git",
  );
  expect(repoToken).toMatchObject({
    ok: true,
    value: {
      repository: "acme/demo",
      permissions: { contents: "write" },
    },
  });
  expect(otherRepoToken).toMatchObject({
    ok: true,
    value: { repository: "acme/other" },
  });
  expect(requestsSeen).toEqual([
    { repositories: ["demo"], permissions: { contents: "write" } },
    { repositories: ["other"], permissions: { contents: "write" } },
  ]);
  expect(JSON.stringify(repoToken)).not.toContain("privateKey");
});

test("GitHub repository binding rejects non-GitHub URLs, extra paths, query credentials, and malformed names", () => {
  expect(parseGitHubRepository("https://github.com/Acme/demo.git")).toEqual({
    ok: true,
    value: "Acme/demo",
  });
  for (const url of [
    "https://example.com/acme/demo",
    "http://github.com/acme/demo",
    "https://github.com/acme/demo/issues",
    "https://token@github.com/acme/demo",
    "https://github.com/acme/demo?token=secret",
    "https://github.com/acme/../secrets",
  ]) {
    expect(parseGitHubRepository(url).ok).toBe(false);
  }
});

test("GitHub errors are typed and exclude upstream token/private credential text", async () => {
  const baseUrl = startFixture((request) => {
    expect(request.headers.get("user-agent")).toBe("anvil-github-broker/0.1");
    return Response.json(
      {
        message: "ghs_leaked_token and private signing material",
        documentation_url: "https://docs.github.com/safe",
      },
      {
        status: 422,
        headers: { "x-github-request-id": "request-safe-1" },
      },
    );
  });
  const broker = new GitHubAppBroker({
    appId: "app-123",
    installationId: 42,
    privateKey,
    apiUrl: baseUrl,
  });
  const result = await broker.credential("https://github.com/acme/demo", "git");
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected GitHub scope failure");
  expect(result.error.kind).toBe("upstream");
  expect(result.error.diagnostic).toMatchObject({
    code: "github_token_scope_rejected",
    upstreamStatus: 422,
    requestId: "request-safe-1",
  });
  const text = JSON.stringify(result.error);
  expect(text).not.toContain("ghs_");
  expect(text).not.toContain("private signing material");
});

test("overbroad installation permissions are rejected instead of returned to a worker", async () => {
  const baseUrl = startFixture(() =>
    Response.json(
      {
        token: "ghs_too_broad",
        expires_at: new Date(epoch + 3_600_000).toISOString(),
        permissions: {
          contents: "write",
          workflows: "write",
          pull_requests: "write",
          metadata: "read",
        },
      },
      { status: 201 },
    ),
  );
  const broker = new GitHubAppBroker({
    appId: "app-123",
    installationId: 42,
    privateKey,
    apiUrl: baseUrl,
    now: () => epoch,
  });
  const result = await broker.credential("https://github.com/acme/demo", "git");
  expect(result).toMatchObject({
    ok: false,
    error: {
      kind: "scope_mismatch",
      diagnostic: { code: "github_token_scope_mismatch" },
    },
  });
});

test("expired and unavailable GitHub installation credentials are never returned", async () => {
  let responseMode: "expired" | "unavailable" = "expired";
  const baseUrl = startFixture(async (request) => {
    if (responseMode === "unavailable")
      return Response.json({ message: "temporary error" }, { status: 503 });
    const body = (await request.json()) as {
      permissions: Record<string, string>;
    };
    return Response.json(
      {
        token: "ghs_expired_fixture",
        expires_at: new Date(epoch - 1).toISOString(),
        permissions: body.permissions,
      },
      { status: 201 },
    );
  });
  const broker = new GitHubAppBroker({
    appId: "app-123",
    installationId: 42,
    privateKey,
    apiUrl: baseUrl,
    now: () => epoch,
  });
  const expired = await broker.credential(
    "https://github.com/acme/demo",
    "git",
  );
  expect(expired).toMatchObject({
    ok: false,
    error: { kind: "malformed_response" },
  });
  expect(JSON.stringify(expired)).not.toContain("ghs_expired_fixture");

  responseMode = "unavailable";
  const unavailable = await broker.credential(
    "https://github.com/acme/demo",
    "git",
  );
  expect(unavailable).toMatchObject({
    ok: false,
    error: { kind: "upstream", diagnostic: { upstreamStatus: 503 } },
  });
});
