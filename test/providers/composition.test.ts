import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationService } from "../../src/application";
import { ProviderComposition } from "../../src/providers/composition";
import { AgentSandboxClient } from "../../src/providers/agent-sandbox";
import { OpenCodeAdapter } from "../../src/providers/opencode";
import { GitHubAppBroker } from "../../src/providers/github-app";
import { GitHubDeliveryClient } from "../../src/providers/github-delivery";
import { GitHubWorldObserver } from "../../src/providers/github-world";
import { MergifyQueueClient } from "../../src/providers/mergify";
import { CommissionStore } from "../../src/persistence/sqlite";
import { FakeWorld } from "../support/fake-world";
import {
  epoch,
  observation,
  policy,
  proposal,
  proposalInput,
} from "../support/fixtures";
import type { Operation } from "../../src/domain";

let directory: string | undefined;
let store: CommissionStore | undefined;
let sandboxServer: ReturnType<typeof Bun.serve> | undefined;
let openCodeServer: ReturnType<typeof Bun.serve> | undefined;
let githubServer: ReturnType<typeof Bun.serve> | undefined;
let mergifyServer: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
  sandboxServer?.stop(true);
  sandboxServer = undefined;
  openCodeServer?.stop(true);
  openCodeServer = undefined;
  githubServer?.stop(true);
  githubServer = undefined;
  mergifyServer?.stop(true);
  mergifyServer = undefined;
  if (directory !== undefined)
    rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function openStore(): CommissionStore {
  directory = mkdtempSync(join(tmpdir(), "anvil-provider-composition-"));
  store = new CommissionStore(join(directory, "state.sqlite"));
  return store;
}

function localProviders(world: FakeWorld) {
  let sandboxResource: Record<string, unknown> | null = null;
  let sandboxCreates = 0;
  let sessionCreates = 0;
  let promptSubmissions = 0;

  sandboxServer = Bun.serve({
    port: 0,
    async fetch(request) {
      expect(request.headers.get("authorization")).toBe(
        "Bearer local-sandbox-fixture-token",
      );
      const url = new URL(request.url);
      if (url.pathname.endsWith("/sandboxes") && request.method === "GET")
        return Response.json({
          items: sandboxResource === null ? [] : [sandboxResource],
        });
      if (url.pathname.endsWith("/sandboxes") && request.method === "POST") {
        sandboxCreates += 1;
        const requested = (await request.json()) as Record<string, unknown>;
        const metadata = requested["metadata"] as Record<string, unknown>;
        sandboxResource = {
          ...requested,
          metadata: { ...metadata, resourceVersion: "1", uid: "uid-1" },
          status: { conditions: [{ type: "Ready", status: "True" }] },
        };
        return Response.json(sandboxResource, { status: 201 });
      }
      const resourcePath =
        "/apis/agents.x-k8s.io/v1beta1/namespaces/test/sandboxes/";
      if (url.pathname.startsWith(resourcePath) && request.method === "GET")
        return sandboxResource === null
          ? Response.json({ message: "not found" }, { status: 404 })
          : Response.json(sandboxResource);
      return Response.json(
        { message: "fixture route not found" },
        { status: 404 },
      );
    },
  });
  openCodeServer = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/session") {
        sessionCreates += 1;
        expect(request.method).toBe("POST");
        return Response.json({ data: { id: "session-local-1" } });
      }
      if (url.pathname === "/api/session/active")
        return Response.json({ data: {} });
      if (url.pathname.endsWith("/model"))
        return new Response(null, { status: 204 });
      if (url.pathname.endsWith("/prompt")) {
        promptSubmissions += 1;
        const body = (await request.json()) as { id: string; text: string };
        expect(body.text).toContain("Implement bounded delivery");
        return Response.json({ data: { id: body.id } });
      }
      if (url.pathname.endsWith("/message")) return Response.json({ data: [] });
      if (url.pathname === "/api/info")
        return Response.json({ version: "2.0.26+fixture" });
      return Response.json(
        { message: "fixture route not found" },
        { status: 404 },
      );
    },
  });

  const sandbox = new AgentSandboxClient({
    apiServerUrl: `http://127.0.0.1:${sandboxServer.port}/`,
    namespace: "test",
    bearerToken: "local-sandbox-fixture-token",
  });
  const composition = () =>
    new ProviderComposition({
      sandbox,
      world: {
        observe: async () => {
          const { execution: _execution, ...facts } = observation();
          return { ok: true, value: facts };
        },
      },
      openCodeForSandbox: () =>
        new OpenCodeAdapter({
          baseUrl: `http://127.0.0.1:${openCodeServer!.port}/`,
        }),
      sandboxIntent: (commission) => ({
        commissionId: commission.id,
        project: commission.campaignId,
        repository: commission.repository,
        baseRef: commission.integrationTarget,
        imageDigest: `ghcr.io/example/anvil-sandbox@sha256:${"a".repeat(64)}`,
        workspaceSize: "10Gi",
        openCodePort: 4096,
        profileClaim: "profile-pvc",
        sharedNixClaim: "nix-pvc",
        environment: {},
        secretReferences: [],
      }),
      model: { providerId: "fixture-provider", modelId: "fixture-model" },
    });
  return {
    composition,
    sandboxCreates: () => sandboxCreates,
    sessionCreates: () => sessionCreates,
    promptSubmissions: () => promptSubmissions,
    leaseAndAuthorization: world,
  };
}

