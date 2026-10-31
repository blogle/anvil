import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { WorkerBootstrap } from "../src/providers/worker-bootstrap";
import {
  WorkerGitCapabilitySigner,
  WorkerGitCredentialService,
} from "../src/providers/git-credentials";
import { GitHubAppBroker } from "../src/providers/github-app";
import { SteeringHarness } from "./support/steering-harness";
import { WorkerFiles, gitHttp } from "./support/worker-files";
import { value } from "./support/fixtures";

let h: SteeringHarness | undefined;
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers) server.stop(true);
  servers.length = 0;
  h?.close();
  h = undefined;
});

function git(home: string, args: string[], cwd?: string) {
  const result = Bun.spawnSync(["git", ...args], {
    ...(cwd === undefined ? {} : { cwd }),
    env: {
      ...process.env,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      ANVIL_GIT_FIXTURE_REPOSITORY_URL: "https://github.com/example/repository",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    out: result.stdout.toString().trim(),
    error: result.stderr.toString(),
  };
}

async function setup() {
  const worker = new SteeringHarness();
  h = worker;
  const secret = "worker-bootstrap-fixture-secret-only-32-characters";
  const signer = new WorkerGitCapabilitySigner(secret);
  const imageHelper = join(worker.directory, "image-helper");
  writeFileSync(
    imageHelper,
    `#!/bin/sh\nexec '${process.execPath}' '${process.cwd()}/src/providers/git-helper.ts' "$@"\n`,
    { mode: 0o555 },
  );
  const files = new WorkerFiles(join(worker.directory, "worker"), imageHelper);
  worker.workerRequest = (r) => files.handle(r);
  worker.policy.workerBootstrap = true;
  let issued = 0,
    token = "ghs_initial_fixture";
  const issuer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      issued += 1;
      const body = (await request.json()) as {
        permissions: Record<string, string>;
        repositories: string[];
      };
      expect(body.repositories).toEqual(["repository"]);
      expect(body.permissions).toEqual({ contents: "write" });
      return Response.json(
        {
          token,
          expires_at: new Date(worker.now + 120000).toISOString(),
          permissions: { contents: "write", metadata: "read" },
        },
        { status: 201 },
      );
    },
  });
  servers.push(issuer);
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const broker = new GitHubAppBroker({
    appId: "fixture",
    installationId: 1,
    privateKey: keys.privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
    apiUrl: issuer.url.href,
    now: () => worker.now,
  });
  const service = new WorkerGitCredentialService({
    signer,
    github: broker,
    now: () => worker.now,
    authorize: (scope, now) =>
      worker.application.authorizeWorkerGitCapability(
        scope,
        "refs/heads/anvil/worker",
        now,
      ),
  });
  const credentialServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (r) => service.handle(r),
  });
  servers.push(credentialServer);
  worker.bootstrap = new WorkerBootstrap({
    signer,
    credentialUrl: `${credentialServer.url}v1/git/credentials`,
    privateDirectory: join(files.home, ".anvil-worker"),
    repositoryDirectory: join(files.home, "workspace"),
    imageHelper,
    targetRef: () => "refs/heads/anvil/worker",
  });
  worker.application = worker.makeApplication();
  await worker.initialize();
  return {
    worker,
    files,
    signer,
    secret,
    credentialServer,
    issued: () => issued,
    rotate: () => {
      token = "ghs_rotated_fixture";
    },
  };
}

