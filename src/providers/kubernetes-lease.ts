import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { LeasePort, ProviderResult } from "../application";
import type { LeaseGrant } from "../domain";

const commissionKey = "anvil.example/commission-id";
const contractKey = "anvil.example/lease-contract";
const requestKey = "anvil.example/lease-request-id";
const maxEpoch = 2_147_483_647; // Kubernetes LeaseSpec.leaseTransitions is int32.
const resourceSchema = z
  .object({
    apiVersion: z.literal("coordination.k8s.io/v1"),
    kind: z.literal("Lease"),
    metadata: z
      .object({
        name: z.string(),
        namespace: z.string(),
        uid: z.string().min(1),
        resourceVersion: z.string().min(1),
        annotations: z.record(z.string(), z.string()),
        deletionTimestamp: z.string().nullable().optional(),
      })
      .passthrough(),
    spec: z
      .object({
        holderIdentity: z.string().max(128),
        leaseDurationSeconds: z.number().int().min(10).max(300),
        leaseTransitions: z.number().int().min(1).max(maxEpoch),
        acquireTime: z.string(),
        renewTime: z.string(),
      })
      .passthrough(),
  })
  .passthrough();
type LeaseResource = z.infer<typeof resourceSchema>;
type Receipt = Readonly<{
  epoch: number;
  acquireTime: string;
  uid: string | null;
}>;

export type KubernetesLeaseConfig = Readonly<{
  apiServerUrl: string;
  namespace: string;
  controllerIdentity: string;
  bearerToken: () => string;
  caCertificate?: string;
  durationSeconds?: number;
  timeoutMs?: number;
  maxClockSkewMs?: number;
  epochFloor: (commissionId: string) => number;
  now?: () => number;
  monotonicNow?: () => number;
}>;

/** Every grant requires a fresh API CAS. Receipts are process-local proof of an
 * attempted acquisition, never a cached authorization or a second SQL journal. */
export class KubernetesLeaseClient implements LeasePort {
  readonly controllerId: string;
  readonly #config: KubernetesLeaseConfig;
  readonly #base: URL;
  readonly #duration: number;
  readonly #timeout: number;
  readonly #skew: number;
  readonly #now: () => number;
  readonly #mono: () => number;
  readonly #receipts = new Map<string, Receipt>();
  readonly #foreign = new Map<
    string,
    Readonly<{ fingerprint: string; since: number }>
  >();
  readonly #released = new Set<string>();
  #stopped = false;
  #clockFailed = false;
  #lastTime: Readonly<{ wall: number; mono: number }> | undefined;