test("ApplicationService persists Sandbox and OpenCode identities before continuing over local provider HTTP", async () => {
  let repository = openStore();
  const world = new FakeWorld();
  const providers = localProviders(world);
  const runtimePolicy = { ...policy, runtimeProvisioning: true };
  const createApp = (current: CommissionStore) =>
    new ApplicationService(
      current,
      world,
      providers.composition(),
      world,
      "controller-1",
      runtimePolicy,
    );
  let app = createApp(repository);
  const commissionId = "commission-runtime-http";
  expect(app.propose(proposalInput({ id: commissionId })).ok).toBe(true);
  expect((await app.admit(commissionId, "operator-1", epoch)).ok).toBe(true);

  const provision = await app.reconcile(commissionId, epoch + 1);
  expect(provision.ok && provision.value.decision?.kind).toBe(
    "provision_sandbox",
  );
  expect(repository.operations(commissionId)[0]).toMatchObject({
    kind: "provision_sandbox",
    outcome: {
      kind: "observed",
      result: "applied",
      externalIdentity: expect.stringMatching(/^anvil-/),
    },
  });
  expect(providers.sandboxCreates()).toBe(1);

  repository.close();
  store = undefined;
  repository = new CommissionStore(join(directory!, "state.sqlite"));
  store = repository;
  app = createApp(repository);
  const createSession = await app.reconcile(commissionId, epoch + 2);
  expect(createSession.ok && createSession.value.decision?.kind).toBe(
    "create_session",
  );
  expect(repository.operations(commissionId)[1]).toMatchObject({
    kind: "create_session",
    outcome: {
      kind: "observed",
      result: "applied",
      externalIdentity: "session-local-1",
    },
  });
  expect(providers.sessionCreates()).toBe(1);

  repository.close();
  store = undefined;
  repository = new CommissionStore(join(directory!, "state.sqlite"));
  store = repository;
  app = createApp(repository);
  const continueTurn = await app.reconcile(commissionId, epoch + 3);
  expect(continueTurn.ok && continueTurn.value.decision?.kind).toBe("continue");
  expect(repository.operations(commissionId)[2]?.kind).toBe("continue");
  expect(providers.promptSubmissions()).toBe(1);

  const waiting = await app.reconcile(commissionId, epoch + 4);
  expect(waiting.ok && waiting.value.decision?.kind).toBe("wait");
  expect(providers.promptSubmissions()).toBe(1);
});

