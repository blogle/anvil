import {
  KubernetesLeaseClient,
  leaseName,
  type KubernetesLeaseConfig,
} from "../../src/providers/kubernetes-lease";
import { epoch } from "./fixtures";
import {
  createServer,
  type Server,
  type Socket,
  type AddressInfo,
} from "node:net";

export type LeaseDocument = {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace: string;
    uid: string;
    resourceVersion: string;
    annotations: Record<string, string>;
  };
  spec: {
    holderIdentity: string;
    leaseTransitions: number;
    leaseDurationSeconds: number;
    acquireTime: string;
    renewTime: string;
  };
};
export const leaseToken = "lease-fixture-only-service-account-token";

/** Loopback REST fixture: real JSON/HTTP, namespaced identities and opaque RV CAS.
 * No Kubernetes client, credentials, kubeconfig, cluster or command is used. */
export class LeaseApiFixture {
  wall = epoch;
  mono = 0;
  version = 0;
  readonly records = new Map<string, LeaseDocument>();
  readonly calls: {
    method: string;
    path: string;
    authorization: string | null;
    body?: LeaseDocument;
  }[] = [];
  status: number | undefined;
  beforeWrite: (() => Promise<void>) | undefined;
  reply: ((document: LeaseDocument) => Response) | undefined;
  readonly server: Server;
  readonly ready: Promise<void>;
  readonly errors: unknown[] = [];
  readonly #sockets = new Set<Socket>();
  constructor(readonly now: () => number = () => this.wall) {
    // Bun 1.2.5 appends a real Date header in both Bun.serve and node:http,
    // even with sendDate=false. Bounded HTTP/1.1 framing over loopback TCP keeps
    // one deterministic server Date without weakening the production validator.
    this.server = createServer((socket) => {
      this.#sockets.add(socket);
      socket.on("close", () => this.#sockets.delete(socket));
      socket.on("error", () => {}); // Client timeout/abort is an intentional test.
      let input = Buffer.alloc(0),
        handled = false;
      socket.on("data", (chunk) => {
        if (handled) return;
        input = Buffer.concat([input, Buffer.from(chunk)]);
        if (input.length > 2 * 1024 * 1024) {
          socket.destroy();
          return;
        }
        const boundary = input.indexOf("\r\n\r\n");
        if (boundary < 0) return;
        const [line, ...lines] = input
          .subarray(0, boundary)
          .toString()
          .split("\r\n");
        const [method, path] = line!.split(" ");
        const headers = new Headers();
        for (const row of lines) {
          const colon = row.indexOf(":");
          headers.append(row.slice(0, colon), row.slice(colon + 1).trim());
        }
        const length = Number(headers.get("content-length") ?? "0");
        if (
          !Number.isSafeInteger(length) ||
          length < 0 ||
          length > 1024 * 1024 ||
          headers.has("transfer-encoding")
        ) {
          socket.destroy();
          return;
        }
        if (input.length < boundary + 4 + length) return;
        handled = true;
        const request = new Request(new URL(path!, this.url), {
          method: method!,
          headers,
          ...(method === "GET" || method === "HEAD"
            ? {}
            : { body: input.subarray(boundary + 4, boundary + 4 + length) }),
        });
        void this.handle(request)
          .then(async (response) => {
            const bytes = Buffer.from(await response.arrayBuffer());
            response.headers.set("content-length", String(bytes.length));
            response.headers.set("connection", "close");
            const head = `HTTP/1.1 ${response.status} Fixture\r\n${[...response.headers].map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n`;
            if (!socket.destroyed)
              socket.end(Buffer.concat([Buffer.from(head), bytes]));
          })
          .catch((error: unknown) => {
            this.errors.push(error);
            socket.destroy();
          });
      });
    });
    this.ready = new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => resolve());
    });
  }
  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/`;
  }
  json(value: unknown, status = 200) {
    return Response.json(value, {
      status,
      headers: { date: new Date(this.now()).toUTCString() },
    });
  }
  async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const call: (typeof this.calls)[number] = {
      method: request.method,
      path,
      authorization: request.headers.get("authorization"),
    };
    this.calls.push(call);
    if (call.authorization !== `Bearer ${leaseToken}`)
      return this.json({}, 401);
    if (this.status !== undefined)
      return this.json({ message: "redacted fixture failure" }, this.status);
    const match =
      /^\/apis\/coordination.k8s.io\/v1\/namespaces\/([^/]+)\/leases(?:\/([^/]+))?$/.exec(
        path,
      );
    if (match === null) return this.json({}, 404);
    const namespace = decodeURIComponent(match[1]!);
    const name =
      match[2] === undefined ? undefined : decodeURIComponent(match[2]);
    if (request.method === "GET" && name !== undefined) {
      const found = this.records.get(`${namespace}/${name}`);
      return found === undefined
        ? this.json({}, 404)
        : (this.reply?.(structuredClone(found)) ?? this.json(found));
    }
    if (request.method !== "POST" && request.method !== "PUT")
      return this.json({}, 405);
    const body = (await request.json()) as LeaseDocument;
    call.body = structuredClone(body);
    if (
      body.apiVersion !== "coordination.k8s.io/v1" ||
      body.kind !== "Lease" ||
      body.metadata.namespace !== namespace ||
      (request.method === "PUT" && body.metadata.name !== name)
    )
      return this.json({}, 422);
    await this.beforeWrite?.();
    const key = `${namespace}/${body.metadata.name}`;
    const existing = this.records.get(key);
    if (
      request.method === "POST"
        ? existing !== undefined
        : existing === undefined ||
          body.metadata.resourceVersion !== existing.metadata.resourceVersion ||
          body.metadata.uid !== existing.metadata.uid
    )
      return this.json({}, 409);
    const saved = {
      ...body,
      spec: {
        ...body.spec,
        acquireTime: microTime(body.spec.acquireTime),
        renewTime: microTime(body.spec.renewTime),
      },
      metadata: {
        ...body.metadata,
        resourceVersion: `opaque-rv-${++this.version}`,
        uid: existing?.metadata.uid ?? `fixture-uid-${this.version}`,
      },
    };
    this.records.set(key, structuredClone(saved));
    return (
      this.reply?.(structuredClone(saved)) ??
      this.json(saved, request.method === "POST" ? 201 : 200)
    );
  }
  client(
    identity = "controller-a",
    epochFloor: (id: string) => number = () => 0,
    options: Partial<KubernetesLeaseConfig> = {},
  ) {
    return new KubernetesLeaseClient({
      apiServerUrl: this.url,
      namespace: "lease-test",
      controllerIdentity: identity,
      bearerToken: () => leaseToken,
      epochFloor,
      now: this.now,
      monotonicNow: () => this.mono,
      ...options,
    });
  }
  get(id = "commission-1", namespace = "lease-test") {
    return this.records.get(`${namespace}/${leaseName(id)}`)!;
  }
  advance(ms: number) {
    this.wall += ms;
    this.mono += ms;
  }
  close() {
    for (const socket of this.#sockets) socket.destroy();
    this.server.close();
  }
}

function microTime(value: string): string {
  return new Date(value)
    .toISOString()
    .replace(/\.(\d{3})Z$/, (_match, ms: string) => `.${ms}000Z`);
}
