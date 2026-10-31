import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, lstatSync } from "node:fs";
import { z } from "zod";
import type { WorkerGitCapabilityScope } from "../application";
import type { GitHubAppBroker } from "./github-app";
import { parseGitHubRepository } from "./github-app";

const capabilityKind = "anvil-git-worker";
const maximumCapabilityBytes = 4_096;
const maximumRequestBytes = 16 * 1024;

const signedClaimsSchema = z
  .object({
    kind: z.literal(capabilityKind),
    commissionId: z.string().min(1).max(128),
    assignmentId: z.string().min(1).max(128),
    attemptId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(128),
    workspaceId: z.string().min(1).max(128),
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    targetRef: z.string().min(1).max(255),
    controllerId: z.string().min(1).max(128),
    ownerEpoch: z.number().int().positive(),
    specificationGeneration: z.number().int().positive(),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
  })
  .strict();

export type SignedWorkerGitCapability = WorkerGitCapabilityScope &
  Readonly<{ issuedAt: number; expiresAt: number }>;

export class WorkerGitCapabilitySigner {
  readonly #secret: Uint8Array;
  readonly #maximumTtlSeconds: number;

  constructor(secret: string, maximumTtlSeconds = 300) {
    const bytes = Buffer.from(secret);
    if (bytes.byteLength < 32)
      throw new Error("Worker Git capability secret must be at least 32 bytes");
    if (!Number.isSafeInteger(maximumTtlSeconds) || maximumTtlSeconds < 1)
      throw new Error("Worker Git capability TTL must be a positive integer");
    this.#secret = bytes;
    this.#maximumTtlSeconds = maximumTtlSeconds;
  }

  mint(
    scope: WorkerGitCapabilityScope,
    now: number,
    ttlSeconds: number,
  ): string {
    if (
      !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(ttlSeconds) ||
      ttlSeconds < 1 ||
      ttlSeconds > this.#maximumTtlSeconds ||
      !validTargetRef(scope.targetRef)
    )
      throw new Error("Worker Git capability scope or expiry is invalid");
    const claims = signedClaimsSchema.safeParse({
      kind: capabilityKind,
      ...scope,
      specificationGeneration: scope.specificationGeneration ?? 1,
      issuedAt: now,
      expiresAt: now + ttlSeconds * 1_000,
    });
    if (!claims.success)
      throw new Error("Worker Git capability scope is invalid");
    const payload = Buffer.from(JSON.stringify(claims.data)).toString(
      "base64url",
    );
    const signature = this.#signature(payload).toString("base64url");
    return `${payload}.${signature}`;
  }

  verify(token: string, now: number): SignedWorkerGitCapability | null {
    if (token.length === 0 || token.length > maximumCapabilityBytes)
      return null;
    const [payload, encodedSignature, extra] = token.split(".");
    if (
      payload === undefined ||
      encodedSignature === undefined ||
      extra !== undefined
    )
      return null;
    let providedSignature: Buffer;
    let decoded: Buffer;
    try {
      providedSignature = Buffer.from(encodedSignature, "base64url");
      decoded = Buffer.from(payload, "base64url");
    } catch {
      return null;
    }
    const expectedSignature = this.#signature(payload);
    if (
      providedSignature.byteLength !== expectedSignature.byteLength ||
      !timingSafeEqual(providedSignature, expectedSignature)
    )
      return null;
    let input: unknown;
    try {
      input = JSON.parse(decoded.toString("utf8")) as unknown;
    } catch {
      return null;
    }
    const parsed = signedClaimsSchema.safeParse(input);
    if (!parsed.success) return null;
    const claims = parsed.data;
    if (
      !Number.isSafeInteger(now) ||
      claims.issuedAt > now ||
      claims.expiresAt <= now ||
      claims.expiresAt - claims.issuedAt > this.#maximumTtlSeconds * 1_000 ||
      !validTargetRef(claims.targetRef)
    )
      return null;
    const { kind: _kind, ...scope } = claims;
    return scope;
  }

  #signature(payload: string): Buffer {
    return createHmac("sha256", this.#secret).update(payload).digest();
  }
}

