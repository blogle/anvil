import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { GitHubAppBroker } from "../../src/providers/github-app";
import { GitHubDeliveryClient } from "../../src/providers/github-delivery";
import { GitHubWorldObserver } from "../../src/providers/github-world";
import { MergifyQueueClient } from "../../src/providers/mergify";
import { epoch, proposal } from "../support/fixtures";

const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = keyPair.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
let githubServer: ReturnType<typeof Bun.serve> | undefined;
let mergifyServer: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  githubServer?.stop(true);
  githubServer = undefined;
  mergifyServer?.stop(true);
  mergifyServer = undefined;
});

type FixtureCheck = Readonly<{
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  details_url: string | null;
  app_id?: number | null;
}>;

type RequiredCheck = Readonly<{ context: string; app_id: number | null }>;
type FixtureStatus = Readonly<{
  id: number;
  context: string;
  state: "error" | "failure" | "pending" | "success";
}>;

function setup(
  mergeQueue: boolean,
  merged = false,
  options: Readonly<{
    checkRuns?: readonly FixtureCheck[];
    requiredChecks?: readonly RequiredCheck[] | null;
    requiredContexts?: readonly string[];
    commitStatuses?: readonly FixtureStatus[];
    requiredChecksUnavailable?: boolean;
  }> = {},
) {
  githubServer?.stop(true);
  mergifyServer?.stop(true);
  let checkRuns = options.checkRuns ?? [
    {
      id: 1,
      name: "ci / unit",
      head_sha: "candidate-sha",
      status: "completed",
      conclusion: "success",
      details_url: "https://github.com/acme/demo/actions/1",
      app_id: 7,
    },
  ];
  githubServer = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/app/installations/42/access_tokens") {
        const body = (await request.json()) as {
          permissions: Record<string, string>;
        };
        return Response.json(
          {
            token: "ghs_world_read",
            expires_at: new Date(epoch + 3_600_000).toISOString(),
            permissions: body.permissions,
          },
          { status: 201 },
        );
      }
      if (url.pathname.endsWith("/branches/anvil%2Fcommission-world"))
        return Response.json({
          name: "anvil/commission-world",
          commit: { sha: "candidate-sha" },
        });
      if (url.pathname.endsWith("/rules/branches/main")) {
        if (options.requiredChecksUnavailable)
          return Response.json({ message: "unavailable" }, { status: 503 });
        const requiredChecks =
          options.requiredChecks === null
            ? []
            : (options.requiredChecks ?? [{ context: "ci / unit", app_id: 7 }]);
        return Response.json(
          options.requiredChecks === null || requiredChecks.length === 0
            ? []
            : [
                {
                  type: "required_status_checks",
                  parameters: { required_status_checks: requiredChecks },
                },
              ],
        );
      }
      if (
        url.pathname.endsWith(
          "/branches/main/protection/required_status_checks",
        )
      ) {
        if (options.requiredChecksUnavailable)
          return Response.json({ message: "unavailable" }, { status: 503 });
        if (
          options.requiredChecks === null &&
          (options.requiredContexts ?? []).length === 0
        )
          return Response.json({ message: "no protection" }, { status: 404 });
        const requiredChecks =
          options.requiredChecks === null
            ? []
            : (options.requiredChecks ?? [{ context: "ci / unit", app_id: 7 }]);
        return Response.json({
          contexts: options.requiredContexts ?? [],
          checks: requiredChecks,
        });
      }
      if (url.pathname.endsWith("/commits/candidate-sha/status"))
        return Response.json({
          sha: "candidate-sha",
          total_count: options.commitStatuses?.length ?? 0,
          statuses: options.commitStatuses ?? [],
        });
      if (url.pathname.endsWith("/commits/candidate-sha/check-runs"))
        return Response.json({
          total_count: checkRuns.length,
          check_runs: checkRuns,
        });
      if (url.pathname.endsWith("/pulls/7"))
        return Response.json({
          number: 7,
          html_url: "https://github.com/acme/demo/pull/7",
          state: merged ? "closed" : "open",
          merged,
          head: { ref: "anvil/commission-world", sha: "candidate-sha" },
          base: { ref: "main" },
        });
      if (url.pathname.endsWith("/pulls"))
        return Response.json([
          {
            number: 7,
            html_url: "https://github.com/acme/demo/pull/7",
            state: "open",
            merged: false,
            head: { ref: "anvil/commission-world", sha: "candidate-sha" },
            base: { ref: "main" },
          },
        ]);
      return Response.json({ message: "not found" }, { status: 404 });
    },
  });
  mergifyServer = Bun.serve({
    port: 0,
    fetch(request) {
      expect(request.headers.get("authorization")).toBe(
        "Bearer mergify-local-token",
      );
      return mergeQueue
        ? Response.json({
            number: 7,
            queued_at: "2026-10-28T10:00:00Z",
            position: 0,
            ci_state: "pending",
            state: "waiting_for_checks",
            checks: [],
          })
        : Response.json(
            { error_code: "PULL_REQUEST_NOT_QUEUED", detail: "not queued" },
            { status: 404 },
          );
    },
  });
  const apiUrl = `http://127.0.0.1:${githubServer.port}/api/`;
  const broker = new GitHubAppBroker({
    appId: "fixture-app",
    installationId: 42,
    privateKey,
    apiUrl,
    now: () => epoch,
  });
  const delivery = new GitHubDeliveryClient(broker, {
    apiUrl,
    now: () => epoch + 1,
  });
  const mergify = new MergifyQueueClient({
    apiUrl: `http://127.0.0.1:${mergifyServer.port}/v1/`,
    bearerToken: "mergify-local-token",
  });
  return new GitHubWorldObserver({
    delivery,
    mergify,
    workBranch: () => "anvil/commission-world",
    maxObservationAgeMs: 60_000,
  });
}

