import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeAdapter } from "../src/providers/opencode";
import { WorkerGitCapabilitySigner } from "../src/providers/git-credentials";
import { workBranchFor } from "../src/providers/runtime";
import { proposalInput } from "./support/fixtures";
import { LeaseApiFixture, leaseToken } from "./support/lease-api";

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
let gitReceiverServer: ReturnType<typeof Bun.serve> | undefined;
let mergifyServer: ReturnType<typeof Bun.serve> | undefined;
let leaseApi: LeaseApiFixture | undefined;
let provisionCount = 0;
let sessionCreateCount = 0;
let promptCount = 0;
const gitCapabilitySecret = "local-git-capability-signing-secret-32-bytes";

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
    gitReceiverServer,
    mergifyServer,
  ])
    server?.stop(true);
  sandboxServer = undefined;
  openCodeServer = undefined;
  githubServer = undefined;
  gitReceiverServer = undefined;
  mergifyServer = undefined;
  expect(leaseApi?.errors ?? []).toHaveLength(0);
  leaseApi?.close();
  leaseApi = undefined;
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

function git(arguments_: readonly string[], cwd?: string) {
  const result = Bun.spawnSync(["git", ...arguments_], {
    ...(cwd === undefined ? {} : { cwd }),
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString(),
  };
}

async function gitProcess(
  arguments_: readonly string[],
  environment: Record<string, string>,
) {
  const child = Bun.spawn(["git", ...arguments_], {
    cwd: process.cwd(),
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout: stdout.trim(), stderr };
}

async function serveGitBackend(
  request: Request,
  projectRoot: string,
  allowedRef: string,
  authorization: string,
): Promise<Response> {
  if (request.headers.get("authorization") !== authorization)
    return new Response(null, {
      status: 401,
      headers: { "www-authenticate": 'Basic realm="Anvil local Git fixture"' },
    });
  const url = new URL(request.url);
  const body = new Uint8Array(await request.arrayBuffer());
  const child = Bun.spawn(["git", "http-backend"], {
    env: {
      ...process.env,
      GIT_HTTP_EXPORT_ALL: "1",
      GIT_PROJECT_ROOT: projectRoot,
      PATH_INFO: url.pathname.slice("/git".length),
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: request.method,
      REQUEST_URI: `${url.pathname}${url.search}`,
      SERVER_PROTOCOL: "HTTP/1.1",
      SERVER_NAME: url.hostname,
      SERVER_PORT: url.port,
      REMOTE_ADDR: "127.0.0.1",
      REMOTE_USER: "x-access-token",
      HTTP_AUTHORIZATION: authorization,
      ANVIL_ALLOWED_GIT_REF: allowedRef,
      ...(request.headers.get("content-type") === null
        ? {}
        : { CONTENT_TYPE: request.headers.get("content-type")! }),
      CONTENT_LENGTH: String(body.byteLength),
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (body.byteLength > 0) child.stdin.write(body);
  child.stdin.end();
  const [exitCode, output] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
  ]);
  if (exitCode !== 0) return new Response(null, { status: 500 });
  const bytes = new Uint8Array(output);
  const delimiter = new Uint8Array([13, 10, 13, 10]);
  let split = -1;
  for (let index = 0; index <= bytes.length - delimiter.length; index += 1)
    if (delimiter.every((byte, offset) => bytes[index + offset] === byte)) {
      split = index;
      break;
    }
  if (split < 0) return new Response(null, { status: 500 });
  const headers = new Headers();
  let status = 200;
  for (const line of new TextDecoder()
    .decode(bytes.subarray(0, split))
    .split("\r\n")) {
    if (line.startsWith("Status:")) {
      status = Number(line.slice(7).trim().split(" ")[0]);
    } else {
      const colon = line.indexOf(":");
      if (colon > 0)
        headers.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    }
  }
  return new Response(bytes.subarray(split + delimiter.length), {
    status,
    headers,
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
  const deliveryRevisions: string[] = [];
  let deliveryBareRepository: string | null = null;
  let deliveryPushEnvironment: Record<string, string> | null = null;
  let deliveryPushArguments: readonly string[] | null = null;
  let deliveryWorkerRepository: string | null = null;
  let deliveryCapabilityReady: (() => void) | undefined;
  const deliveryCapabilityGate = new Promise<void>((resolve) => {
    deliveryCapabilityReady = resolve;
  });
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
          if (deliveryPromptCount === 1) {
            await deliveryCapabilityGate;
            if (
              deliveryWorkerRepository === null ||
              deliveryPushEnvironment === null ||
              deliveryBranchName === null
            )
              throw new Error("Delivery Git fixture was not bootstrapped");
          }
          const commit = Bun.spawnSync(
            [
              "git",
              "-C",
              deliveryWorkerRepository!,
              "commit",
              "--allow-empty",
              "-m",
              `publish Candidate ${deliveryPromptCount}`,
            ],
            { stdout: "pipe", stderr: "pipe" },
          );
          if (commit.exitCode !== 0) throw new Error(commit.stderr.toString());
          deliveryRevision = Bun.spawnSync(
            ["git", "-C", deliveryWorkerRepository!, "rev-parse", "HEAD"],
            { stdout: "pipe", stderr: "pipe" },
          )
            .stdout.toString()
            .trim();
          deliveryRevisions.push(deliveryRevision);
          const credentials = Bun.spawn(
            ["git", "-C", deliveryWorkerRepository!, "credential", "fill"],
            {
              env: { ...process.env, ...deliveryPushEnvironment! },
              stdin: "pipe",
              stdout: "pipe",
              stderr: "pipe",
            },
          );
          credentials.stdin.write(
            `protocol=http\nhost=127.0.0.1:${gitReceiverServer!.port}\npath=git/acme/demo.git\n\n`,
          );
          credentials.stdin.end();
          const [credentialExit, credentialText, credentialError] =
            await Promise.all([
              credentials.exited,
              new Response(credentials.stdout).text(),
              new Response(credentials.stderr).text(),
            ]);
          if (credentialExit !== 0)
            throw new Error(
              `Fixture credential fill failed: ${credentialError}`,
            );
          if (!credentialText.includes("password=ghs_write"))
            throw new Error(
              "Fixture helper did not return the scoped Git credential",
            );
          if (deliveryPushArguments === null)
            throw new Error("Delivery Git push command was not configured");
          const push = await gitProcess(deliveryPushArguments, {
            ...(process.env as Record<string, string>),
            ...deliveryPushEnvironment!,
          });
          if (push.exitCode !== 0)
            throw new Error(`Candidate push failed: ${push.stderr}`);
          const receiverRevision = git([
            "--git-dir",
            deliveryBareRepository!,
            "rev-parse",
            `refs/heads/${deliveryBranchName}`,
          ]).stdout;
          if (receiverRevision !== deliveryRevision)
            throw new Error("Pushed Candidate does not match the bare Git ref");
          const reportedRevision =
            deliveryPromptCount === 2
              ? deliveryRevisions[0]!
              : deliveryRevision;
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
            token: `ghs_${body.permissions["contents"]}`,
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
          deliveryBareRepository !== null
        ) {
          deliveryBranchName = branch;
          const observed = Bun.spawnSync(
            [
              "git",
              "--git-dir",
              deliveryBareRepository,
              "rev-parse",
              `refs/heads/${branch}`,
            ],
            { stdout: "pipe", stderr: "pipe" },
          );
          if (observed.exitCode !== 0)
            return Response.json(
              { message: "branch not found" },
              { status: 404 },
            );
          deliveryRevision = observed.stdout.toString().trim();
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
  const gitCapabilitySecretPath = join(directory, "git-capability-secret");
  const mergifyTokenPath = join(directory, "mergify-token");
  const kubernetesTokenPath = join(directory, "kubernetes-token");
  writeFileSync(
    privateKeyPath,
    privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  );
  writeFileSync(gitCapabilitySecretPath, gitCapabilitySecret);
  writeFileSync(mergifyTokenPath, "local-mergify-token");
  writeFileSync(kubernetesTokenPath, "local-kubernetes-token");
  const leaseTokenPath = join(directory, "lease-token");
  writeFileSync(leaseTokenPath, leaseToken, { mode: 0o600 });
  leaseApi = new LeaseApiFixture(Date.now);
  await leaseApi.ready;
  const runtimeEnvironment = {
    ANVIL_API_TOKEN: apiToken,
    ANVIL_DATABASE: join(directory, "configured.sqlite"),
    ANVIL_PROVIDER_MODE: "configured",
    ANVIL_CONTROLLER_ID: "configured-process-fixture",
    ANVIL_LEASE_NAMESPACE: "configured-leases",
    ANVIL_LEASE_API_URL: leaseApi.url,
    ANVIL_LEASE_TOKEN_FILE: leaseTokenPath,
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
    ANVIL_GIT_CAPABILITY_SECRET_FILE: gitCapabilitySecretPath,
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
  // Hold the first worker prompt until its persisted Assignment, Workspace and
  // Session identities have been observed and a short-lived helper capability
  // has been installed as a 0600 fixture file.
  let deliveryBootstrapOperations: readonly {
    kind: string;
    assignmentId: string | null;
    attemptId: string | null;
    outcome: {
      kind: string;
      result?: string;
      externalIdentity?: string | null;
    };
  }[] = [];
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const response = await fetch(
      `${baseUrl}/api/commissions/${deliveryId}/operations`,
      { headers },
    );
    if (response.ok) {
      deliveryBootstrapOperations = (
        (await response.json()) as {
          operations: typeof deliveryBootstrapOperations;
        }
      ).operations;
      if (
        deliveryBootstrapOperations.some(
          (item) =>
            item.kind === "provision_sandbox" &&
            item.outcome.kind === "observed",
        ) &&
        deliveryBootstrapOperations.some(
          (item) =>
            item.kind === "create_session" && item.outcome.kind === "observed",
        )
      )
        break;
    }
    await Bun.sleep(25);
  }
  const workspaceOperation = deliveryBootstrapOperations.find(
    (item) => item.kind === "provision_sandbox",
  );
  const sessionOperation = deliveryBootstrapOperations.find(
    (item) => item.kind === "create_session",
  );
  if (
    workspaceOperation?.outcome.externalIdentity == null ||
    sessionOperation?.outcome.externalIdentity == null ||
    sessionOperation.assignmentId === null ||
    sessionOperation.attemptId === null
  )
    throw new Error(
      "Delivery Workspace and Session operations were not persisted",
    );
  const deliveryResponse = await fetch(
    `${baseUrl}/api/commissions/${deliveryId}`,
    { headers },
  );
  const deliveryCommission = (
    (await deliveryResponse.json()) as {
      commission: import("../src/domain").Commission;
    }
  ).commission;
  deliveryBranchName = workBranchFor(deliveryCommission);
  const deliveryTargetRef = `refs/heads/${deliveryBranchName}`;
  const capabilityFile = join(directory, "delivery-git-capability");
  const deliveryCapability = new WorkerGitCapabilitySigner(
    gitCapabilitySecret,
    300,
  ).mint(
    {
      commissionId: deliveryId,
      assignmentId: sessionOperation.assignmentId,
      attemptId: sessionOperation.attemptId,
      sessionId: sessionOperation.outcome.externalIdentity,
      workspaceId: workspaceOperation.outcome.externalIdentity,
      repository: "acme/demo",
      targetRef: deliveryTargetRef,
      controllerId: deliveryCommission.owner!.controllerId,
      ownerEpoch: deliveryCommission.owner?.epoch ?? 1,
    },
    Date.now(),
    300,
  );
  writeFileSync(capabilityFile, deliveryCapability, { mode: 0o600 });
  chmodSync(capabilityFile, 0o600);
  const projectRoot = join(directory, "delivery-github");
  deliveryBareRepository = join(projectRoot, "acme", "demo.git");
  mkdirSync(join(projectRoot, "acme"), { recursive: true });
  const initBare = git(["init", "--bare", deliveryBareRepository]);
  if (initBare.exitCode !== 0) throw new Error(initBare.stderr);
  git([
    "--git-dir",
    deliveryBareRepository,
    "config",
    "http.receivepack",
    "true",
  ]);
  const hook = join(deliveryBareRepository, "hooks", "pre-receive");
  writeFileSync(
    hook,
    '#!/bin/sh\nwhile read old_sha new_sha ref; do\n  [ "$ref" = "$ANVIL_ALLOWED_GIT_REF" ] || exit 1\ndone\n',
  );
  chmodSync(hook, 0o755);
  const expectedGitAuthorization = `Basic ${Buffer.from("x-access-token:ghs_write").toString("base64")}`;
  gitReceiverServer = Bun.serve({
    port: 0,
    fetch: (request) =>
      serveGitBackend(
        request,
        projectRoot,
        deliveryTargetRef,
        expectedGitAuthorization,
      ),
  });
  deliveryWorkerRepository = join(directory, "delivery-worker");
  const initWorker = git(["init", deliveryWorkerRepository]);
  if (initWorker.exitCode !== 0) throw new Error(initWorker.stderr);
  for (const args of [
    ["-C", deliveryWorkerRepository, "config", "user.name", "Local Worker"],
    [
      "-C",
      deliveryWorkerRepository,
      "config",
      "user.email",
      "worker@example.test",
    ],
    ["-C", deliveryWorkerRepository, "switch", "-c", deliveryBranchName],
  ]) {
    const result = git(args);
    if (result.exitCode !== 0) throw new Error(result.stderr);
  }
  writeFileSync(
    join(deliveryWorkerRepository, "delivery.txt"),
    "first real Candidate\n",
  );
  git(["-C", deliveryWorkerRepository, "add", "delivery.txt"]);
  const firstCommit = git([
    "-C",
    deliveryWorkerRepository,
    "commit",
    "-m",
    "create first Candidate",
  ]);
  if (firstCommit.exitCode !== 0) throw new Error(firstCommit.stderr);
  const localRemote = `http://127.0.0.1:${gitReceiverServer.port}/git/acme/demo.git`;
  git(["-C", deliveryWorkerRepository, "remote", "add", "origin", localRemote]);
  const helperPath = join(process.cwd(), "src/providers/git-credentials.ts");
  git([
    "-C",
    deliveryWorkerRepository,
    "config",
    "credential.helper",
    `!${process.execPath} run ${helperPath}`,
  ]);
  git([
    "-C",
    deliveryWorkerRepository,
    "config",
    "credential.useHttpPath",
    "true",
  ]);
  deliveryPushEnvironment = {
    ANVIL_GIT_CREDENTIAL_URL: `${baseUrl}/v1/git/credentials`,
    ANVIL_GIT_CAPABILITY_FILE: capabilityFile,
    ANVIL_GIT_TARGET_REF: deliveryTargetRef,
    ANVIL_GIT_FIXTURE_REPOSITORY_URL: "https://github.com/acme/demo",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const absentCapabilityFile = join(directory, "absent-capability");
  deliveryPushEnvironment["ANVIL_GIT_CAPABILITY_FILE"] = absentCapabilityFile;
  deliveryPushArguments = [
    "-C",
    deliveryWorkerRepository,
    "push",
    "origin",
    `HEAD:${deliveryTargetRef}`,
  ];
  const deniedPush = await gitProcess(deliveryPushArguments, {
    ...(process.env as Record<string, string>),
    ...deliveryPushEnvironment,
  });
  expect(deniedPush.exitCode).not.toBe(0);
  expect(deniedPush.stderr).toContain("ENOENT");
  expect(deniedPush.stderr).toContain(absentCapabilityFile);
  const absentCandidate = git([
    "--git-dir",
    deliveryBareRepository,
    "rev-parse",
    deliveryTargetRef,
  ]);
  expect(absentCandidate.exitCode).not.toBe(0);
  const absentBranchObservation = await fetch(
    `http://127.0.0.1:${githubPort}/api/repos/acme/demo/branches/${encodeURIComponent(deliveryBranchName)}`,
  );
  expect(absentBranchObservation.status).toBe(404);
  deliveryPushEnvironment["ANVIL_GIT_CAPABILITY_FILE"] = capabilityFile;
  deliveryCapabilityReady?.();
  await waitForBootstrapOperations(baseUrl, deliveryId);
  const afterRepair = await waitForOperationKind(baseUrl, deliveryId, "repair");
  const afterStaleEvidence = await waitForOperationCount(
    baseUrl,
    deliveryId,
    "continue",
    2,
  );
  expect(deliveryPromptCount).toBe(3);
  expect(deliveryRevisions).toHaveLength(3);
  expect(String(deliveryRevision)).toBe(deliveryRevisions[2]!);
  expect(
    afterStaleEvidence
      .filter(({ kind }) => kind === "continue")
      .map(({ candidateRevision }) => candidateRevision),
  ).toEqual([null as string | null, deliveryRevisions[1]!]);
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
    head: { ref: deliveryBranchName, sha: deliveryRevisions[2] },
    base: { ref: "main" },
  });
  const integrateOperation = deliveryOperations.find(
    ({ kind }) => kind === "integrate",
  );
  expect(integrateOperation).toMatchObject({
    candidateRevision: deliveryRevisions[2],
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
  deliveryPullRequestHeadSha = deliveryRevisions[0]!;
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
    revision: deliveryRevisions[2],
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
  expect(leaseApi.calls.filter((call) => call.method === "POST")).toHaveLength(
    4,
  );
  expect(
    leaseApi.calls.filter((call) => call.method === "PUT").length,
  ).toBeGreaterThan(4);
  expect(
    leaseApi.get(ambiguousId, "configured-leases").spec.leaseTransitions,
  ).toBeGreaterThan(1);
  expect(
    new Set(
      leaseApi.calls.flatMap((call) =>
        call.body?.spec.holderIdentity ? [call.body.spec.holderIdentity] : [],
      ),
    ).size,
  ).toBeGreaterThan(1);
}, 45_000);
