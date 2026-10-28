import { afterEach, expect, test } from "bun:test";
import {
  AgentSandboxClient,
  buildSandboxResource,
  sandboxName,
  type SandboxIntent,
} from "../../src/providers/agent-sandbox";

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

const intent: SandboxIntent = {
  commissionId: "commission-123",
  project: "anvil",
  repository: "https://github.com/example/anvil.git",
  baseRef: "main",
  imageDigest: `ghcr.io/example/anvil-sandbox@sha256:${"a".repeat(64)}`,
  workspaceSize: "10Gi",
  openCodePort: 4096,
  profileClaim: "anvil-opencode-profile",
  sharedNixClaim: "anvil-nix-shared",
  environment: {},
  secretReferences: [
    {
      name: "OPENCODE_SERVER_PASSWORD",
      secretName: "opencode-profile-credentials",
      secretKey: "server-password",
    },
  ],
};

function createFixture(
  options: Readonly<{ persistCreateOnLostAck?: boolean }> = {},
) {
  let resource: Record<string, unknown> | null = null;
  let creates = 0;
  let loseNextCreateAck = false;
  const methods: string[] = [];
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const name = sandboxName(intent.commissionId);
      methods.push(`${request.method} ${url.pathname}`);
      expect(request.headers.get("authorization")).toBe(
        "Bearer fixture-kubernetes-token",
      );
      if (url.pathname.endsWith("/sandboxes") && request.method === "GET")
        return Response.json({ items: resource === null ? [] : [resource] });
      if (url.pathname.endsWith("/sandboxes") && request.method === "POST") {
        creates += 1;
        resource = (await request.json()) as Record<string, unknown>;
        resource = {
          ...resource,
          metadata: {
            ...(resource["metadata"] as Record<string, unknown>),
            resourceVersion: "1",
            uid: "uid-fixture-1",
          },
          status: {
            conditions: [{ type: "Ready", status: "True" }],
          },
        };
        if (loseNextCreateAck) {
          loseNextCreateAck = false;
          if (options.persistCreateOnLostAck === false) resource = null;
          return Response.json(
            { message: "response lost after persistence" },
            { status: 504 },
          );
        }
        return Response.json(resource, { status: 201 });
      }
      if (
        url.pathname.endsWith(`/sandboxes/${name}`) &&
        request.method === "GET"
      )
        return resource === null
          ? Response.json({ message: "Not found" }, { status: 404 })
          : Response.json(resource);
      if (
        url.pathname.endsWith(`/sandboxes/${name}`) &&
        request.method === "PATCH"
      ) {
        if (resource === null)
          return Response.json({ message: "Not found" }, { status: 404 });
        expect(request.headers.get("content-type")).toBe(
          "application/json-patch+json",
        );
        const patch = (await request.json()) as readonly {
          op: string;
          path: string;
          value: string;
        }[];
        const metadata = resource["metadata"] as Record<string, string>;
        expect(patch).toEqual([
          {
            op: "test",
            path: "/metadata/resourceVersion",
            value: metadata["resourceVersion"],
          },
          {
            op: "add",
            path: "/spec/operatingMode",
            value: expect.any(String),
          },
        ]);
        if (
          patch[0]?.path !== "/metadata/resourceVersion" ||
          patch[0].value !== metadata["resourceVersion"]
        ) {
          return Response.json(
            { message: "resource version conflict" },
            { status: 409 },
          );
        }
        resource = {
          ...resource,
          spec: {
            ...(resource["spec"] as Record<string, unknown>),
            operatingMode: patch[1]?.value,
          },
          metadata: {
            ...(resource["metadata"] as Record<string, unknown>),
            resourceVersion: String(
              Number(
                (resource["metadata"] as Record<string, string>)[
                  "resourceVersion"
                ],
              ) + 1,
            ),
          },
        };
        return Response.json(resource);
      }
      if (
        url.pathname.endsWith(`/sandboxes/${name}`) &&
        request.method === "DELETE"
      ) {
        const options = (await request.json()) as {
          preconditions: { uid: string; resourceVersion: string };
        };
        const metadata = resource?.["metadata"] as
          | Record<string, string>
          | undefined;
        if (
          metadata?.["uid"] !== options.preconditions.uid ||
          metadata?.["resourceVersion"] !==
            options.preconditions.resourceVersion
        ) {
          return Response.json(
            { message: "delete precondition failed" },
            { status: 409 },
          );
        }
        resource = null;
        return Response.json({ status: "Success" });
      }
      return Response.json(
        { message: "fixture route not found" },
        { status: 404 },
      );
    },
  });
  return {
    apiUrl: `http://127.0.0.1:${server.port}/`,
    methods,
    createCount: () => creates,
    loseCreateAck: () => {
      loseNextCreateAck = true;
    },
  };
}

function client(apiUrl: string) {
  return new AgentSandboxClient({
    apiServerUrl: apiUrl,
    namespace: "anvil-test",
    bearerToken: "fixture-kubernetes-token",
  });
}

