import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeAdapter } from "../src/providers/opencode";
import { proposalInput } from "./support/fixtures";

type Child = Readonly<{
  kill: (signal?: number | NodeJS.Signals) => void;
  exited: Promise<number>;
}>;

const apiToken = "local-configured-provider-daemon-token-45chars";
let directory: string | undefined;
let daemonProcess: Child | undefined;
let sandboxServer: ReturnType<typeof Bun.serve> | undefined;
let openCodeServer: ReturnType<typeof Bun.serve> | undefined;
let githubServer: ReturnType<typeof Bun.serve> | undefined;
let mergifyServer: ReturnType<typeof Bun.serve> | undefined;
let provisionCount = 0;
let sessionCreateCount = 0;
let promptCount = 0;

afterEach(async () => {
  if (daemonProcess !== undefined) {
    daemonProcess.kill("SIGTERM");
    await daemonProcess.exited;
    daemonProcess = undefined;
  }
  for (const server of [
    sandboxServer,
    openCodeServer,
    githubServer,
    mergifyServer,
  ])
    server?.stop(true);
  sandboxServer = undefined;
  openCodeServer = undefined;
  githubServer = undefined;
  mergifyServer = undefined;
  if (directory !== undefined)
    rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function allocatePort(): number {
  const listener = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = listener.port;
  listener.stop(true);
  return port;
}

function startDaemon(environment: Record<string, string>): Child {
  return Bun.spawn(["bun", "run", "src/main.ts"], {
    cwd: process.cwd(),
    env: { ...(process.env as Record<string, string>), ...environment },
    stdout: "ignore",
    stderr: "inherit",
  });
}

async function waitUntilReady(baseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/readyz`)).ok) return;
    } catch {
      // The configured Bun child may still be starting.
    }
    await Bun.sleep(25);
  }
  throw new Error("Configured daemon did not become ready within four seconds");
}

async function waitForBootstrapOperations(
  baseUrl: string,
  commissionId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(
      `${baseUrl}/api/commissions/${commissionId}/operations`,
      { headers: { authorization: `Bearer ${apiToken}` } },
    );
    if (response.ok) {
      const body = (await response.json()) as {
        operations: readonly {
          kind: string;
          outcome: { kind: string };
        }[];
      };
      const expected = ["provision_sandbox", "create_session", "continue"];
      if (
        expected.every((kind) =>
          body.operations.some(
            (operation) =>
              operation.kind === kind && operation.outcome.kind === "observed",
          ),
        )
      )
        return;
    }
    await Bun.sleep(25);
  }
  throw new Error("Configured provider bootstrap Operations did not finish");
}

async function waitForAmbiguousSessionCreate(
  baseUrl: string,
  commissionId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const response = await fetch(
      `${baseUrl}/api/commissions/${commissionId}/operations`,
      { headers: { authorization: `Bearer ${apiToken}` } },
    );
    if (response.ok) {
      const body = (await response.json()) as {
        operations: readonly { kind: string; outcome: { kind: string } }[];
      };
      if (
        body.operations.some(
          (operation) =>
            operation.kind === "create_session" &&
            operation.outcome.kind === "ambiguous",
        )
      )
        return;
    }
    await Bun.sleep(25);
  }
  throw new Error(
    "Session-create lost acknowledgement was not durably recorded",
  );
}

async function waitForLifecycle(
  baseUrl: string,
  commissionId: string,
  lifecycle: string,
): Promise<Record<string, unknown>> {
  let commission: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/commissions/${commissionId}`, {
      headers: { authorization: `Bearer ${apiToken}` },
    });
    if (response.ok) {
      const body = (await response.json()) as {
        commission: Record<string, unknown>;
      };
      commission = body.commission;
      if (commission["lifecycle"] === lifecycle) return commission;
    }
    await Bun.sleep(25);
  }
  throw new Error(
    `Daemon did not reach ${lifecycle} for ${commissionId}: ${JSON.stringify(commission)}`,
  );
}

async function waitForOperationCount(
  baseUrl: string,
  commissionId: string,
  kind: string,
  count: number,
): Promise<
  readonly {
    kind: string;
    candidateRevision: string | null;
    outcome: { kind: string };
  }[]
> {
  let operations: readonly {
    kind: string;
    candidateRevision: string | null;
    outcome: { kind: string };
  }[] = [];
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const response = await fetch(
      `${baseUrl}/api/commissions/${commissionId}/operations`,
      { headers: { authorization: `Bearer ${apiToken}` } },
    );
    if (response.ok) {
      operations = (
        (await response.json()) as {
          operations: typeof operations;
        }
      ).operations;
      if (
        operations.filter(
          (operation) =>
            operation.kind === kind && operation.outcome.kind === "observed",
        ).length >= count
      )
        return operations;
    }
    await Bun.sleep(25);
  }
  throw new Error(
    `Configured daemon did not record ${count} ${kind} Operations: ${JSON.stringify(operations)}`,
  );
}