test("ProviderComposition creates and reobserves a GitHub PR without duplicate create", async () => {
  const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKey = keyPair.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  let pullRequest: Record<string, unknown> | null = null;
  let writes = 0;
  let branchRevision = "candidate-from-another-worker";
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
            token: `ghs_${body.permissions["pull_requests"]}`,
            expires_at: new Date(epoch + 3_600_000).toISOString(),
            permissions: body.permissions,
          },
          { status: 201 },
        );
      }
      if (url.pathname === "/api/repos/acme/demo/branches/anvil%2Fruntime-work")
        return Response.json({
          name: "anvil/runtime-work",
          commit: { sha: branchRevision },
        });
      if (
        url.pathname === "/api/repos/acme/demo/pulls" &&
        request.method === "GET"
      )
        return Response.json(pullRequest === null ? [] : [pullRequest]);
      if (
        url.pathname === "/api/repos/acme/demo/pulls" &&
        request.method === "POST"
      ) {
        writes += 1;
        const body = (await request.json()) as {
          head: string;
          base: string;
        };
        const headRef = body.head.split(":").slice(1).join(":");
        pullRequest = {
          number: 31,
          html_url: "https://github.com/acme/demo/pull/31",
          state: "open",
          merged: false,
          head: { ref: headRef, sha: "candidate-runtime-sha" },
          base: { ref: body.base },
        };
        return Response.json(pullRequest, { status: 201 });
      }
      return Response.json(
        { message: "fixture route not found" },
        { status: 404 },
      );
    },
  });
  const apiUrl = `http://127.0.0.1:${githubServer.port}/api/`;
  const composition = new ProviderComposition({
    sandbox: new AgentSandboxClient({
      apiServerUrl: "http://127.0.0.1:1/",
      namespace: "test",
      bearerToken: "unused-local-token",
    }),
    world: {
      observe: async () => {
        const { execution: _execution, ...facts } = observation();
        return { ok: true, value: facts };
      },
    },
    openCodeForSandbox: () =>
      new OpenCodeAdapter({ baseUrl: "http://127.0.0.1:1/" }),
    sandboxIntent: () => {
      throw new Error("GitHub Operation test must not provision a Sandbox");
    },
    github: new GitHubDeliveryClient(
      new GitHubAppBroker({
        appId: "fixture-app",
        installationId: 42,
        privateKey,
        apiUrl,
        now: () => epoch,
      }),
      { apiUrl, now: () => epoch + 1 },
    ),
    workBranch: () => "anvil/runtime-work",
    model: { providerId: "fixture-provider", modelId: "fixture-model" },
  });
  const commission = proposal({
    id: "commission-github-composition",
    repository: "https://github.com/acme/demo",
    integrationTarget: "main",
  }).commission;
  const operation: Operation = {
    id: "integrate-op-1",
    logicalKey: "integrate-op-1",
    commissionId: commission.id,
    kind: "integrate",
    target: "delivery:https://github.com/acme/demo:main",
    controllerId: "controller-1",
    ownerEpoch: 1,
    specificationGeneration: 1,
    assignmentId: "assignment-1",
    attemptId: "attempt-1",
    instructionSequence: 1,
    retryCount: 0,
    candidateRevision: "candidate-runtime-sha",
    findingIds: [],
    directive: "integrate candidate-runtime-sha",
    createdAt: epoch,
    outcome: { kind: "prepared" },
  };
  expect(
    await composition.dispatch(commission, operation, epoch + 1),
  ).toMatchObject({
    ok: false,
    error: { kind: "rejected" },
  });
  expect(writes).toBe(0);
  branchRevision = "candidate-runtime-sha";
  const dispatched = await composition.dispatch(
    commission,
    operation,
    epoch + 1,
  );
  expect(dispatched).toMatchObject({
    ok: true,
    value: {
      kind: "observed",
      result: "accepted",
      externalIdentity: "https://github.com/acme/demo/pull/31",
    },
  });
  const inspected = await composition.inspectOperation(
    commission,
    operation,
    epoch + 2,
  );
  expect(inspected).toMatchObject({
    ok: true,
    value: {
      kind: "observed",
      result: "accepted",
      externalIdentity: "https://github.com/acme/demo/pull/31",
    },
  });
  expect(writes).toBe(1);
});