test("Sandbox resource contract creates a namespaced agent-sandbox with persistent Workspace and read-only shared Nix", () => {
  const manifest = buildSandboxResource(intent, "anvil-test");
  const metadata = manifest["metadata"] as Record<string, unknown>;
  const spec = manifest["spec"] as Record<string, unknown>;
  const template = spec["podTemplate"] as Record<string, unknown>;
  const podSpec = template["spec"] as Record<string, unknown>;
  const container = (podSpec["containers"] as Record<string, unknown>[])[0]!;
  expect(manifest).toMatchObject({
    apiVersion: "agents.x-k8s.io/v1beta1",
    kind: "Sandbox",
    metadata: {
      namespace: "anvil-test",
      labels: { "app.kubernetes.io/managed-by": "anvil" },
    },
    spec: { service: true },
  });
  expect(metadata["name"]).toBe(sandboxName(intent.commissionId));
  expect(spec["volumeClaimTemplates"]).toMatchObject([
    {
      metadata: { name: "workspace" },
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: { requests: { storage: "10Gi" } },
      },
    },
  ]);
  const mounts = container["volumeMounts"] as Record<string, unknown>[];
  expect(
    mounts
      .filter(({ name }) => name === "shared-nix")
      .every(({ readOnly }) => readOnly === true),
  ).toBe(true);
  const environment = container["env"] as Record<string, unknown>[];
  expect(environment).toContainEqual({ name: "ANVIL_PROJECT", value: "anvil" });
  expect(environment).toContainEqual({ name: "ANVIL_REF", value: "main" });
  expect(podSpec["automountServiceAccountToken"]).toBe(false);
  expect(
    environment.find(({ name }) => name === "OPENCODE_SERVER_PASSWORD"),
  ).toMatchObject({
    valueFrom: {
      secretKeyRef: {
        name: "opencode-profile-credentials",
        key: "server-password",
      },
    },
  });
  expect(JSON.stringify(manifest)).not.toContain("fixture-kubernetes-token");
  expect(JSON.stringify(manifest)).not.toContain("actual-secret-value");
  expect(() =>
    buildSandboxResource(
      { ...intent, imageDigest: "example/sandbox:latest" },
      "anvil-test",
    ),
  ).toThrow("immutable sha256 digest");
  expect(() =>
    buildSandboxResource(
      { ...intent, environment: { API_TOKEN: "secret" } },
      "anvil-test",
    ),
  ).toThrow("Kubernetes Secret reference");
  expect(() =>
    buildSandboxResource(
      { ...intent, environment: { ANVIL_PROJECT: "spoofed" } },
      "anvil-test",
    ),
  ).toThrow("Anvil-owned runtime identity");
});

test("Agent Sandbox client creates, observes, suspends, resumes, and deletes only its own resource", async () => {
  const fixture = createFixture();
  const adapter = client(fixture.apiUrl);
  const created = await adapter.create(intent);
  expect(created).toMatchObject({
    ok: true,
    value: {
      name: sandboxName(intent.commissionId),
      namespace: "anvil-test",
      commissionId: intent.commissionId,
      environmentState: "ready",
      operatingMode: "Running",
    },
  });
  expect(fixture.createCount()).toBe(1);
  expect((await adapter.create(intent)).ok).toBe(true);
  expect(fixture.createCount()).toBe(1);

  const suspended = await adapter.suspend(intent.commissionId);
  expect(suspended).toMatchObject({
    ok: true,
    value: { operatingMode: "Suspended", environmentState: "suspended" },
  });
  const resumed = await adapter.resume(intent.commissionId);
  expect(resumed).toMatchObject({
    ok: true,
    value: { operatingMode: "Running", environmentState: "ready" },
  });
  expect(await adapter.delete(intent.commissionId)).toEqual({
    ok: true,
    value: undefined,
  });
  expect(await adapter.inspect(intent.commissionId)).toMatchObject({
    ok: false,
    error: { kind: "not_found" },
  });
  expect(
    fixture.methods.some((method) =>
      method.includes(
        "/apis/agents.x-k8s.io/v1beta1/namespaces/anvil-test/sandboxes",
      ),
    ),
  ).toBe(true);
});

test("lost Sandbox create acknowledgement is resolved by resource identity, never by duplicate create", async () => {
  const fixture = createFixture();
  fixture.loseCreateAck();
  const regular = server;
  if (regular === undefined) throw new Error("Sandbox fixture did not start");
  // The fixture persists the submitted resource, then returns an error to model
  // an accepted Kubernetes write whose response was lost.
  const apiUrl = `http://127.0.0.1:${regular.port}/`;
  const recovery = new AgentSandboxClient({
    apiServerUrl: apiUrl,
    namespace: "anvil-test",
    bearerToken: "fixture-kubernetes-token",
  });
  const result = await recovery.create(intent);
  expect(result.ok).toBe(true);
  expect(fixture.createCount()).toBe(1);
});

test("unobservable Sandbox create acknowledgement remains ambiguous without a second POST", async () => {
  const fixture = createFixture({ persistCreateOnLostAck: false });
  fixture.loseCreateAck();
  const adapter = client(fixture.apiUrl);
  expect(await adapter.create(intent)).toMatchObject({
    ok: false,
    error: { kind: "ambiguous" },
  });
  expect(fixture.createCount()).toBe(1);
});

test("same Commission ID with a different Sandbox spec is a conflict", async () => {
  const fixture = createFixture();
  const adapter = client(fixture.apiUrl);
  expect((await adapter.create(intent)).ok).toBe(true);
  const changed = { ...intent, project: "other-project" };
  expect(await adapter.create(changed)).toMatchObject({
    ok: false,
    error: { kind: "conflict" },
  });
});