export type WorkerGitCredentialRequest = Readonly<{
  repositoryUrl: string;
  targetRef: string;
}>;

export class WorkerGitCredentialService {
  readonly #signer: WorkerGitCapabilitySigner;
  readonly #github: GitHubAppBroker;
  readonly #authorize: (
    scope: WorkerGitCapabilityScope,
    now: number,
  ) => Promise<boolean>;
  readonly #now: () => number;

  constructor(
    config: Readonly<{
      signer: WorkerGitCapabilitySigner;
      github: GitHubAppBroker;
      authorize: (
        scope: WorkerGitCapabilityScope,
        now: number,
      ) => Promise<boolean>;
      now?: () => number;
    }>,
  ) {
    this.#signer = config.signer;
    this.#github = config.github;
    this.#authorize = config.authorize;
    this.#now = config.now ?? Date.now;
  }

  async handle(request: Request): Promise<Response> {
    if (request.method !== "POST")
      return errorResponse(405, "method_not_allowed");
    const capability = request.headers
      .get("authorization")
      ?.match(/^Bearer ([^\s]+)$/)?.[1];
    const now = this.#now();
    const claims =
      capability === undefined ? null : this.#signer.verify(capability, now);
    if (claims === null)
      return errorResponse(401, "invalid_or_expired_capability");

    let body: unknown;
    try {
      body = JSON.parse(await readBounded(request.body, request.headers));
    } catch {
      return errorResponse(400, "invalid_request");
    }
    const parsed = z
      .object({
        repositoryUrl: z.string().url(),
        targetRef: z.string().min(1).max(255),
      })
      .strict()
      .safeParse(body);
    if (!parsed.success || !validTargetRef(parsed.data.targetRef))
      return errorResponse(400, "invalid_request");
    const repository = parseGitHubRepository(parsed.data.repositoryUrl);
    if (!repository.ok) return errorResponse(403, "capability_scope_mismatch");
    if (
      repository.value.toLowerCase() !== claims.repository.toLowerCase() ||
      parsed.data.targetRef !== claims.targetRef
    )
      return errorResponse(403, "capability_scope_mismatch");

    let authorized: boolean;
    try {
      authorized = await this.#authorize(claims, now);
    } catch {
      return errorResponse(503, "authority_unavailable");
    }
    if (!authorized) return errorResponse(403, "capability_revoked");

    const credential = await this.#github.credential(
      parsed.data.repositoryUrl,
      "git",
    );
    if (!credential.ok)
      return errorResponse(503, "github_credential_unavailable");
    let confirmed: boolean;
    try {
      confirmed = await this.#authorize(claims, this.#now());
    } catch {
      return errorResponse(503, "authority_unavailable");
    }
    const confirmedNow = this.#now();
    if (claims.expiresAt <= confirmedNow || !confirmed)
      return errorResponse(403, "capability_revoked");
    if (
      credential.value.repository.toLowerCase() !==
        claims.repository.toLowerCase() ||
      credential.value.permissions["contents"] !== "write" ||
      credential.value.permissions["pull_requests"] === "write" ||
      credential.value.permissions["workflows"] === "write" ||
      Date.parse(credential.value.expiresAt) <= confirmedNow
    )
      return errorResponse(503, "github_credential_scope_invalid");
    return Response.json({
      token: credential.value.token,
      expiresAt: credential.value.expiresAt,
      repository: credential.value.repository,
    });
  }
}