test("Session-bound provider bootstrap installs a private helper, recovers lost ack and publishes an actual worker Git commit", async () => {
  const { worker, files, signer, secret, credentialServer, issued, rotate } =
    await setup();
  files.lostFinishAck = true;
  value(await worker.reconcile());
  const op = worker.store
    .operations("commission-1")
    .find((o) => o.kind === "bootstrap_worker")!;
  expect(op.outcome.kind).toBe("ambiguous");
  expect(files.writes).toBe(1);
  expect(files.commands).toHaveLength(2);
  expect(worker.prompts).toHaveLength(0);
  const capPath = join(files.home, ".anvil-worker/capability");
  const capability = readFileSync(capPath, "utf8");
  expect(statSync(capPath).mode & 0o777).toBe(0o600);
  expect(statSync(join(files.home, ".anvil-worker/helper")).mode & 0o777).toBe(
    0o700,
  );
  const claims = signer.verify(capability, worker.now)!;
  expect(claims).toMatchObject({
    sessionId: "session-1",
    assignmentId: "commission-1:assignment-1",
    specificationGeneration: 1,
    ownerEpoch: 1,
  });
  worker.reopen();
  value(await worker.reconcile());
  expect(
    worker.store.operations("commission-1").find((o) => o.id === op.id)!.outcome
      .kind,
  ).toBe("observed");
  expect(files.writes).toBe(1);
  expect(files.commands).toHaveLength(2);
  value(await worker.reconcile());
  expect(worker.prompts).toHaveLength(1);
  const durable = JSON.stringify([
    worker.store.list(),
    worker.store.operations("commission-1"),
    files.commands,
    worker.prompts,
  ]);
  expect(durable).not.toContain(capability);
  expect(durable).not.toContain(secret);
  const root = join(worker.directory, "git-http");
  const bare = join(root, "example/repository.git");
  mkdirSync(bare, { recursive: true });
  expect(git(files.home, ["init", "--bare", bare]).code).toBe(0);
  expect(
    git(files.home, ["--git-dir", bare, "config", "http.receivepack", "true"])
      .code,
  ).toBe(0);
  writeFileSync(
    join(bare, "hooks/pre-receive"),
    '#!/bin/sh\nwhile read old new ref; do [ "$ref" = "$ANVIL_ALLOWED_GIT_REF" ] || exit 1; done\n',
    { mode: 0o555 },
  );
  const receiver = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (r) =>
      gitHttp(
        r,
        root,
        "refs/heads/anvil/worker",
        new Set(["ghs_initial_fixture", "ghs_rotated_fixture"]),
      ),
  });
  servers.push(receiver);
  const repo = join(files.home, "workspace");
  for (const args of [
    ["init"],
    ["config", "user.email", "fixture@example.invalid"],
    ["config", "user.name", "Worker fixture"],
    ["remote", "add", "origin", `${receiver.url}git/example/repository.git`],
  ])
    expect(git(files.home, args, repo).code).toBe(0);
  writeFileSync(join(repo, "implementation.txt"), "actual worker commit\n");
  expect(git(files.home, ["add", "implementation.txt"], repo).code).toBe(0);
  expect(
    git(files.home, ["commit", "-m", "Local worker fixture"], repo).code,
  ).toBe(0);
  const revision = git(files.home, ["rev-parse", "HEAD"], repo).out;
  const publish = async (ref = "refs/heads/anvil/worker") => {
    const child = Bun.spawn(["git", "push", "origin", `HEAD:${ref}`], {
      cwd: repo,
      env: {
        ...process.env,
        HOME: files.home,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        ANVIL_GIT_FIXTURE_REPOSITORY_URL:
          "https://github.com/example/repository",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await child.exited;
    await new Response(child.stdout).text();
    const errors = await new Response(child.stderr).text();
    expect(errors).not.toContain(capability);
    return code;
  };
  expect(await publish()).toBe(0);
  expect(
    git(files.home, ["--git-dir", bare, "rev-parse", "refs/heads/anvil/worker"])
      .out,
  ).toBe(revision);
  expect(issued()).toBe(1);
  expect(await publish("refs/heads/protected-other")).not.toBe(0); // receiver policy, not cryptographic ref confinement
  value(await worker.application.hold("commission-1", "review", worker.now));
  expect(await publish()).not.toBe(0);
  value(await worker.application.resume("commission-1", worker.now));
  files.sessionExists = false;
  expect(await publish()).not.toBe(0);
  files.sessionExists = true;
  const denied = await fetch(`${credentialServer.url}v1/git/credentials`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${capability}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      repositoryUrl: "https://github.com/foreign/repo",
      targetRef: "refs/heads/anvil/worker",
    }),
  });
  expect(denied.status).toBe(403);
  chmodSync(capPath, 0o644);
  expect(await publish()).not.toBe(0);
  chmodSync(capPath, 0o600);
  worker.now += 70000;
  rotate();
  expect(await publish()).toBe(0);
  expect(issued()).toBe(2);
  worker.now += 300000;
  expect(await publish()).not.toBe(0);
  worker.active = false;
  value(await worker.reconcile());
  expect(files.writes).toBe(2);
  expect(worker.prompts).toHaveLength(1);
  expect(readFileSync(capPath, "utf8")).not.toBe(capability);
  expect(await publish()).toBe(0);
  worker.world.grant = {
    ...worker.world.grant,
    owner: { controllerId: "successor", epoch: 2 },
  };
  const predecessor = worker.application;
  worker.active = true;
  const originalWriter = worker.store.get("commission-1")!.workspaceWriter;
  const originalOperations = worker.store.operations("commission-1");
  worker.application = worker.makeApplication(worker.store, {
    lease: worker.world,
    controllerId: "successor",
  });
  value(await worker.reconcile());
  expect(worker.store.get("commission-1")!.workspaceWriter).toEqual(
    originalWriter,
  );
  expect(worker.store.get("commission-1")!.owner).toEqual({
    controllerId: "successor",
    epoch: 2,
  });
  expect(files.writes).toBe(2);
  expect(await publish()).toBe(0);
  expect(
    await predecessor.authorizeWorkerGitCapability(
      claims,
      "refs/heads/anvil/worker",
      worker.now,
    ),
  ).toBe(false);
  expect((await predecessor.reconcile("commission-1", worker.now)).ok).toBe(
    false,
  );
  expect(worker.store.operations("commission-1").map((o) => o.id)).toEqual(
    originalOperations.map((o) => o.id),
  );
  worker.now += 295000;
  const priorCapability = readFileSync(capPath, "utf8");
  files.beforeWrite = async () => {
    expect(readFileSync(capPath, "utf8")).toBe(priorCapability);
    expect(await publish()).toBe(0);
  };
  files.lostFinishAck = true;
  value(await worker.reconcile());
  files.beforeWrite = undefined;
  expect(files.writes).toBe(3);
  value(await worker.reconcile());
  expect(files.writes).toBe(3);
  const successorClaims = signer.verify(
    readFileSync(capPath, "utf8"),
    worker.now,
  )!;
  expect(successorClaims).toMatchObject({
    controllerId: "successor",
    ownerEpoch: 2,
    sessionId: claims.sessionId,
    workspaceId: claims.workspaceId,
    assignmentId: claims.assignmentId,
  });
  expect(await publish()).toBe(0);
  expect(worker.interrupts).toBe(0);
  expect(worker.active).toBe(true);
  worker.otherActiveSessions = ["independent-writer"];
  expect(await publish()).not.toBe(0);
  value(await worker.reconcile());
  expect(worker.store.get("commission-1")!.workspaceWriter?.kind).toBe(
    "unresolved",
  );
  expect(worker.prompts).toHaveLength(1);
}, 30_000);