test("ProviderComposition verifies only the immutable Candidate SHA and reobserves without a write", async () => {
  const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKey = keyPair.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  let checkReads = 0;
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
            token: `ghs_${body.permissions["checks"]}`,
            expires_at: new Date(epoch + 3_600_000).toISOString(),
            permissions: body.permissions,
          },
          { status: 201 },
        );
      }
      if (
        url.pathname ===
        "/api/repos/acme/demo/commits/candidate-verify-sha/check-runs"
      ) {
        expect(request.method).toBe("GET");
        checkReads += 1;
        return Response.json({
          total_count: 1,
          check_runs: [
            {
              id: 81,
              name: "required / unit",
              head_sha: "candidate-verify-sha",
              status: "queued",
              conclusion: null,
              details_url: null,
            },
          ],
        });
      }
      if (url.pathname === "/api/repos/acme/demo/rules/branches/main")
        return Response.json([
          {
            type: "required_status_checks",
            parameters: {
              required_status_checks: [
                { context: "required / unit", integration_id: 7 },
              ],
            },
          },
        ]);
      if (
        url.pathname ===
        "/api/repos/acme/demo/branches/main/protection/required_status_checks"
      )
        return Response.json({ contexts: [], checks: [] });
      if (
        url.pathname ===
        "/api/repos/acme/demo/commits/candidate-verify-sha/status"
      )
        return Response.json({
          sha: "candidate-verify-sha",
          total_count: 0,
          statuses: [],
        });
      return Response.json(
        { message: "unexpected fixture route" },
        { status: 404 },
      );
    },
  });
  const apiUrl = `http://127.0.0.1:${githubServer.port}/api/`;
  const github = new GitHubDeliveryClient(
    new GitHubAppBroker({
      appId: "fixture-app",
      installationId: 42,
      privateKey,
      apiUrl,
      now: () => epoch,
    }),
    { apiUrl, now: () => epoch + 1 },
  );
  const composition = new ProviderComposition({
    sandbox: new AgentSandboxClient({
      apiServerUrl: "http://127.0.0.1:1/",
      namespace: "test",
      bearerToken: "unused-local-token",
    }),
    world: {
      observe: async (_commission, now) => {
        const checks = await github.requiredChecksForCandidate(
          "https://github.com/acme/demo",
          "main",
          "candidate-verify-sha",
          now,
          now + 60_000,
        );
        if (!checks.ok)
          return {
            ok: false,
            error: { kind: "unavailable", message: checks.error.message },
          };
        const { execution: _execution, ...facts } = observation({
          candidateRevision: "candidate-verify-sha",
          checks: checks.value,
        });
        return { ok: true, value: facts };
      },
    },
    openCodeForSandbox: () =>
      new OpenCodeAdapter({ baseUrl: "http://127.0.0.1:1/" }),
    sandboxIntent: () => {
      throw new Error("Verify Operation must not provision a Sandbox");
    },
    github,
    workBranch: () => "anvil/verify-work",
    model: { providerId: "fixture-provider", modelId: "fixture-model" },
  });
  const commission = proposal({
    id: "commission-github-verify",
    repository: "https://github.com/acme/demo",
  }).commission;
  const operation: Operation = {
    id: "verify-op-1",
    logicalKey: "verify-op-1",
    commissionId: commission.id,
    kind: "verify",
    target: "checks:https://github.com/acme/demo:candidate-verify-sha",
    controllerId: "controller-1",
    ownerEpoch: 1,
    specificationGeneration: 1,
    assignmentId: "assignment-1",
    attemptId: "attempt-1",
    instructionSequence: 1,
    retryCount: 0,
    candidateRevision: "candidate-verify-sha",
    findingIds: [],
    directive: "verify candidate-verify-sha",
    createdAt: epoch,
    outcome: { kind: "prepared" },
  };

  const verified = await composition.dispatch(commission, operation, epoch + 1);
  expect(verified).toMatchObject({
    ok: true,
    value: {
      kind: "observed",
      result: "applied",
      source: "github-required-status-checks",
      externalIdentity: expect.stringContaining("github-required-checks:"),
    },
  });
  if (!verified.ok) throw new Error("Candidate verification failed");
  if (verified.value.kind !== "observed")
    throw new Error("Candidate Verify Operation was not observed");
  expect(
    await composition.inspectOperation(commission, operation, epoch + 2),
  ).toMatchObject({
    ok: true,
    value: {
      kind: "observed",
      result: "applied",
      externalIdentity: verified.value.externalIdentity,
    },
  });
  expect(checkReads).toBe(2);
});

