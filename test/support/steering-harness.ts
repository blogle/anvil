import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApplicationService,
  type ProviderPort,
  type LeasePort,
} from "../../src/application";
import type { SteeringRequest } from "../../src/domain";
import { CommissionStore } from "../../src/persistence/sqlite";
import { AgentSandboxClient } from "../../src/providers/agent-sandbox";
import { ProviderComposition } from "../../src/providers/composition";
import { OpenCodeAdapter } from "../../src/providers/opencode";
import type { WorkerBootstrap } from "../../src/providers/worker-bootstrap";
import { FakeWorld } from "./fake-world";
import { epoch, observation, policy, proposalInput, value } from "./fixtures";

// Real SQLite and production provider composition over loopback protocol fixtures.
export class SteeringHarness {
  readonly directory = mkdtempSync(join(tmpdir(), "anvil-steering-"));
  readonly path = join(this.directory, "state.sqlite");
  store = new CommissionStore(this.path);
  readonly world = new FakeWorld();
  readonly policy = {
    ...policy,
    runtimeProvisioning: true,
    workerBootstrap: false,
  };
  bootstrap: WorkerBootstrap | undefined;
  workerRequest:
    | ((request: Request) => Promise<Response | undefined>)
    | undefined;
  now = epoch + 10;
  active = false;
  otherActiveSessions: string[] = [];
  loseAcknowledgement = false;
  hideMessages = false;
  readonly prompts: { id: string; text: string }[] = [];
  modelSelections = 0;
  interrupts = 0;
  beforeModel: (() => Promise<void>) | undefined;
  beforeObserve: (() => Promise<void>) | undefined;
  afterPrompt: (() => Promise<void>) | undefined;
  sandbox: Record<string, unknown> | null = null;
  readonly fixture = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const worker = await this.workerRequest?.(request);
      if (worker !== undefined) return worker;
      const path = new URL(request.url).pathname;
      if (path.includes("/sandboxes")) {
        if (request.method === "POST") {
          const body = (await request.json()) as Record<string, unknown>;
          this.sandbox = {
            ...body,
            metadata: {
              ...(body["metadata"] as object),
              uid: "sandbox-uid",
              resourceVersion: "1",
            },
            status: { conditions: [{ type: "Ready", status: "True" }] },
          };
          return Response.json(this.sandbox, { status: 201 });
        }
        return path.endsWith("/sandboxes")
          ? Response.json({ items: this.sandbox ? [this.sandbox] : [] })
          : this.sandbox
            ? Response.json(this.sandbox)
            : new Response(null, { status: 404 });
      }
      if (path === "/api/session" && request.method === "POST")
        return Response.json({ data: { id: "session-1" } });
      if (path === "/api/session/active")
        return Response.json({
          data: {
            ...(this.active ? { "session-1": { type: "busy" } } : {}),
            ...Object.fromEntries(
              this.otherActiveSessions.map((id) => [id, { type: "busy" }]),
            ),
          },
        });
      if (path === "/api/model") return Response.json({ data: [] });
      if (path.endsWith("/model")) {
        this.modelSelections += 1;
        await this.beforeModel?.();
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/prompt")) {
        this.prompts.push(
          (await request.json()) as { id: string; text: string },
        );
        this.active = true;
        await this.afterPrompt?.();
        if (this.loseAcknowledgement)
          return new Response(null, { status: 504 });
        return Response.json({ data: { id: this.prompts.at(-1)!.id } });
      }
      if (path.endsWith("/interrupt")) {
        this.interrupts += 1;
        return Response.json({ data: { interrupted: false } });
      }
      if (path.endsWith("/message"))
        return Response.json({
          data: this.hideMessages
            ? []
            : this.prompts.map((p) => ({
                id: p.id,
                type: "user",
                time: { created: this.now },
                text: p.text,
              })),
        });
      return new Response(null, { status: 404 });
    },
  });
  application = this.makeApplication();

  composition(): ProviderPort {
    const composition = new ProviderComposition({
      ...(this.bootstrap === undefined
        ? {}
        : { workerBootstrap: this.bootstrap }),
      sandbox: new AgentSandboxClient({
        apiServerUrl: this.fixture.url.href,
        namespace: "test",
        bearerToken: "fixture-only",
      }),
      world: {
        observe: async () => {
          await this.beforeObserve?.();
          const { execution: _execution, ...facts } = observation({
            candidateObservedAt: this.now,
            candidateExpiresAt: this.now + 60000,
          });
          return { ok: true, value: facts };
        },
      },
      openCodeForSandbox: () =>
        new OpenCodeAdapter({ baseUrl: this.fixture.url.href }),
      model: { providerId: "fixture-provider", modelId: "fixture-model" },
      sandboxIntent: (c) => ({
        commissionId: c.id,
        project: c.campaignId,
        repository: c.repository,
        baseRef: c.integrationTarget,
        imageDigest: `ghcr.io/example/worker@sha256:${"a".repeat(64)}`,
        workspaceSize: "1Gi",
        openCodePort: 4096,
        profileClaim: "profile",
        sharedNixClaim: "nix",
        environment: {},
        secretReferences: [],
      }),
    });
    return composition;
  }

  makeApplication(
    store = this.store,
    authority?: Readonly<{ lease: LeasePort; controllerId: string }>,
  ): ApplicationService {
    return new ApplicationService(
      store,
      authority?.lease ?? this.world,
      this.composition(),
      this.world,
      authority?.controllerId ?? "controller-1",
      this.policy,
      () => this.now,
    );
  }
  async initialize(budget = proposalInput().budget): Promise<void> {
    value(this.application.propose(proposalInput({ budget })));
    value(await this.application.admit("commission-1", "operator-1", this.now));
    value(await this.application.reconcile("commission-1", this.now));
    value(await this.application.reconcile("commission-1", this.now));
  }
  request(overrides: Partial<SteeringRequest> = {}): SteeringRequest {
    const c = this.store.get("commission-1")!;
    return {
      idempotencyKey: "steering-1",
      assignmentId: c.attempts.find((a) => a.id === c.activeAttemptId)!
        .assignmentId,
      expectedVersion: c.version,
      expectedGeneration: c.specificationGeneration,
      instruction:
        "Inspect the persisted retry boundary before editing, within the approved scope.",
      ...overrides,
    };
  }
  async steer(request = this.request(), principal = "operator-1") {
    return this.application.steerAssignment(
      "commission-1",
      principal,
      request,
      this.now,
    );
  }
  async reconcile() {
    return this.application.reconcile("commission-1", this.now);
  }
  reopen(): void {
    this.store.close();
    this.store = new CommissionStore(this.path);
    this.application = this.makeApplication();
  }
  close(): void {
    this.store.close();
    this.fixture.stop(true);
    rmSync(this.directory, { recursive: true, force: true });
  }
}