  constructor(config: KubernetesLeaseConfig) {
    const base = new URL(config.apiServerUrl);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
      base.hostname,
    );
    if (
      !["https:", "http:"].includes(base.protocol) ||
      (base.protocol === "http:" && !loopback) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      throw new Error(
        "Lease API requires credential-free HTTPS (HTTP only for loopback fixtures)",
      );
    if (base.protocol === "https:" && !config.caCertificate?.trim())
      throw new Error("Lease API HTTPS requires an explicit CA certificate");
    if (!/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(config.namespace))
      throw new Error("Invalid Lease namespace");
    if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(config.controllerIdentity))
      throw new Error("Invalid controller identity");
    this.#duration = config.durationSeconds ?? 30;
    this.#timeout = config.timeoutMs ?? 2000;
    this.#skew = config.maxClockSkewMs ?? 2000;
    if (
      !Number.isInteger(this.#duration) ||
      this.#duration < 10 ||
      this.#duration > 300 ||
      !Number.isInteger(this.#timeout) ||
      this.#timeout < 1 ||
      !Number.isInteger(this.#skew) ||
      this.#skew < 1000 ||
      this.#duration * 1000 <= 2 * this.#skew + 2 * this.#timeout
    )
      throw new Error(
        "Lease timing must leave a positive skew/timeout safety margin",
      );
    base.pathname = base.pathname.endsWith("/")
      ? base.pathname
      : `${base.pathname}/`;
    this.#base = base;
    this.#config = config;
    this.#now = config.now ?? Date.now;
    this.#mono = config.monotonicNow ?? (() => performance.now());
    // Caller chooses a stable deployment label, never the complete holder ID.
    this.controllerId = `${config.controllerIdentity}:${randomUUID()}`;
  }

  async current(
    commissionId: string,
    controllerId: string,
    _now: number,
  ): Promise<ProviderResult<LeaseGrant>> {
    if (
      controllerId !== this.controllerId ||
      this.#stopped ||
      this.#released.has(commissionId)
    )
      return failure("Lease process identity is not authorized");
    const time = this.#time();
    if (time === null)
      return failure("Lease clock discontinuity; process restart required");
    const floor = this.#config.epochFloor(commissionId);
    if (!Number.isSafeInteger(floor) || floor < 0 || floor >= maxEpoch)
      return failure("Lease epoch history is invalid or exhausted");
    const read = await this.#request(commissionId, "GET");
    let previous: LeaseResource | null;
    if (!read.ok) {
      if (read.error.message !== "Kubernetes Lease HTTP 404") return read;
      if (floor !== 0 || this.#receipts.has(commissionId))
        return failure(
          "Missing Lease history for an owned Commission; explicit recovery required",
        );
      previous = null;
    } else {
      const checked = this.#resource(commissionId, read.value);
      if (!checked.ok) return checked;
      previous = checked.value;
      if (previous.spec.leaseTransitions < floor)
        return failure(
          "Lease epoch regressed behind durable Commission ownership",
        );
    }
    const start = this.#time();
    if (start === null)
      return failure("Lease clock discontinuity; process restart required");
    const receipt = this.#receipts.get(commissionId);
    const ours =
      previous !== null && previous.spec.holderIdentity === this.controllerId;
    if (
      ours &&
      (receipt === undefined ||
        receipt.epoch !== previous!.spec.leaseTransitions ||
        !sameTime(receipt.acquireTime, previous!.spec.acquireTime) ||
        (receipt.uid !== null && receipt.uid !== previous!.metadata.uid))
    )
      return failure(
        "Lease holder string is not acquisition proof for this incarnation",
      );
    const renewing =
      ours &&
      Date.parse(previous!.spec.renewTime) +
        previous!.spec.leaseDurationSeconds * 1000 >
        start.wall + 2 * this.#skew;
    if (previous !== null && previous.spec.holderIdentity !== "" && !ours) {
      // Do not use a foreign machine's timestamps to accelerate takeover. Observe
      // an unchanged record for its full duration using our monotonic clock.
      const fingerprint = JSON.stringify([
        previous.metadata.uid,
        previous.spec,
      ]);
      let observed = this.#foreign.get(commissionId);
      if (observed?.fingerprint !== fingerprint) {
        observed = { fingerprint, since: start.mono };
        this.#foreign.set(commissionId, observed);
      }
      if (
        start.mono - observed.since <
        previous.spec.leaseDurationSeconds * 1000 + 2 * this.#skew
      )
        return failure(
          "Lease is held by another incarnation; expiry is not established",
        );
    }
    const epoch = renewing
      ? previous!.spec.leaseTransitions
      : Math.max(floor, previous?.spec.leaseTransitions ?? 0) + 1;
    if (epoch > maxEpoch) return failure("Lease epoch exhausted");
    const spec = {
      holderIdentity: this.controllerId,
      leaseDurationSeconds: this.#duration,
      leaseTransitions: epoch,
      acquireTime: renewing
        ? previous!.spec.acquireTime
        : new Date(start.wall).toISOString(),
      renewTime: new Date(start.wall).toISOString(),
    };
    this.#receipts.set(commissionId, {
      epoch,
      acquireTime: spec.acquireTime,
      uid: previous?.metadata.uid ?? null,
    });
    const nonce = randomUUID();
    const metadata = {
      ...(previous?.metadata ?? {
        name: leaseName(commissionId),
        namespace: this.#config.namespace,
      }),
      annotations: {
        ...previous?.metadata.annotations,
        [commissionKey]: commissionId,
        [contractKey]: "v1",
        [requestKey]: nonce,
      },
    };
    const write = await this.#request(
      commissionId,
      previous === null ? "POST" : "PUT",
      {
        apiVersion: "coordination.k8s.io/v1",
        kind: "Lease",
        metadata,
        spec,
      },
    );
    if (!write.ok) return write; // Conflict/timeout is never a grant, even after a previous success.
    const checked = this.#resource(commissionId, write.value);
    if (!checked.ok) return checked;
    const resource = checked.value;
    if (
      !sameSpec(resource.spec, spec) ||
      resource.metadata.annotations[requestKey] !== nonce ||
      (previous !== null &&
        (resource.metadata.uid !== previous.metadata.uid ||
          resource.metadata.resourceVersion ===
            previous.metadata.resourceVersion))
    )
      return failure(
        "Lease CAS response did not confirm the requested identity, epoch and renewal",
      );
    const end = this.#time();
    const validUntil =
      start.wall + this.#duration * 1000 - 2 * this.#skew - this.#timeout;
    if (
      end === null ||
      end.wall >= validUntil ||
      end.mono - start.mono >=
        this.#duration * 1000 - 2 * this.#skew - this.#timeout ||
      this.#stopped ||
      this.#released.has(commissionId)
    )
      return failure(
        "Lease confirmation arrived outside its safe authority window",
      );
    this.#receipts.set(commissionId, {
      epoch,
      acquireTime: spec.acquireTime,
      uid: resource.metadata.uid,
    });
    this.#foreign.delete(commissionId);
    return {
      ok: true,
      value: {
        owner: { controllerId: this.controllerId, epoch },
        resourceVersion: resource.metadata.resourceVersion,
        observedAt: end.wall,
        validUntil,
      },
    };
  }

  async release(commissionId: string): Promise<ProviderResult<void>> {
    this.#released.add(commissionId); // Stop authorizing before any cleanup I/O.
    const read = await this.#request(commissionId, "GET");
    if (!read.ok) return read;
    const checked = this.#resource(commissionId, read.value);
    if (!checked.ok) return checked;
    const current = checked.value;
    const receipt = this.#receipts.get(commissionId);
    if (
      receipt === undefined ||
      current.spec.holderIdentity !== this.controllerId ||
      current.spec.leaseTransitions !== receipt.epoch ||
      !sameTime(current.spec.acquireTime, receipt.acquireTime) ||
      (receipt.uid !== null && current.metadata.uid !== receipt.uid)
    )
      return failure("Cannot release another incarnation's Lease");
    const now = this.#time();
    if (now === null)
      return failure("Lease clock discontinuity; release not authorized");
    const spec = {
      ...current.spec,
      holderIdentity: "",
      renewTime: new Date(now.wall).toISOString(),
    };
    const nonce = randomUUID();
    const write = await this.#request(commissionId, "PUT", {
      ...current,
      metadata: {
        ...current.metadata,
        annotations: { ...current.metadata.annotations, [requestKey]: nonce },
      },
      spec,
    });
    if (!write.ok) return write;
    const confirmed = this.#resource(commissionId, write.value);
    if (!confirmed.ok) return confirmed;
    if (
      !sameSpec(confirmed.value.spec, spec) ||
      confirmed.value.metadata.annotations[requestKey] !== nonce ||
      confirmed.value.metadata.uid !== current.metadata.uid ||
      confirmed.value.metadata.resourceVersion ===
        current.metadata.resourceVersion
    )
      return failure("Lease release CAS was not confirmed");
    return { ok: true, value: undefined };
  }

  async stop(): Promise<readonly ProviderResult<void>[]> {
    this.#stopped = true;
    return Promise.all(
      [...this.#receipts.keys()].map((id) => this.release(id)),
    );
  }

  #time(): { wall: number; mono: number } | null {
    const time = { wall: this.#now(), mono: this.#mono() };
    if (
      !Number.isSafeInteger(time.wall) ||
      time.wall < 0 ||
      !Number.isFinite(time.mono) ||
      (this.#lastTime !== undefined &&
        (time.mono < this.#lastTime.mono ||
          Math.abs(
            time.wall - this.#lastTime.wall - (time.mono - this.#lastTime.mono),
          ) > this.#skew))
    )
      this.#clockFailed = true;
    this.#lastTime = time;
    return this.#clockFailed ? null : time;
  }

  #resource(
    commissionId: string,
    input: unknown,
  ): ProviderResult<LeaseResource> {
    const parsed = resourceSchema.safeParse(input);
    const now = this.#time();
    if (!parsed.success || now === null)
      return failure("Invalid Lease resource or unsafe clock");
    const r = parsed.data;
    const acquire = timestamp(r.spec.acquireTime),
      renew = timestamp(r.spec.renewTime);
    if (
      r.metadata.name !== leaseName(commissionId) ||
      r.metadata.namespace !== this.#config.namespace ||
      r.metadata.deletionTimestamp ||
      r.metadata.annotations[commissionKey] !== commissionId ||
      r.metadata.annotations[contractKey] !== "v1" ||
      acquire === null ||
      renew === null ||
      acquire > renew ||
      renew > now.wall + this.#skew
    )
      return failure(
        "Lease resource identity, contract or timestamps are invalid",
      );
    return { ok: true, value: r };
  }

  async #request(
    commissionId: string,
    method: "GET" | "POST" | "PUT",
    body?: unknown,
  ): Promise<ProviderResult<unknown>> {
    try {
      const token = this.#config.bearerToken().trim();
      if (!token || this.#time() === null)
        return failure("Lease credential or clock unavailable");
      const path = `apis/coordination.k8s.io/v1/namespaces/${encodeURIComponent(this.#config.namespace)}/leases${method === "POST" ? "" : `/${leaseName(commissionId)}`}`;
      const response = await fetch(new URL(path, this.#base), {
        method,
        cache: "no-store",
        redirect: "error",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(this.#config.caCertificate === undefined
          ? {}
          : { tls: { ca: this.#config.caCertificate } }),
        signal: AbortSignal.timeout(this.#timeout),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return {
          ok: false,
          error: {
            kind: [401, 403].includes(response.status)
              ? "rejected"
              : "unavailable",
            message: `Kubernetes Lease HTTP ${response.status}`,
          },
        };
      }
      const serverTime = Date.parse(response.headers.get("date") ?? "");
      const time = this.#time();
      if (
        time === null ||
        !Number.isFinite(serverTime) ||
        Math.abs(time.wall - serverTime) > this.#skew + 1000
      ) {
        await response.body?.cancel();
        return failure(
          "Lease server Date is missing or outside clock-skew bounds",
        );
      }
      const reader = response.body?.getReader();
      if (reader === undefined) return failure("Lease response has no body");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > 1024 * 1024) {
            await reader.cancel();
            return failure("Lease response exceeds size bound");
          }
          chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }
      return {
        ok: true,
        value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
      };
    } catch {
      return failure(
        "Lease transport, credential, timeout or JSON response unavailable",
      );
    }
  }
}

export function leaseName(commissionId: string): string {
  return `anvil-commission-${createHash("sha256").update(commissionId).digest("hex").slice(0, 40)}`;
}
function timestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) &&
    Number.isSafeInteger(parsed)
    ? parsed
    : null;
}
function sameSpec(a: LeaseResource["spec"], b: LeaseResource["spec"]): boolean {
  return (
    a.holderIdentity === b.holderIdentity &&
    a.leaseTransitions === b.leaseTransitions &&
    a.leaseDurationSeconds === b.leaseDurationSeconds &&
    sameTime(a.acquireTime, b.acquireTime) &&
    sameTime(a.renewTime, b.renewTime)
  );
}
function sameTime(a: string, b: string): boolean {
  // Kubernetes MicroTime reserializes millisecond input with six fractional
  // digits. Compare instants without discarding the last three microseconds.
  const micros = (s: string) =>
    (/\.(\d{1,6})Z$/.exec(s)?.[1] ?? "").padEnd(6, "0").slice(3);
  return (
    timestamp(a) !== null &&
    timestamp(a) === timestamp(b) &&
    micros(a) === micros(b)
  );
}
function failure<T = never>(message: string): ProviderResult<T> {
  return { ok: false, error: { kind: "unavailable", message } };
}