async function observeChecks(
  options: Parameters<typeof setup>[2],
): Promise<unknown> {
  const observer = setup(false, false, options);
  return observer.observe(
    {
      ...proposal({
        id: "commission-world",
        repository: "https://github.com/acme/demo",
      }).commission,
      registeredPullRequestId: "https://github.com/acme/demo/pull/7",
    },
    epoch + 5,
  );
}

test("World observer returns exact Candidate, passing CI, registered PR, and Mergify queue observations", async () => {
  const observer = setup(true);
  const commission = {
    ...proposal({
      id: "commission-world",
      repository: "https://github.com/acme/demo",
    }).commission,
    registeredPullRequestId: "https://github.com/acme/demo/pull/7",
  };
  const result = await observer.observe(commission, epoch + 5);
  expect(result).toMatchObject({
    ok: true,
    value: {
      candidateRevision: "candidate-sha",
      candidateSource: "github-branch-rest",
      checks: { revision: "candidate-sha", state: "passing" },
      integration: {
        kind: "queued",
        revision: "candidate-sha",
        providerIdentity: "https://github.com/acme/demo/pull/7",
        repository: "https://github.com/acme/demo",
        target: "main",
        source: "mergify-queue-rest",
      },
    },
  });
});

test("World observer reports merged registered PR without requiring a live merge-queue entry", async () => {
  const observer = setup(false, true);
  const commission = {
    ...proposal({
      id: "commission-world-merged",
      repository: "https://github.com/acme/demo",
    }).commission,
    registeredPullRequestId: "https://github.com/acme/demo/pull/7",
  };
  const result = await observer.observe(commission, epoch + 5);
  expect(result).toMatchObject({
    ok: true,
    value: {
      checks: { state: "passing" },
      integration: {
        kind: "merged",
        revision: "candidate-sha",
        repository: "https://github.com/acme/demo",
        target: "main",
      },
    },
  });
});

test("unregistered same-branch PR is surfaced with its own identity, never silently registered", async () => {
  const observer = setup(false);
  const commission = proposal({
    id: "commission-world-unregistered",
    repository: "https://github.com/acme/demo",
  }).commission;
  const result = await observer.observe(commission, epoch + 5);
  expect(result).toMatchObject({
    ok: true,
    value: {
      integration: {
        kind: "pr_open",
        providerIdentity: "https://github.com/acme/demo/pull/7",
      },
    },
  });
});