test("successor adopts an active lost-ack instruction and resolves the original Operation without another prompt", async () => {
  const { worker, files } = await setup();
  value(await worker.reconcile());
  worker.loseAcknowledgement = true;
  value(await worker.reconcile());
  const instruction = worker.store
    .operations("commission-1")
    .find((o) => o.kind === "continue")!;
  expect(instruction.outcome.kind).toBe("ambiguous");
  const writer = worker.store.get("commission-1")!.workspaceWriter;
  worker.reopen();
  worker.world.grant = {
    ...worker.world.grant,
    owner: { controllerId: "successor", epoch: 2 },
  };
  worker.application = worker.makeApplication(worker.store, {
    lease: worker.world,
    controllerId: "successor",
  });
  value(await worker.reconcile());
  value(await worker.reconcile());
  expect(
    worker.store
      .operations("commission-1")
      .find((o) => o.id === instruction.id),
  ).toMatchObject({
    controllerId: "controller-1",
    ownerEpoch: 1,
    outcome: { kind: "observed", result: "applied" },
  });
  expect(worker.store.get("commission-1")!.workspaceWriter).toEqual(writer);
  expect(worker.prompts).toHaveLength(1);
  expect(files.writes).toBe(1);
  expect(worker.interrupts).toBe(0);
  expect(worker.active).toBe(true);
});

test("failed/unknown bootstrap prevents model dispatch and is not replayed across reopen", async () => {
  const { worker, files } = await setup();
  files.failWrite = true;
  value(await worker.reconcile());
  expect(
    worker.store
      .operations("commission-1")
      .find((o) => o.kind === "bootstrap_worker")!.outcome.kind,
  ).toBe("ambiguous");
  worker.reopen();
  value(await worker.reconcile());
  value(await worker.reconcile());
  expect(files.commands).toHaveLength(1);
  expect(files.writes).toBe(0);
  expect(worker.prompts).toHaveLength(0);
});

test("conflicting bootstrap receipt is ambiguous and cannot authorize a prompt or replay installation", async () => {
  const { worker, files } = await setup();
  files.lostFinishAck = true;
  value(await worker.reconcile());
  const op = worker.store
    .operations("commission-1")
    .find((o) => o.kind === "bootstrap_worker")!;
  const receipt = join(
    files.home,
    ".anvil-worker",
    worker.bootstrap!.receipt(op),
  );
  writeFileSync(
    receipt,
    JSON.stringify({
      ...worker.bootstrap!.expected(
        worker.store.get("commission-1")!,
        op,
        "foreign-workspace",
        "session-1",
      ),
    }),
  );
  worker.reopen();
  expect((await worker.reconcile()).ok).toBe(false);
  expect(
    worker.store.operations("commission-1").find((o) => o.id === op.id)!.outcome
      .kind,
  ).toBe("ambiguous");
  expect(worker.prompts).toHaveLength(0);
  expect(files.writes).toBe(1);
  expect(files.commands).toHaveLength(2);
});

test("OpenCode file-write redirects cannot forward a worker capability to another endpoint", async () => {
  const { worker, files } = await setup();
  let exposed = 0;
  const sink = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      exposed += 1;
      return Response.json({});
    },
  });
  servers.push(sink);
  worker.workerRequest = async (request) => {
    if (new URL(request.url).pathname === "/api/experimental/fs/write")
      return Response.redirect(sink.url, 307);
    return files.handle(request);
  };
  value(await worker.reconcile());
  expect(exposed).toBe(0);
  expect(files.writes).toBe(0);
  expect(worker.prompts).toHaveLength(0);
  expect(
    worker.store
      .operations("commission-1")
      .find((o) => o.kind === "bootstrap_worker")!.outcome.kind,
  ).toBe("ambiguous");
});
