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

function setup(mergeQueue: boolean, merged = false) {
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
      if (url.pathname.endsWith("/commits/candidate-sha/check-runs"))
        return Response.json({
          total_count: 1,
          check_runs: [
            {
              id: 1,
              name: "ci / unit",
              head_sha: "candidate-sha",
              status: "completed",
              conclusion: "success",
              details_url: "https://github.com/acme/demo/actions/1",
            },
          ],
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