test("World observer does not treat skipped or neutral required checks as passing", async () => {
  const check = (
    conclusion: string | null,
    name = "ci / unit",
    headSha = "candidate-sha",
  ): FixtureCheck => ({
    id: 88,
    name,
    head_sha: headSha,
    status: "completed",
    conclusion,
    details_url: null,
    app_id: 7,
  });

  for (const conclusion of ["skipped", "neutral"]) {
    const result = await observeChecks({ checkRuns: [check(conclusion)] });
    expect(result).toMatchObject({
      ok: true,
      value: { checks: { state: "unknown" } },
    });
  }
});

test("World observer requires each discovered status context and exact Candidate SHA", async () => {
  const checkRuns: FixtureCheck[][] = [
    [
      {
        id: 88,
        name: "unrelated / lint",
        head_sha: "candidate-sha",
        status: "completed",
        conclusion: "success",
        details_url: null,
        app_id: 7,
      },
    ],
    [
      {
        id: 88,
        name: "ci / unit",
        head_sha: "foreign-sha",
        status: "completed",
        conclusion: "success",
        details_url: null,
        app_id: 7,
      },
    ],
    [
      {
        id: 90,
        name: "ci / unit",
        head_sha: "candidate-sha",
        status: "completed",
        conclusion: "success",
        details_url: null,
        app_id: 8,
      },
    ],
    [],
  ];
  for (const runs of checkRuns) {
    const result = await observeChecks({ checkRuns: runs });
    expect(result).toMatchObject({
      ok: true,
      value: { checks: { state: "missing", failureIds: ["ci / unit"] } },
    });
  }
});

test("World observer distinguishes required pending and failing status contexts", async () => {
  const check = (status: string, conclusion: string | null): FixtureCheck => ({
    id: 89,
    name: "ci / unit",
    head_sha: "candidate-sha",
    status,
    conclusion,
    details_url: null,
    app_id: 7,
  });
  const failure = await observeChecks({
    checkRuns: [check("completed", "failure")],
  });
  expect(failure).toMatchObject({
    ok: true,
    value: { checks: { state: "failing", failureIds: ["ci / unit:89"] } },
  });
  const pending = await observeChecks({
    checkRuns: [check("queued", null)],
  });
  expect(pending).toMatchObject({
    ok: true,
    value: { checks: { state: "pending" } },
  });
});

test("World observer treats absent required-check policy as unknown and provider failure as unavailable", async () => {
  const noPolicy = await observeChecks({ requiredChecks: null });
  expect(noPolicy).toMatchObject({
    ok: true,
    value: { checks: { state: "unknown" } },
  });
  const unavailablePolicy = await observeChecks({
    requiredChecksUnavailable: true,
  });
  expect(unavailablePolicy).toMatchObject({
    ok: false,
    error: { kind: "unavailable" },
  });
});

test("World observer validates legacy required status contexts from the approved target branch", async () => {
  const passing = await observeChecks({
    requiredChecks: null,
    requiredContexts: ["legacy / build"],
    commitStatuses: [{ id: 101, context: "legacy / build", state: "success" }],
    checkRuns: [],
  });
  expect(passing).toMatchObject({
    ok: true,
    value: {
      checks: { state: "passing", source: "github-required-status-checks" },
    },
  });
  const failed = await observeChecks({
    requiredChecks: null,
    requiredContexts: ["legacy / build"],
    commitStatuses: [{ id: 102, context: "legacy / build", state: "failure" }],
    checkRuns: [],
  });
  expect(failed).toMatchObject({
    ok: true,
    value: {
      checks: { state: "failing", failureIds: ["legacy / build:102"] },
    },
  });
});

test("the Mergify queue is not used as source-PR CI evidence", async () => {
  const observer = setup(true);
  const result = await observer.observe(
    {
      ...proposal({
        id: "commission-world-queue-ci",
        repository: "https://github.com/acme/demo",
      }).commission,
      registeredPullRequestId: "https://github.com/acme/demo/pull/7",
    },
    epoch + 5,
  );
  expect(result).toMatchObject({
    ok: true,
    value: {
      checks: { state: "passing", source: "github-required-status-checks" },
      integration: { kind: "queued", source: "mergify-queue-rest" },
    },
  });
});
