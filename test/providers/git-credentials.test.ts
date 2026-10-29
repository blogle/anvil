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
import {
  ApplicationService,
  type WorkerGitCapabilityScope,
} from "../../src/application";
import { createDaemonApp } from "../../src/daemon";
import { GitHubAppBroker } from "../../src/providers/github-app";
import {
  WorkerGitCapabilitySigner,
  WorkerGitCredentialService,
} from "../../src/providers/git-credentials";
import { workBranchFor } from "../../src/providers/runtime";
import { CommissionStore } from "../../src/persistence/sqlite";
import { FakeWorld } from "../support/fake-world";
import { epoch, policy, proposalInput } from "../support/fixtures";

const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = keyPair.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
const signingSecret = "test-worker-capability-signing-secret-32-bytes";
let directory: string | undefined;
let githubServer: ReturnType<typeof Bun.serve> | undefined;
let apiServer: ReturnType<typeof Bun.serve> | undefined;
let gitReceiverServer: ReturnType<typeof Bun.serve> | undefined;
let store: CommissionStore | undefined;

afterEach(() => {
  apiServer?.stop(true);
  apiServer = undefined;
  gitReceiverServer?.stop(true);
  gitReceiverServer = undefined;
  githubServer?.stop(true);
  githubServer = undefined;
  store?.close();
  store = undefined;
  if (directory !== undefined)
    rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function runGitCredentialFill(
  helperPath: string,
  capabilityFile: string,
  credentialUrl: string,
  targetRef: string,
  repositoryPath = "acme/demo.git",
  fixtureRepositoryUrl?: string,
) {
  const environment = {
    ...process.env,
    ANVIL_GIT_CREDENTIAL_URL: credentialUrl,
    ANVIL_GIT_CAPABILITY_FILE: capabilityFile,
    ANVIL_GIT_TARGET_REF: targetRef,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    ...(fixtureRepositoryUrl === undefined
      ? {}
      : { ANVIL_GIT_FIXTURE_REPOSITORY_URL: fixtureRepositoryUrl }),
  };
  const child = Bun.spawn(
    [
      "git",
      "-c",
      `credential.helper=!${process.execPath} run ${helperPath}`,
      "-c",
      "credential.useHttpPath=true",
      "credential",
      "fill",
    ],
    {
      env: environment,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  child.stdin.write(
    `protocol=https\nhost=github.com\npath=${repositoryPath}\n\n`,
  );
  child.stdin.end();
  return Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
}

function runGit(
  arguments_: readonly string[],
  cwd?: string,
  environment: Record<string, string> = {},
): string {
  const result = Bun.spawnSync(["git", ...arguments_], {
    ...(cwd === undefined ? {} : { cwd }),
    env: {
      ...(process.env as Record<string, string>),
      GIT_CONFIG_NOSYSTEM: "1",
      ...environment,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(`git ${arguments_.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function runGitResult(
  arguments_: readonly string[],
  cwd: string,
  environment: Record<string, string>,
) {
  const result = Bun.spawnSync(["git", ...arguments_], {
    cwd,
    env: {
      ...(process.env as Record<string, string>),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      ...environment,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

async function serveGitHttpBackend(
  request: Request,
  options: Readonly<{
    projectRoot: string;
    allowedRef: string;
    expectedToken: string;
  }>,
): Promise<Response> {
  const expectedAuthorization = `Basic ${Buffer.from(
    `x-access-token:${options.expectedToken}`,
  ).toString("base64")}`;
  if (request.headers.get("authorization") !== expectedAuthorization)
    return new Response(null, {
      status: 401,
      headers: { "www-authenticate": 'Basic realm="Anvil Git fixture"' },
    });
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/git/"))
    return Response.json({ error: "not_found" }, { status: 404 });
  const body = new Uint8Array(await request.arrayBuffer());
  const child = Bun.spawn(["git", "http-backend"], {
    env: {
      ...(process.env as Record<string, string>),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_HTTP_EXPORT_ALL: "1",
      GIT_PROJECT_ROOT: options.projectRoot,
      PATH_INFO: url.pathname.slice("/git".length),
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: request.method,
      REQUEST_URI: `${url.pathname}${url.search}`,
      SERVER_PROTOCOL: "HTTP/1.1",
      SERVER_NAME: url.hostname,
      SERVER_PORT: url.port,
      REMOTE_ADDR: "127.0.0.1",
      REMOTE_USER: "x-access-token",
      HTTP_AUTHORIZATION: expectedAuthorization,
      ANVIL_ALLOWED_GIT_REF: options.allowedRef,
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
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
  ]);
  if (exitCode !== 0) return Response.json({ error: "git_backend_failed" }, { status: 500 });
  const output = new Uint8Array(stdout);
  const delimiter = new Uint8Array([13, 10, 13, 10]);
  let split = -1;
  for (let index = 0; index <= output.length - delimiter.length; index += 1) {
    if (delimiter.every((byte, offset) => output[index + offset] === byte)) {
      split = index;
      break;
    }
  }
  if (split < 0) return Response.json({ error: "invalid_cgi_response" }, { status: 500 });
  const headerText = new TextDecoder().decode(output.subarray(0, split));
  const headers = new Headers();
  let status = 200;
  for (const line of headerText.split("\r\n")) {
    if (line.startsWith("Status:")) {
      status = Number(line.slice("Status:".length).trim().split(" ")[0]);
      continue;
    }
    const colon = line.indexOf(":");
    if (colon > 0) headers.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return new Response(output.subarray(split + delimiter.length), { status, headers });
}

test("Git helper pushes a protected local ref through Assignment authority and rejects scope, expiry and restart adversaries", async () => {
  directory = mkdtempSync(join(tmpdir(), "anvil-git-credential-"));
  const dbPath = join(directory, "state.sqlite");
  store = new CommissionStore(dbPath);
  const world = new FakeWorld();
  let application = new ApplicationService(
    store,
    world,
    world,
    world,
    "controller-1",
    { ...policy, runtimeProvisioning: true },
  );
  const commissionId = "git-capability-commission";
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
  await application.reconcile(commissionId, epoch + 1);
  await application.reconcile(commissionId, epoch + 2);
  const commission = store.get(commissionId);
  if (commission === null) throw new Error("Commission disappeared");
  const operations = store.operations(commissionId);
  const workspace = operations.find(({ kind }) => kind === "provision_sandbox");
  const session = operations.find(({ kind }) => kind === "create_session");
  if (
    workspace?.outcome.kind !== "observed" ||
    session?.outcome.kind !== "observed" ||
    workspace.outcome.externalIdentity === null ||
    session.outcome.externalIdentity === null
  )
    throw new Error(
      "Sandbox and OpenCode Session Operations were not observed",
    );
  let clock = epoch + 3;
  const targetRef = `refs/heads/${workBranchFor(commission)}`;
  const scope = {
    commissionId,
    assignmentId: session.assignmentId,
    attemptId: session.attemptId,
    sessionId: session.outcome.externalIdentity,
    workspaceId: workspace.outcome.externalIdentity,
    repository: "acme/demo",
    targetRef,
    controllerId: "controller-1",
    ownerEpoch: 1,
  } as const;
  const signer = new WorkerGitCapabilitySigner(signingSecret, 300);
  const capabilityFile = join(directory, "worker-capability");
  const helperPath = join(process.cwd(), "src/providers/git-credentials.ts");
  const capability = signer.mint(scope, clock, 300);
  writeFileSync(capabilityFile, capability, { mode: 0o600 });

  let appTokenRequests = 0;
  let serverApplication = application;
  let serverStore = store;
  let service: WorkerGitCredentialService;
  const makeService = (now: () => number) =>
    new WorkerGitCredentialService({
      signer,
      github: new GitHubAppBroker({
        appId: "fixture-app",
        installationId: 42,
        privateKey,
        apiUrl: `http://127.0.0.1:${githubServer!.port}/api/`,
        now,
      }),
      authorize: async (claims, observedAt) => {
        const current = serverStore!.get(claims.commissionId);
        return (
          current !== null &&
          (await serverApplication.authorizeWorkerGitCapability(
            claims,
            `refs/heads/${workBranchFor(current)}`,
            observedAt,
          ))
        );
      },
      now,
    });
  githubServer = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/app/installations/42/access_tokens") {
        const body = (await request.json()) as {
          repositories: string[];
          permissions: Record<string, string>;
        };
        appTokenRequests += 1;
        expect(body).toEqual({
          repositories: ["demo"],
          permissions: { contents: "write" },
        });
        return Response.json(
          {
            token: `ghs_worker_${appTokenRequests}`,
            expires_at: new Date(clock + 90_000).toISOString(),
            permissions: body.permissions,
          },
          { status: 201 },
        );
      }
      return Response.json({ message: "not found" }, { status: 404 });
    },
  });
  service = makeService(() => clock);
  const startApiServer = () =>
    Bun.serve({
      port: 0,
      fetch: createDaemonApp({
        application,
        store: store!,
        config: {
          bearerToken: "fixture-daemon-token-with-at-least-32-bytes",
          principalId: "operator-1",
        },
        policy: { ...policy, runtimeProvisioning: true },
        now: () => clock,
        gitCredentialService: service,
      }).fetch,
    });
  apiServer = startApiServer();
  const credentialUrl = `http://127.0.0.1:${apiServer.port}/v1/git/credentials`;
  expect(credentialUrl).not.toContain(capability);
  const [exitCode, output, errors] = await runGitCredentialFill(
    helperPath,
    capabilityFile,
    credentialUrl,
    targetRef,
  );
  if (exitCode !== 0) throw new Error(`Git credential fill failed: ${errors}`);
  expect(output).toContain("username=x-access-token");
  expect(output).toContain("password=ghs_worker_1");
  expect(output).not.toContain(capability);
  expect(output).not.toContain(signingSecret);
  expect(output).not.toContain(privateKey);
  expect(errors).not.toContain("ghs_worker_1");
  expect(errors).not.toContain(capability);
  expect(errors).not.toContain(privateKey);
  expect(JSON.stringify(store.operations(commissionId))).not.toContain(
    "ghs_worker_1",
  );
  expect(JSON.stringify(store.get(commissionId))).not.toContain("ghs_worker_1");
  expect(JSON.stringify(store.get(commissionId))).not.toContain(privateKey);
  expect(world.dispatchKinds).toEqual(["provision_sandbox", "create_session"]);
  expect(appTokenRequests).toBe(1);
  const wrongMethod = await fetch(credentialUrl, {
    method: "GET",
    headers: { authorization: `Bearer ${capability}` },
  });
  expect(wrongMethod.status).toBe(405);
  chmodSync(capabilityFile, 0o644);
  const [weakFileExit] = await runGitCredentialFill(
    helperPath,
    capabilityFile,
    credentialUrl,
    targetRef,
  );
  expect(weakFileExit).not.toBe(0);
  chmodSync(capabilityFile, 0o600);
  const attemptedControllerPrivilege = await fetch(credentialUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${capability}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      repositoryUrl: "https://github.com/acme/demo",
      targetRef,
      purpose: "gh",
    }),
  });
  expect(attemptedControllerPrivilege.status).toBe(400);
  expect(appTokenRequests).toBe(1);

  const deny = async (
    deniedScope: WorkerGitCapabilityScope,
    deniedRef = targetRef,
    repoPath = "acme/demo.git",
    at = clock,
  ) => {
    writeFileSync(capabilityFile, signer.mint(deniedScope, at, 300), {
      mode: 0o600,
    });
    clock = at;
    return runGitCredentialFill(
      helperPath,
      capabilityFile,
      credentialUrl,
      deniedRef,
      repoPath,
    );
  };
  for (const denied of [
    { ...scope, commissionId: "missing-commission" },
    { ...scope, assignmentId: "different-assignment" },
    { ...scope, attemptId: "different-attempt" },
    { ...scope, sessionId: "different-session" },
    { ...scope, workspaceId: "different-workspace" },
    { ...scope, controllerId: "different-controller" },
    { ...scope, ownerEpoch: 2 },
  ]) {
    const [exit] = await deny(denied);
    expect(exit).not.toBe(0);
  }
  const wrongRef = await deny(
    { ...scope, targetRef: "refs/heads/anvil/not-the-assignment" },
    "refs/heads/anvil/not-the-assignment",
  );
  expect(wrongRef[0]).not.toBe(0);
  const otherRepository = await deny(scope, targetRef, "acme/other.git");
  expect(otherRepository[0]).not.toBe(0);

  // The signed claim remains valid, but current controller Lease authority does not.
  const originalGrant = world.grant;
  world.grant = {
    ...originalGrant,
    owner: { controllerId: "controller-1", epoch: 2 },
  };
  const [staleLeaseExit] = await deny(scope);
  expect(staleLeaseExit).not.toBe(0);
  world.grant = { ...originalGrant, validUntil: clock - 1 };
  const [expiredLeaseExit] = await deny(scope);
  expect(expiredLeaseExit).not.toBe(0);
  world.grant = originalGrant;

  // An expired signed capability cannot mint even a fresh GitHub token.
  const expiredCapability = signer.mint(scope, clock, 1);
  writeFileSync(capabilityFile, expiredCapability, { mode: 0o600 });
  clock += 2_000;
  const [expiredExit, , expiredError] = await runGitCredentialFill(
    helperPath,
    capabilityFile,
    credentialUrl,
    targetRef,
  );
  expect(expiredExit).not.toBe(0);
  expect(expiredError).not.toContain("ghs_worker_");
  clock -= 2_000;

  // App tokens refresh near expiry; the capability itself remains short-lived.
  clock += 40_000;
  writeFileSync(capabilityFile, signer.mint(scope, epoch + 3, 300), {
    mode: 0o600,
  });
  const [refreshExit, refreshOutput, refreshError] = await runGitCredentialFill(
    helperPath,
    capabilityFile,
    credentialUrl,
    targetRef,
  );
  if (refreshExit !== 0)
    throw new Error(`Git credential refresh failed: ${refreshError}`);
  expect(refreshOutput).toContain("password=ghs_worker_2");
  expect(appTokenRequests).toBe(2);

  // A new controller service instance can revalidate the on-disk capability after restart.
  store.close();
  store = new CommissionStore(dbPath);
  serverStore = store;
  application = new ApplicationService(
    store,
    world,
    world,
    world,
    "controller-1",
    { ...policy, runtimeProvisioning: true },
  );
  serverApplication = application;
  service = makeService(() => clock);
  apiServer.stop(true);
  apiServer = Bun.serve({
    port: 0,
    fetch: (request) => service.handle(request),
  });
  const restartedUrl = `http://127.0.0.1:${apiServer.port}/v1/git/credentials`;
  const [restartExit, restartOutput] = await runGitCredentialFill(
    helperPath,
    capabilityFile,
    restartedUrl,
    targetRef,
  );
  expect(restartExit).toBe(0);
  expect(restartOutput).toContain("password=ghs_worker_3");

  // Run ordinary Git over the helper against a real git-http-backend receiver.
  const projectRoot = join(directory, "github");
  const bareRepository = join(projectRoot, "acme", "demo.git");
  mkdirSync(join(projectRoot, "acme"), { recursive: true });
  runGit(["init", "--bare", bareRepository]);
  runGit(["--git-dir", bareRepository, "config", "http.receivepack", "true"]);
  const hookPath = join(bareRepository, "hooks", "pre-receive");
  writeFileSync(
    hookPath,
    "#!/bin/sh\nwhile read old_sha new_sha ref; do\n  [ \"$ref\" = \"$ANVIL_ALLOWED_GIT_REF\" ] || exit 1\ndone\n",
  );
  chmodSync(hookPath, 0o755);
  let authenticatedGitRequests = 0;
  const fixtureToken = "ghs_worker_3";
  const expectedBasic = `Basic ${Buffer.from(`x-access-token:${fixtureToken}`).toString("base64")}`;
  gitReceiverServer = Bun.serve({
    port: 0,
    fetch: async (request) => {
      if (request.headers.get("authorization") !== expectedBasic)
        return new Response(null, {
          status: 401,
          headers: { "www-authenticate": 'Basic realm="local protected Git"' },
        });
      authenticatedGitRequests += 1;
      return serveGitHttpBackend(request, {
        projectRoot,
        allowedRef: targetRef,
        expectedToken: fixtureToken,
      });
    },
  });
  const workerRepository = join(directory, "worker");
  runGit(["init", workerRepository]);
  runGit(["-C", workerRepository, "config", "user.name", "Local Worker"]);
  runGit(["-C", workerRepository, "config", "user.email", "worker@example.test"]);
  runGit(["-C", workerRepository, "switch", "-c", workBranchFor(commission)]);
  writeFileSync(join(workerRepository, "delivery.txt"), "local pushed commit\n");
  runGit(["-C", workerRepository, "add", "delivery.txt"]);
  runGit(["-C", workerRepository, "commit", "-m", "publish candidate"]);
  const workerSha = runGit(["-C", workerRepository, "rev-parse", "HEAD"]);
  const remoteUrl = `http://127.0.0.1:${gitReceiverServer.port}/git/acme/demo.git`;
  runGit(["-C", workerRepository, "remote", "add", "origin", remoteUrl]);
  runGit(
    [
      "-C",
      workerRepository,
      "config",
      "credential.helper",
      `!${process.execPath} run ${helperPath}`,
    ],
  );
  runGit(["-C", workerRepository, "config", "credential.useHttpPath", "true"]);
  const pushEnvironment = {
    ANVIL_GIT_CREDENTIAL_URL: restartedUrl,
    ANVIL_GIT_CAPABILITY_FILE: capabilityFile,
    ANVIL_GIT_TARGET_REF: targetRef,
    ANVIL_GIT_FIXTURE_REPOSITORY_URL: "https://github.com/acme/demo",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const allowedPush = runGitResult(
    ["-C", workerRepository, "push", "origin", `HEAD:${targetRef}`],
    workerRepository,
    pushEnvironment,
  );
  expect(allowedPush.exitCode).toBe(0);
  expect(runGit(["--git-dir", bareRepository, "rev-parse", targetRef])).toBe(
    workerSha,
  );
  expect(runGit(["-C", workerRepository, "remote", "get-url", "origin"])).toBe(
    remoteUrl,
  );
  expect(runGit(["-C", workerRepository, "config", "--local", "--list"])).not.toContain(
    fixtureToken,
  );

  const wrongBranchPush = runGitResult(
    ["-C", workerRepository, "push", "origin", "HEAD:refs/heads/not-authorized"],
    workerRepository,
    pushEnvironment,
  );
  expect(wrongBranchPush.exitCode).not.toBe(0);
  const wrongBranchRef = runGitResult(
    ["--git-dir", bareRepository, "show-ref", "--verify", "refs/heads/not-authorized"],
    directory,
    pushEnvironment,
  );
  expect(wrongBranchRef.exitCode).not.toBe(0);
  const multiRefPush = runGitResult(
    [
      "-C",
      workerRepository,
      "push",
      "origin",
      `HEAD:${targetRef}`,
      "HEAD:refs/heads/not-authorized",
    ],
    workerRepository,
    pushEnvironment,
  );
  expect(multiRefPush.exitCode).not.toBe(0);
  expect(runGit(["--git-dir", bareRepository, "rev-parse", targetRef])).toBe(
    workerSha,
  );
  expect(authenticatedGitRequests).toBeGreaterThan(0);
  expect(appTokenRequests).toBe(3);

  const held = await application.hold(
    commissionId,
    "revoke test capability",
    clock,
  );
  expect(held.ok).toBe(true);
  const [revokedExit, , revokedError] = await runGitCredentialFill(
    helperPath,
    capabilityFile,
    `http://127.0.0.1:${apiServer.port}/v1/git/credentials`,
    targetRef,
  );
  expect(revokedExit).not.toBe(0);
  expect(revokedError).not.toContain("ghs_worker_3");

  const resumed = await application.resume(commissionId, clock + 1);
  expect(resumed.ok).toBe(true);
  const deliveredRevision = "credential-final-candidate";
  world.revision = deliveredRevision;
  world.claims.set(
    deliveredRevision,
    "Worker completed the approved obligation.",
  );
  world.checks = {
    runId: "credential-check-pass",
    revision: deliveredRevision,
    state: "passing",
    failureIds: [],
    observedAt: clock,
    expiresAt: clock + 60_000,
    source: "local-ci-fixture",
  };
  const integrate = await application.reconcile(commissionId, clock + 2);
  expect(integrate.ok).toBe(true);
  world.mergeCandidate();
  const concluded = await application.reconcile(commissionId, clock + 3);
  expect(concluded.ok && concluded.value.commission.lifecycle).toBe(
    "concluded",
  );
  writeFileSync(capabilityFile, signer.mint(scope, clock + 3, 300), {
    mode: 0o600,
  });
  const [terminalExit] = await runGitCredentialFill(
    helperPath,
    capabilityFile,
    `http://127.0.0.1:${apiServer.port}/v1/git/credentials`,
    targetRef,
  );
  expect(terminalExit).not.toBe(0);
  expect(appTokenRequests).toBe(3);
});