async function waitForOperationKind(
  baseUrl: string,
  commissionId: string,
  kind: string,
  outcomeKind = "observed",
): Promise<
  readonly { kind: string; directive: string; outcome: { kind: string } }[]
> {
  let lastOperations: readonly {
    kind: string;
    directive: string;
    outcome: { kind: string };
  }[] = [];
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const response = await fetch(
      `${baseUrl}/api/commissions/${commissionId}/operations`,
      { headers: { authorization: `Bearer ${apiToken}` } },
    );
    if (response.ok) {
      const body = (await response.json()) as {
        operations: readonly {
          kind: string;
          directive: string;
          outcome: { kind: string };
        }[];
      };
      lastOperations = body.operations;
      if (
        body.operations.some(
          (operation) =>
            operation.kind === kind && operation.outcome.kind === outcomeKind,
        )
      )
        return body.operations;
    }
    await Bun.sleep(25);
  }
  throw new Error(
    `Configured daemon did not complete ${kind} watchdog work: ${JSON.stringify(lastOperations)}`,
  );
}

test("configured Bun daemon composes local HTTP providers and recovers bindings without replay", async () => {
  directory = mkdtempSync(join(tmpdir(), "anvil-configured-daemon-"));
  const serverPort = allocatePort();
  const sandboxPort = allocatePort();
  const openCodePort = allocatePort();
  const githubPort = allocatePort();
  const mergifyPort = allocatePort();
  const sandboxResources = new Map<string, Record<string, unknown>>();
  const sessions = new Map<string, string>();
  const userMessageIds = new Map<string, string>();
  const assistantEvidenceTexts = new Map<string, string>();
  let loseNextSessionCreateAck = false;
  let watchdogMode = false;
  let interruptCount = 0;
  let loseNextInterruptAck = false;
  let interruptInspectionBusy = false;
  let deliveryRevision: string | null = null;
  let deliveryPromptCount = 0;
  let deliveryCheckState: "failing" | "pending" | "passing" = "failing";
  let staleDeliveryChecks = false;
  let deliveryBranchName: string | null = null;
  let deliveryCheckRunId = 0;
  let deliveryPullRequest: Record<string, unknown> | null = null;
  let deliveryPullRequestCreates = 0;
  let deliveryQueued = false;
  let loseDeliveryPullRequestAck = true;
  let deliveryMerged = false;
  let deliveryPullRequestUrl = "https://github.com/acme/demo/pull/52";
  let deliveryPullRequestHeadSha: string | null = null;
  const openCodeEventSubscribers = new Set<
    ReadableStreamDefaultController<Uint8Array>
  >();
  let watchdogProgressAt = Date.now() - 30_000;
  let watchdogTokenInput = 9_000;
  provisionCount = 0;
  sessionCreateCount = 0;
  promptCount = 0;

  sandboxServer = Bun.serve({
    port: sandboxPort,
    async fetch(request) {
      expect(request.headers.get("authorization")).toBe(
        "Bearer local-kubernetes-token",
      );
      const url = new URL(request.url);
      if (url.pathname.endsWith("/sandboxes") && request.method === "GET")
        return Response.json({ items: [...sandboxResources.values()] });
      if (url.pathname.endsWith("/sandboxes") && request.method === "POST") {
        provisionCount += 1;
        const desired = (await request.json()) as Record<string, unknown>;
        const metadata = desired["metadata"] as Record<string, unknown>;
        const resource = {
          ...desired,
          metadata: {
            ...metadata,
            resourceVersion: "1",
            uid: "configured-uid",
          },
          status: { conditions: [{ type: "Ready", status: "True" }] },
        };
        sandboxResources.set(metadata["name"] as string, resource);
        return Response.json(resource, { status: 201 });
      }
      const prefix =
        "/apis/agents.x-k8s.io/v1beta1/namespaces/configured-test/sandboxes/";
      if (url.pathname.startsWith(prefix)) {
        const name = decodeURIComponent(url.pathname.slice(prefix.length));
        const resource = sandboxResources.get(name);
        return resource === undefined
          ? Response.json({ message: "not found" }, { status: 404 })
          : Response.json(resource);
      }
      return Response.json({ message: "not found" }, { status: 404 });
    },
  });

  openCodeServer = Bun.serve({
    port: openCodePort,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/api/event")) {
        let subscriber: ReadableStreamDefaultController<Uint8Array> | undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            subscriber = controller;
            openCodeEventSubscribers.add(controller);
          },
          cancel() {
            if (subscriber !== undefined)
              openCodeEventSubscribers.delete(subscriber);
          },
        });
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (url.pathname.endsWith("/api/info"))
        return Response.json({ version: "2.0.26+fixture" });
      if (url.pathname.endsWith("/api/session/active"))
        return Response.json({
          data:
            watchdogMode || interruptInspectionBusy
              ? Object.fromEntries(
                  [...sessions]
                    .filter(([sandboxName]) =>
                      sandboxName.startsWith("anvil-configured-"),
                    )
                    .map(([, sessionId]) => [sessionId, { type: "running" }]),
                )
              : {},
        });
      if (url.pathname.endsWith("/interrupt")) {
        expect(request.method).toBe("POST");
        expect(url.searchParams.get("resume")).toBe("false");
        interruptCount += 1;
        watchdogMode = false;
        if (loseNextInterruptAck) {
          loseNextInterruptAck = false;
          interruptInspectionBusy = true;
          return Response.json(
            { message: "interrupt accepted but acknowledgement lost" },
            { status: 504 },
          );
        }
        return Response.json({ data: { interrupted: true } });
      }
      if (url.pathname.endsWith("/api/session") && request.method === "POST") {
        sessionCreateCount += 1;
        const sandboxName = url.pathname.split("/")[1]!;
        const sessionId = `session-${sandboxName}`;
        sessions.set(sandboxName, sessionId);
        if (loseNextSessionCreateAck) {
          loseNextSessionCreateAck = false;
          return Response.json(
            { message: "accepted but acknowledgement lost" },
            { status: 504 },
          );
        }
        return Response.json({ data: { id: sessionId } });
      }
      if (url.pathname.endsWith("/api/model"))
        return Response.json({
          data: [
            {
              providerID: "fixture-provider",
              modelID: "fixture-model",
              limit: { context: 10_000 },
            },
          ],
        });
      if (url.pathname.endsWith("/model"))
        return new Response(null, { status: 204 });
      if (url.pathname.endsWith("/prompt")) {
        promptCount += 1;
        const prompt = (await request.json()) as { id: string; text: string };
        const sandboxName = url.pathname.split("/")[1]!;
        userMessageIds.set(sandboxName, prompt.id);
        if (sandboxName.startsWith("anvil-configured-delivery-")) {
          deliveryPromptCount += 1;
          deliveryRevision = `worker-commit-${deliveryPromptCount}`;
          const reportedRevision =
            deliveryPromptCount === 2 ? "worker-commit-1" : deliveryRevision;
          assistantEvidenceTexts.set(
            sandboxName,
            `ANVIL_EVIDENCE acceptance-1 ${reportedRevision}: Implemented and repaired the requested behavior.`,
          );
          if (deliveryPromptCount > 1) deliveryCheckState = "pending";
        }
        return Response.json({ data: { id: prompt.id } });
      }
      if (url.pathname.endsWith("/message")) {
        const userMessageId = userMessageIds.get(url.pathname.split("/")[1]!);
        return Response.json({
          data:
            userMessageId === undefined
              ? []
              : [
                  { id: userMessageId, type: "user" },
                  ...(assistantEvidenceTexts.has(url.pathname.split("/")[1]!)
                    ? [
                        {
                          id: `assistant-${userMessageId}`,
                          type: "assistant",
                          parentID: userMessageId,
                          time: {
                            created: Date.now() - 100,
                            completed: Date.now(),
                          },
                          content: [
                            {
                              type: "text",
                              text: assistantEvidenceTexts.get(
                                url.pathname.split("/")[1]!,
                              ),
                            },
                          ],
                        },
                      ]
                    : []),
                  ...(watchdogMode
                    ? [
                        {
                          id: "watchdog-assistant-message",
                          type: "assistant",
                          time: {
                            created: watchdogProgressAt - 20_000,
                            streamed: watchdogProgressAt - 10_000,
                            completed: watchdogProgressAt,
                          },
                          tokens: {
                            input: watchdogTokenInput,
                            output: 100,
                            reasoning: 0,
                            cache: { read: 0, write: 0 },
                          },
                          content: [],
                        },
                      ]
                    : []),
                ],
        });
      }
      return Response.json({ message: "not found" }, { status: 404 });
    },
  });

  githubServer = Bun.serve({
    port: githubPort,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/app/installations/42/access_tokens")) {
        const body = (await request.json()) as {
          permissions: Record<string, string>;
        };
        return Response.json(
          {
            token: `ghs_${body.permissions["pull_requests"]}`,
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            permissions: body.permissions,
          },
          { status: 201 },
        );
      }
      const branchPath = "/api/repos/acme/demo/branches/";
      if (url.pathname.startsWith(branchPath)) {
        const branch = decodeURIComponent(
          url.pathname.slice(branchPath.length),
        );
        if (
          branch.startsWith("anvil/configured-delivery-") &&
          deliveryRevision !== null
        ) {
          deliveryBranchName = branch;
          return Response.json({
            name: branch,
            commit: { sha: deliveryRevision },
          });
        }
        return Response.json({ message: "branch not found" }, { status: 404 });
      }
      if (url.pathname === "/api/repos/acme/demo/rules/branches/main")
        return Response.json([
          {
            type: "required_status_checks",
            parameters: {
              required_status_checks: [
                { context: "ci / required", integration_id: 7 },
              ],
            },
          },
        ]);
      if (
        url.pathname ===
        "/api/repos/acme/demo/branches/main/protection/required_status_checks"
      )
        return Response.json(
          { message: "no classic protection" },
          { status: 404 },
        );
      if (
        url.pathname.includes("/commits/") &&
        url.pathname.endsWith("/check-runs")
      ) {
        const sha = url.pathname.split("/commits/")[1]?.split("/")[0] ?? "";
        deliveryCheckRunId += 1;
        return Response.json({
          total_count: 1,
          check_runs: [
            {
              id: deliveryCheckRunId,
              name: "ci / required",
              head_sha:
                staleDeliveryChecks && sha === deliveryRevision
                  ? "stale-worker-commit"
                  : sha,
              app_id: 7,
              status:
                deliveryCheckState === "pending" ? "in_progress" : "completed",
              conclusion:
                deliveryCheckState === "passing"
                  ? "success"
                  : deliveryCheckState === "failing"
                    ? "failure"
                    : null,
              details_url: "https://github.com/acme/demo/actions/701",
            },
          ],
        });
      }
      if (
        url.pathname.includes("/commits/") &&
        url.pathname.endsWith("/status")
      ) {
        const sha = url.pathname.split("/commits/")[1]?.split("/")[0] ?? "";
        return Response.json({ sha, total_count: 0, statuses: [] });
      }
      if (url.pathname.endsWith("/pulls") && request.method === "GET")
        return Response.json(
          deliveryPullRequest === null ? [] : [deliveryPullRequest],
        );
      if (url.pathname.endsWith("/pulls") && request.method === "POST") {
        deliveryPullRequestCreates += 1;
        const body = (await request.json()) as { head: string; base: string };
        deliveryBranchName ??= body.head.split(":").slice(1).join(":");
        deliveryPullRequest = {
          number: 52,
          html_url: "https://github.com/acme/demo/pull/52",
          state: "open",
          merged: false,
          head: {
            ref: deliveryBranchName,
            sha: deliveryRevision,
          },
          base: { ref: body.base },
        };
        deliveryQueued = true;
        if (loseDeliveryPullRequestAck) {
          loseDeliveryPullRequestAck = false;
          return Response.json(
            { message: "PR created but acknowledgement lost" },
            { status: 504 },
          );
        }
        return Response.json(deliveryPullRequest, { status: 201 });
      }
      if (url.pathname.endsWith("/pulls/52"))
        return deliveryPullRequest === null
          ? Response.json({ message: "PR not found" }, { status: 404 })
          : Response.json({
              ...deliveryPullRequest,
              state: deliveryMerged ? "closed" : "open",
              merged: deliveryMerged,
              head: {
                ...(deliveryPullRequest["head"] as Record<string, unknown>),
                sha: deliveryPullRequestHeadSha ?? deliveryRevision,
              },
              html_url: deliveryPullRequestUrl,
            });
      return Response.json({ message: "not found" }, { status: 404 });
    },
  });
  mergifyServer = Bun.serve({
    port: mergifyPort,
    fetch: () =>
      deliveryQueued
        ? Response.json({
            number: 52,
            queued_at: new Date().toISOString(),
            position: 0,
            ci_state: "pending",
            state: "waiting_for_checks",
            checks: [{ name: "merge-group", state: "pending" }],
          })
        : Response.json(
            { error_code: "PULL_REQUEST_NOT_QUEUED", detail: "not queued" },
            { status: 404 },
          ),
  });
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPath = join(directory, "github-app.pem");
  const mergifyTokenPath = join(directory, "mergify-token");
  const kubernetesTokenPath = join(directory, "kubernetes-token");
  writeFileSync(
    privateKeyPath,
    privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  );
  writeFileSync(mergifyTokenPath, "local-mergify-token");
  writeFileSync(kubernetesTokenPath, "local-kubernetes-token");
  const runtimeEnvironment = {
    ANVIL_API_TOKEN: apiToken,
    ANVIL_DATABASE: join(directory, "configured.sqlite"),
    ANVIL_PROVIDER_MODE: "configured",
    ANVIL_RECONCILE_INTERVAL_MS: "250",
    ANVIL_SANDBOX_NAMESPACE: "configured-test",
    ANVIL_SANDBOX_IMAGE_DIGEST: `ghcr.io/example/sandbox@sha256:${"b".repeat(64)}`,
    ANVIL_WORKSPACE_SIZE: "10Gi",
    ANVIL_PROFILE_PVC: "profile-pvc",
    ANVIL_NIX_PVC: "nix-pvc",
    ANVIL_KUBERNETES_API_URL: `http://127.0.0.1:${sandboxPort}/`,
    ANVIL_KUBERNETES_TOKEN_FILE: kubernetesTokenPath,
    ANVIL_OPENCODE_URL_TEMPLATE: `http://127.0.0.1:${openCodePort}/{sandbox}/{namespace}/`,
    ANVIL_OPENCODE_MODEL_PROVIDER: "fixture-provider",
    ANVIL_OPENCODE_MODEL_ID: "fixture-model",
    ANVIL_GITHUB_APP_ID: "fixture-app",
    ANVIL_GITHUB_INSTALLATION_ID: "42",
    ANVIL_GITHUB_PRIVATE_KEY_FILE: privateKeyPath,
    ANVIL_GITHUB_API_URL: `http://127.0.0.1:${githubPort}/api/`,
    ANVIL_MERGIFY_TOKEN_FILE: mergifyTokenPath,
    ANVIL_MERGIFY_API_URL: `http://127.0.0.1:${mergifyPort}/v1/`,
    PORT: String(serverPort),
  };

  // Server startup happens after all local fixture services and secret files exist.
  daemonProcess = startDaemon(runtimeEnvironment);
  const baseUrl = `http://127.0.0.1:${serverPort}`;
  await waitUntilReady(baseUrl);
  const headers = {
    authorization: `Bearer ${apiToken}`,
    "content-type": "application/json",
  };
  const created = await fetch(`${baseUrl}/api/commissions`, {
    method: "POST",
    headers,
    body: JSON.stringify(
      proposalInput({
        id: "configured-commission",
        repository: "https://github.com/acme/demo",
      }),
    ),
  });
  expect(created.status).toBe(201);
  const admitted = await fetch(
    `${baseUrl}/api/commissions/configured-commission/admit`,
    { method: "POST", headers, body: "{}" },
  );
  expect(admitted.status).toBe(200);
  await waitForBootstrapOperations(baseUrl, "configured-commission");
  expect(provisionCount).toBe(1);
  expect(sessionCreateCount).toBe(1);
  expect(promptCount).toBe(1);
  expect(sessions.size).toBe(1);

  watchdogMode = true;
  loseNextInterruptAck = true;
  const configuredSandbox = [...sessions.keys()].find((name) =>
    name.startsWith("anvil-configured-commission-"),
  );
  if (configuredSandbox === undefined)
    throw new Error("Configured Session Sandbox fixture missing");
  const watchdogAdapter = new OpenCodeAdapter({
    baseUrl: `http://127.0.0.1:${openCodePort}/${encodeURIComponent(configuredSandbox)}/configured-test/`,
  });
  expect(
    await watchdogAdapter.observeExecution(
      sessions.get(configuredSandbox)!,
      Date.now(),
      { providerId: "fixture-provider", modelId: "fixture-model" },
    ),
  ).toMatchObject({
    kind: "running",
    contextPressure: true,
    safeBoundary: true,
    contextLimitTokens: 10_000,
  });
  for (
    let attempt = 0;
    attempt < 100 && openCodeEventSubscribers.size === 0;
    attempt += 1
  )
    await Bun.sleep(10);
  expect(openCodeEventSubscribers.size).toBeGreaterThan(0);
  const watchdogSessionId = sessions.get(configuredSandbox);
  if (watchdogSessionId === undefined)
    throw new Error("Configured watchdog Session identity missing");
  const watchdogEvents = [
    { type: "session.tool.failed", sessionID: "foreign-session" },
    { type: "session.execution.started", sessionID: watchdogSessionId },
    { type: "session.tool.failed", sessionID: watchdogSessionId },
    { type: "session.tool.failed", sessionID: watchdogSessionId },
  ];
  for (const subscriber of openCodeEventSubscribers)
    subscriber.enqueue(
      new TextEncoder().encode(
        `${watchdogEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}`,
      ),
    );
  const watchdogOperations = await waitForOperationKind(
    baseUrl,
    "configured-commission",
    "interrupt",
    "ambiguous",
  );
  expect(promptCount).toBe(1);
  expect(interruptCount).toBe(1);
  expect(
    watchdogOperations.find(({ kind }) => kind === "interrupt")?.outcome,
  ).toMatchObject({ kind: "ambiguous" });

  daemonProcess.kill("SIGTERM");
  await daemonProcess.exited;
  daemonProcess = undefined;
  interruptInspectionBusy = false;
  daemonProcess = startDaemon(runtimeEnvironment);
  await waitUntilReady(baseUrl);
  const recoveredWatchdog = await waitForOperationKind(
    baseUrl,
    "configured-commission",
    "refresh_context",
  );
  expect(promptCount).toBe(2);
  expect(
    recoveredWatchdog.find(({ kind }) => kind === "refresh_context")?.directive,
  ).toContain("Assignment: configured-commission:assignment-1");
  expect(interruptCount).toBe(1);
  await Bun.sleep(100);
  expect(provisionCount).toBe(1);
  expect(sessionCreateCount).toBe(1);
  expect(promptCount).toBe(2);
  expect(interruptCount).toBe(1);
  const operations = await fetch(
    `${baseUrl}/api/commissions/configured-commission/operations`,
    { headers },
  ).then((response) => response.json());
  const persistedOperations = (
    operations as {
      operations: readonly {
        kind: string;
        directive: string;
        outcome: { kind: string; result?: string };
      }[];
    }
  ).operations;
  expect(
    persistedOperations.find(({ kind }) => kind === "interrupt")?.outcome,
  ).toMatchObject({ kind: "observed", result: "applied" });
  expect(
    persistedOperations.find(({ kind }) => kind === "refresh_context")
      ?.directive,
  ).toContain("Campaign: campaign-1");
  expect(
    persistedOperations.filter(
      ({ kind }) => kind === "interrupt" || kind === "refresh_context",
    ),
  ).toHaveLength(2);

  const stuckId = "configured-stuck-watchdog";
  const stuckCreated = await fetch(`${baseUrl}/api/commissions`, {
    method: "POST",
    headers,
    body: JSON.stringify(
      proposalInput({
        id: stuckId,
        repository: "https://github.com/acme/demo",
        budget: { ...proposalInput().budget, maxAttempts: 1 },
      }),
    ),
  });
  expect(stuckCreated.status).toBe(201);
  const stuckAdmitted = await fetch(
    `${baseUrl}/api/commissions/${stuckId}/admit`,
    {
      method: "POST",
      headers,
      body: "{}",
    },
  );
  expect(stuckAdmitted.status).toBe(200);
  await waitForBootstrapOperations(baseUrl, stuckId);
  const stuckSandbox = [...sessions.keys()].find((name) =>
    name.startsWith("anvil-configured-stuck-watchdog-"),
  );
  if (stuckSandbox === undefined)
    throw new Error("Stuck-turn Sandbox fixture missing");
  const stuckSessionId = sessions.get(stuckSandbox);
  if (stuckSessionId === undefined)
    throw new Error("Stuck-turn Session fixture missing");
  for (
    let attempt = 0;
    attempt < 100 && openCodeEventSubscribers.size < 2;
    attempt += 1
  )
    await Bun.sleep(10);
  expect(openCodeEventSubscribers.size).toBeGreaterThanOrEqual(2);
  watchdogTokenInput = 1_000;
  watchdogProgressAt = Date.now() - 10 * 60_000;
  watchdogMode = true;
  for (const subscriber of openCodeEventSubscribers)
    subscriber.enqueue(
      new TextEncoder().encode(
        `data: ${JSON.stringify({ type: "session.step.ended", sessionID: stuckSessionId })}\n\n`,
      ),
    );
  const stuckOperations = await waitForOperationKind(
    baseUrl,
    stuckId,
    "interrupt",
    "observed",
  );
  expect(
    stuckOperations.find(({ kind }) => kind === "interrupt")?.directive,
  ).toContain("stuck-active-turn");
  expect(interruptCount).toBe(2);
  expect(promptCount).toBe(3);
  const exhausted = await fetch(
    `${baseUrl}/api/commissions/${stuckId}/reconcile`,
    {
      method: "POST",
      headers,
      body: "{}",
    },
  ).then((response) => response.json());
  expect(exhausted).toMatchObject({
    decision: { kind: "hold", reason: "budget_exhausted" },
  });

  daemonProcess.kill("SIGTERM");
  await daemonProcess.exited;
  daemonProcess = undefined;
  daemonProcess = startDaemon(runtimeEnvironment);
  await waitUntilReady(baseUrl);
  await Bun.sleep(100);
  expect(provisionCount).toBe(2);
  expect(sessionCreateCount).toBe(2);
  expect(promptCount).toBe(3);
  expect(interruptCount).toBe(2);

  const deliveryId = "configured-delivery";
  const deliveryCreated = await fetch(`${baseUrl}/api/commissions`, {
    method: "POST",
    headers,
    body: JSON.stringify(
      proposalInput({
        id: deliveryId,
        repository: "https://github.com/acme/demo",
        integrationTarget: "main",
        budget: { ...proposalInput().budget, maxAttempts: 1 },
      }),
    ),
  });
  expect(deliveryCreated.status).toBe(201);
  const deliveryAdmitted = await fetch(
    `${baseUrl}/api/commissions/${deliveryId}/admit`,
    { method: "POST", headers, body: "{}" },
  );
  expect(deliveryAdmitted.status).toBe(200);
  await waitForBootstrapOperations(baseUrl, deliveryId);
  const afterRepair = await waitForOperationKind(baseUrl, deliveryId, "repair");
  const afterStaleEvidence = await waitForOperationCount(
    baseUrl,
    deliveryId,
    "continue",
    2,
  );
  expect(deliveryPromptCount).toBe(3);
  expect(String(deliveryRevision)).toBe("worker-commit-3");
  expect(
    afterStaleEvidence
      .filter(({ kind }) => kind === "continue")
      .map(({ candidateRevision }) => candidateRevision),
  ).toEqual([null, "worker-commit-2"]);
  expect(
    afterRepair.find(({ kind }) => kind === "repair")?.directive,
  ).toContain("ci / required");

  // Stale SHA success must not substitute for the required check on the new Candidate.
  staleDeliveryChecks = true;
  const staleCheck = await fetch(
    `${baseUrl}/api/commissions/${deliveryId}/reconcile`,
    {
      method: "POST",
      headers,
      body: "{}",
    },
  ).then((response) => response.json());
  expect(staleCheck).toMatchObject({
    decision: {
      kind: "wait",
      reason:
        "required status checks have not been reported for this Candidate",
    },
  });
  staleDeliveryChecks = false;
  const pendingCheck = await fetch(
    `${baseUrl}/api/commissions/${deliveryId}/reconcile`,
    { method: "POST", headers, body: "{}" },
  ).then((response) => response.json());
  expect(pendingCheck).toMatchObject({
    decision: { kind: "wait", reason: "required CI check is pending" },
  });

  // Reopen SQLite in a new daemon process while required CI remains pending.
  daemonProcess.kill("SIGTERM");
  await daemonProcess.exited;
  daemonProcess = undefined;
  daemonProcess = startDaemon(runtimeEnvironment);
  await waitUntilReady(baseUrl);
  const pendingAfterRestart = await fetch(
    `${baseUrl}/api/commissions/${deliveryId}/reconcile`,
    { method: "POST", headers, body: "{}" },
  ).then((response) => response.json());
  expect(pendingAfterRestart).toMatchObject({
    decision: { kind: "wait", reason: "required CI check is pending" },
  });
  expect(deliveryPromptCount).toBe(3);
  expect(deliveryPullRequestCreates).toBe(0);

  // CI advances independently; the daemon observes success and creates one PR.
  deliveryCheckState = "passing";
  let deliveryOperations: readonly {
    kind: string;
    candidateRevision: string | null;
    outcome: {
      kind: string;
      result?: string;
      externalIdentity?: string | null;
    };
  }[] = [];
  let integrateObserved = false;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const response = await fetch(
      `${baseUrl}/api/commissions/${deliveryId}/operations`,
      { headers },
    );
    if (response.ok) {
      deliveryOperations = (
        (await response.json()) as {
          operations: typeof deliveryOperations;
        }
      ).operations;
      integrateObserved = deliveryOperations.some(
        (operation) =>
          operation.kind === "integrate" &&
          operation.outcome.kind === "observed" &&
          operation.outcome.result === "accepted",
      );
      if (integrateObserved) break;
    }
    await Bun.sleep(25);
  }
  expect(integrateObserved).toBe(true);
  expect(deliveryPullRequestCreates).toBe(1);
  expect(deliveryPromptCount).toBe(3);
  expect(
    deliveryOperations.filter(({ kind }) => kind === "continue"),
  ).toHaveLength(2);
  expect(
    deliveryOperations.filter(({ kind }) => kind === "repair"),
  ).toHaveLength(1);
  expect(
    deliveryOperations.filter(({ kind }) => kind === "integrate"),
  ).toHaveLength(1);
  expect(deliveryPullRequest).toMatchObject({
    number: 52,
    html_url: "https://github.com/acme/demo/pull/52",
    head: { ref: deliveryBranchName, sha: "worker-commit-3" },
    base: { ref: "main" },
  });
  const integrateOperation = deliveryOperations.find(
    ({ kind }) => kind === "integrate",
  );
  expect(integrateOperation).toMatchObject({
    candidateRevision: "worker-commit-3",
    outcome: {
      kind: "observed",
      result: "accepted",
      externalIdentity: "https://github.com/acme/demo/pull/52",
    },
  });

  const queueWait = await fetch(
    `${baseUrl}/api/commissions/${deliveryId}/reconcile`,
    { method: "POST", headers, body: "{}" },
  ).then((response) => response.json());
  expect(queueWait).toMatchObject({
    decision: { kind: "wait", wake: { kind: "merge_queue" } },
  });

  // A different PR identity with the same Candidate SHA cannot conclude.
  deliveryPullRequestUrl = "https://github.com/acme/demo/pull/999";
  const foreignPullRequest = await fetch(
    `${baseUrl}/api/commissions/${deliveryId}/reconcile`,
    { method: "POST", headers, body: "{}" },
  ).then((response) => response.json());
  expect(foreignPullRequest).toMatchObject({
    decision: { kind: "escalate" },
  });
  expect(foreignPullRequest).not.toMatchObject({
    commission: { lifecycle: "concluded" },
  });

  // The registered PR with the wrong head SHA also cannot conclude.
  deliveryPullRequestUrl = "https://github.com/acme/demo/pull/52";
  deliveryPullRequestHeadSha = "worker-commit-1";
  const staleHead = await fetch(
    `${baseUrl}/api/commissions/${deliveryId}/reconcile`,
    { method: "POST", headers, body: "{}" },
  ).then((response) => response.json());
  expect(staleHead).not.toMatchObject({
    commission: { lifecycle: "concluded" },
  });
  deliveryPullRequestHeadSha = null;
  deliveryMerged = true;
  const delivered = await waitForLifecycle(baseUrl, deliveryId, "concluded");
  expect(delivered["deliveryEvidence"]).toMatchObject({
    revision: "worker-commit-3",
    repository: "https://github.com/acme/demo",
    integrationTarget: "main",
    providerIdentity: "https://github.com/acme/demo/pull/52",
  });
  expect(deliveryPullRequestCreates).toBe(1);
  expect(deliveryPromptCount).toBe(3);
  expect(
    afterStaleEvidence.filter(({ kind }) => kind === "repair"),
  ).toHaveLength(1);

  const ambiguousId = "configured-ambiguous-session";
  loseNextSessionCreateAck = true;
  const ambiguousCreated = await fetch(`${baseUrl}/api/commissions`, {
    method: "POST",
    headers,
    body: JSON.stringify(
      proposalInput({
        id: ambiguousId,
        repository: "https://github.com/acme/demo",
      }),
    ),
  });
  expect(ambiguousCreated.status).toBe(201);
  const ambiguousAdmitted = await fetch(
    `${baseUrl}/api/commissions/${ambiguousId}/admit`,
    { method: "POST", headers, body: "{}" },
  );
  expect(ambiguousAdmitted.status).toBe(200);
  await waitForAmbiguousSessionCreate(baseUrl, ambiguousId);
  expect(provisionCount).toBe(4);
  expect(sessionCreateCount).toBe(4);
  expect(promptCount).toBe(6);
  expect(interruptCount).toBe(2);

  daemonProcess.kill("SIGTERM");
  await daemonProcess.exited;
  daemonProcess = undefined;
  daemonProcess = startDaemon(runtimeEnvironment);
  await waitUntilReady(baseUrl);
  await Bun.sleep(100);
  expect(provisionCount).toBe(4);
  expect(sessionCreateCount).toBe(4);
  expect(promptCount).toBe(6);
  const unresolved = await fetch(
    `${baseUrl}/api/commissions/${ambiguousId}/operations`,
    { headers },
  ).then((response) => response.json());
  expect(unresolved).toMatchObject({
    operations: [
      { kind: "provision_sandbox", outcome: { kind: "observed" } },
      { kind: "create_session", outcome: { kind: "ambiguous" } },
    ],
  });
}, 45_000);