test("composed local providers drive a Commission from Workspace provisioning through queue and authoritative merge", async () => {
  const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKey = keyPair.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  let sandboxResource: Record<string, unknown> | null = null;
  let sessionCreates = 0;
  let prompts = 0;
  let candidateRevision: string | null = null;
  let checkState: "failing" | "pending" | "passing" = "failing";
  let pullRequest: Record<string, unknown> | null = null;
  let pullRequestCreates = 0;
  let queued = false;
  let merged = false;

  sandboxServer = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      expect(request.headers.get("authorization")).toBe(
        "Bearer local-sandbox-token",
      );
      if (url.pathname.endsWith("/sandboxes") && request.method === "GET")
        return Response.json({
          items: sandboxResource === null ? [] : [sandboxResource],
        });
      if (url.pathname.endsWith("/sandboxes") && request.method === "POST") {
        const desired = (await request.json()) as Record<string, unknown>;
        const metadata = desired["metadata"] as Record<string, unknown>;
        sandboxResource = {
          ...desired,
          metadata: { ...metadata, uid: "workspace-uid", resourceVersion: "1" },
          status: { conditions: [{ type: "Ready", status: "True" }] },
        };
        return Response.json(sandboxResource, { status: 201 });
      }
      const prefix = "/apis/agents.x-k8s.io/v1beta1/namespaces/test/sandboxes/";
      if (url.pathname.startsWith(prefix))
        return sandboxResource === null
          ? Response.json({ message: "not found" }, { status: 404 })
          : Response.json(sandboxResource);
      return Response.json(
        { message: "sandbox route not found" },
        { status: 404 },
      );
    },
  });

  openCodeServer = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/info")
        return Response.json({ version: "2.0.26+fixture" });
      if (url.pathname === "/api/session/active")
        return Response.json({ data: {} });
      if (url.pathname === "/api/session") {
        sessionCreates += 1;
        return Response.json({ data: { id: "session-delivery" } });
      }
      if (url.pathname.endsWith("/model"))
        return new Response(null, { status: 204 });
      if (url.pathname.endsWith("/prompt")) {
        prompts += 1;
        candidateRevision =
          prompts === 1 ? "candidate-delivery" : "candidate-delivery-repaired";
        if (prompts > 1) checkState = "pending";
        const body = (await request.json()) as { id: string; text: string };
        return Response.json({ data: { id: body.id } });
      }
      if (url.pathname.endsWith("/message")) return Response.json({ data: [] });
      return Response.json(
        { message: "OpenCode route not found" },
        { status: 404 },
      );
    },
  });

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
            token: `ghs_${body.permissions["pull_requests"]}`,
            expires_at: new Date(epoch + 3_600_000).toISOString(),
            permissions: body.permissions,
          },
          { status: 201 },
        );
      }
      if (url.pathname.endsWith("/branches/anvil%2Fcommission-delivery")) {
        return candidateRevision !== null
          ? Response.json({
              name: "anvil/commission-delivery",
              commit: { sha: candidateRevision },
            })
          : Response.json(
              { message: "branch has not been published" },
              { status: 404 },
            );
      }
      if (url.pathname.includes("/check-runs"))
        return Response.json({
          total_count: 1,
          check_runs: [
            {
              id: 51,
              name: "ci / required",
              head_sha: candidateRevision,
              status: checkState === "pending" ? "queued" : "completed",
              conclusion:
                checkState === "passing"
                  ? "success"
                  : checkState === "failing"
                    ? "failure"
                    : null,
              details_url: "https://github.com/acme/demo/actions/51",
            },
          ],
        });
      if (url.pathname === "/api/repos/acme/demo/rules/branches/main")
        return Response.json([
          {
            type: "required_status_checks",
            parameters: {
              required_status_checks: [
                { context: "ci / required", integration_id: null },
              ],
            },
          },
        ]);
      if (
        url.pathname ===
        "/api/repos/acme/demo/branches/main/protection/required_status_checks"
      )
        return Response.json({ contexts: [], checks: [] });
      if (
        url.pathname.includes("/commits/") &&
        url.pathname.endsWith("/status")
      ) {
        const sha = url.pathname.split("/commits/")[1]?.split("/")[0];
        return Response.json({ sha, total_count: 0, statuses: [] });
      }
      if (url.pathname.endsWith("/pulls") && request.method === "GET")
        return Response.json(pullRequest === null ? [] : [pullRequest]);
      if (url.pathname.endsWith("/pulls") && request.method === "POST") {
        pullRequestCreates += 1;
        const body = (await request.json()) as { head: string; base: string };
        pullRequest = {
          number: 52,
          html_url: "https://github.com/acme/demo/pull/52",
          state: merged ? "closed" : "open",
          merged,
          head: {
            ref: body.head.split(":").slice(1).join(":"),
            sha: candidateRevision,
          },
          base: { ref: body.base },
        };
        return Response.json(pullRequest, { status: 201 });
      }
      if (url.pathname.endsWith("/pulls/52"))
        return pullRequest === null
          ? Response.json({ message: "not found" }, { status: 404 })
          : Response.json({
              ...pullRequest,
              state: merged ? "closed" : "open",
              merged,
            });
      return Response.json(
        { message: "GitHub route not found" },
        { status: 404 },
      );
    },
  });

  mergifyServer = Bun.serve({
    port: 0,
    fetch(request) {
      expect(request.headers.get("authorization")).toBe(
        "Bearer local-mergify-token",
      );
      return queued
        ? Response.json({
            number: 52,
            queued_at: "2026-10-28T10:00:00Z",
            position: 0,
            ci_state: "pending",
            state: "waiting_for_checks",
            checks: [{ name: "merge-group", state: "pending" }],
          })
        : Response.json(
            { error_code: "PULL_REQUEST_NOT_QUEUED", detail: "not queued" },
            { status: 404 },
          );
    },
  });

  const githubApi = `http://127.0.0.1:${githubServer.port}/api/`;
  const delivery = new GitHubDeliveryClient(
    new GitHubAppBroker({
      appId: "fixture-app",
      installationId: 42,
      privateKey,
      apiUrl: githubApi,
      now: () => epoch,
    }),
    { apiUrl: githubApi, now: () => epoch + 1 },
  );
  const gitHubWorld = new GitHubWorldObserver({
    delivery,
    mergify: new MergifyQueueClient({
      apiUrl: `http://127.0.0.1:${mergifyServer.port}/v1/`,
      bearerToken: "local-mergify-token",
    }),
    workBranch: (commission) => `anvil/${commission.id}`,
    maxObservationAgeMs: 60_000,
  });
  const fakeControlPlane = new FakeWorld();
  const { execution: _unusedExecution, ...unusedFacts } = observation();
  const providers = new ProviderComposition({
    sandbox: new AgentSandboxClient({
      apiServerUrl: `http://127.0.0.1:${sandboxServer.port}/`,
      namespace: "test",
      bearerToken: "local-sandbox-token",
    }),
    world: {
      observe: async (commission, now) => {
        const facts = await gitHubWorld.observe(commission, now);
        if (!facts.ok) return facts;
        return {
          ok: true,
          value: {
            ...facts.value,
            workerClaims:
              facts.value.candidateRevision === null
                ? []
                : [
                    {
                      id: `worker:${facts.value.candidateRevision}`,
                      obligationId: "acceptance-1",
                      claim: "Local fixture reports the obligation implemented",
                      observedAt: now,
                      expiresAt: now + 60_000,
                      sourceIdentity: "local-opencode-contract-fixture",
                    },
                  ],
          },
        };
      },
    },
    openCodeForSandbox: () =>
      new OpenCodeAdapter({
        baseUrl: `http://127.0.0.1:${openCodeServer!.port}/`,
      }),
    sandboxIntent: (commission) => ({
      commissionId: commission.id,
      project: commission.campaignId,
      repository: commission.repository,
      baseRef: commission.integrationTarget,
      imageDigest: `ghcr.io/example/anvil-sandbox@sha256:${"a".repeat(64)}`,
      workspaceSize: "10Gi",
      openCodePort: 4096,
      profileClaim: "profile-pvc",
      sharedNixClaim: "nix-pvc",
      environment: {},
      secretReferences: [],
    }),
    github: delivery,
    workBranch: (commission) => `anvil/${commission.id}`,
    model: { providerId: "fixture-provider", modelId: "fixture-model" },
  });
  let repository = openStore();
  const runtimePolicy = { ...policy, runtimeProvisioning: true };
  const app = () =>
    new ApplicationService(
      repository,
      fakeControlPlane,
      providers,
      fakeControlPlane,
      "controller-1",
      runtimePolicy,
    );
  const commissionId = "commission-delivery";
  let application = app();
  expect(
    application.propose(
      proposalInput({
        id: commissionId,
        repository: "https://github.com/acme/demo",
      }),
    ).ok,
  ).toBe(true);
  expect((await application.admit(commissionId, "operator-1", epoch)).ok).toBe(
    true,
  );

  const decisions: string[] = [];
  let completed = false;
  for (let step = 1; step <= 12; step += 1) {
    const result = await application.reconcile(commissionId, epoch + step);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Local provider lifecycle failed");
    const kind = result.value.decision?.kind;
    if (kind !== undefined) decisions.push(kind);
    if (kind === "wait" && result.value.decision?.wake.kind === "check_run") {
      checkState = "passing";
    }
    if (kind === "wait" && result.value.decision?.wake.kind === "merge_queue") {
      if (queued) merged = true;
      else queued = true;
    }
    if (result.value.commission.lifecycle === "concluded") {
      completed = true;
      break;
    }
    if (step === 3 || step === 5) {
      repository.close();
      store = undefined;
      repository = new CommissionStore(join(directory!, "state.sqlite"));
      store = repository;
      application = app();
    }
  }
  if (!completed)
    throw new Error(
      `Local provider delivery did not complete: ${JSON.stringify({ decisions, lifecycle: repository.get(commissionId)?.lifecycle, operations: repository.operations(commissionId).map(({ kind, outcome }) => ({ kind, outcome })) })}`,
    );
  expect(decisions).toEqual([
    "provision_sandbox",
    "create_session",
    "continue",
    "repair",
    "wait",
    "integrate",
    "wait",
    "wait",
    "conclude",
  ]);
  expect(repository.get(commissionId)?.deliveryEvidence).toMatchObject({
    revision: "candidate-delivery-repaired",
    repository: "https://github.com/acme/demo",
    integrationTarget: "main",
    providerIdentity: "https://github.com/acme/demo/pull/52",
  });
  expect(sandboxResource).not.toBeNull();
  expect(sessionCreates).toBe(1);
  expect(prompts).toBe(2);
  expect(pullRequestCreates).toBe(1);
  expect(unusedFacts.candidateRevision).toBeNull();
});