export async function runGitCredentialHelper(
  action: string | undefined,
  input: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  if (action === "store" || action === "erase") return "";
  if (action !== "get") throw new Error("unsupported Git credential operation");
  const fields = parseCredentialInput(input);
  const protocol = fields.get("protocol");
  const host = fields.get("host");
  if (protocol === undefined || host === undefined)
    throw new Error("Git credential protocol and host are required");
  const path = fields.get("path");
  if (path === undefined) throw new Error("GitHub repository path is invalid");
  let repositoryUrl: string;
  if (protocol === "https" && host === "github.com") {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(path))
      throw new Error("GitHub repository path is invalid");
    repositoryUrl = `https://github.com/${path.replace(/\.git$/i, "")}`;
  } else if (protocol === "http" && isLoopbackHost(host)) {
    const fixtureRepositoryUrl = requiredEnvironment(
      environment,
      "ANVIL_GIT_FIXTURE_REPOSITORY_URL",
    );
    const fixture = parseGitHubRepository(fixtureRepositoryUrl);
    const fixturePath = fixture.ok ? `git/${fixture.value}.git` : "";
    if (!fixture.ok || path.toLowerCase() !== fixturePath.toLowerCase())
      throw new Error("Loopback Git fixture repository path is invalid");
    repositoryUrl = fixtureRepositoryUrl;
  } else {
    throw new Error("only HTTPS github.com credentials are supported");
  }
  const repository = parseGitHubRepository(repositoryUrl);
  if (!repository.ok) throw new Error("GitHub repository URL is invalid");
  const endpoint = requiredEnvironment(environment, "ANVIL_GIT_CREDENTIAL_URL");
  const endpointUrl = new URL(endpoint);
  if (
    (endpointUrl.protocol !== "https:" &&
      !(
        endpointUrl.protocol === "http:" && isLoopbackHost(endpointUrl.host)
      )) ||
    endpointUrl.username ||
    endpointUrl.password ||
    endpointUrl.search ||
    endpointUrl.hash ||
    endpointUrl.pathname !== "/v1/git/credentials"
  )
    throw new Error(
      "Git credential endpoint must be HTTPS (HTTP only for loopback), with no credentials/query/fragment",
    );
  const capabilityPath = requiredEnvironment(
    environment,
    "ANVIL_GIT_CAPABILITY_FILE",
  );
  const targetRef = requiredEnvironment(environment, "ANVIL_GIT_TARGET_REF");
  if (!validTargetRef(targetRef))
    throw new Error("authorized Git ref is invalid");
  const info = lstatSync(capabilityPath);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.()
  )
    throw new Error("Git capability file permissions must be 0600 or stricter");
  const capability = readFileSync(capabilityPath, "utf8").trim();
  if (capability.length === 0 || capability.length > maximumCapabilityBytes)
    throw new Error("Git capability file is empty or oversized");

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${capability}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ repositoryUrl, targetRef }),
      signal: AbortSignal.timeout(5_000),
      redirect: "error",
    });
  } catch {
    throw new Error("Anvil Git credential service is unavailable");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Anvil Git credential service rejected request (${response.status})`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(
      await readBounded(response.body, response.headers),
    ) as unknown;
  } catch {
    throw new Error(
      "Anvil Git credential service returned an invalid response",
    );
  }
  const result = z
    .object({
      token: z.string().min(1),
      expiresAt: z.string().datetime(),
      repository: z.string(),
    })
    .strict()
    .safeParse(value);
  if (
    !result.success ||
    result.data.repository.toLowerCase() !== repository.value.toLowerCase()
  )
    throw new Error("Anvil Git credential service returned an invalid scope");
  return `protocol=${protocol}\nhost=${host}\nusername=x-access-token\npassword=${result.data.token}\n\n`;
}

function parseCredentialInput(input: string): ReadonlyMap<string, string> {
  const fields = new Map<string, string>();
  for (const line of input.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0)
      fields.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return fields;
}

function validTargetRef(value: string): boolean {
  return (
    value.startsWith("refs/heads/") &&
    value.length <= 255 &&
    !/[\u0000-\u0020\u007f~^:?*[]\\]/.test(value) &&
    !value.includes("..") &&
    !value.endsWith("/") &&
    !value.endsWith(".")
  );
}

function isLoopbackHost(host: string): boolean {
  try {
    const url = new URL(`http://${host}`);
    return (
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

function requiredEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name];
  if (value === undefined || value.trim().length === 0)
    throw new Error(`${name} is required`);
  return value.trim();
}

async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  headers: Headers,
): Promise<string> {
  const declaredLength = Number(headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumRequestBytes)
    throw new Error("Request is too large");
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumRequestBytes) {
        await reader.cancel();
        throw new Error("Request is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(output);
}

function errorResponse(status: number, error: string): Response {
  return Response.json({ error }, { status });
}
