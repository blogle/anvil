import { createHash } from "node:crypto";
import type { ProviderResult } from "../application";
import type { Commission, Operation } from "../domain";
import { workerBootstrapTtlMs } from "../domain";
import { WorkerGitCapabilitySigner } from "./git-credentials";
import { parseGitHubRepository } from "./github-app";

export type WorkerBootstrapConfig = Readonly<{
  signer: WorkerGitCapabilitySigner;
  credentialUrl: string;
  repositoryDirectory: string;
  privateDirectory: string;
  imageHelper: string;
  targetRef: (c: Commission) => string;
}>;
export type BootstrapHttp = (
  path: string,
  method: "GET" | "POST",
  body?: string,
  raw?: boolean,
) => Promise<ProviderResult<unknown>>;

/** Uses pinned OpenCode 2.0.32 shell/fs APIs. Secret bytes travel only in the
 * raw fs.write body, never in a shell command, model prompt, receipt or journal. */
export class WorkerBootstrap {
  readonly #config: WorkerBootstrapConfig;
  constructor(config: WorkerBootstrapConfig) {
    for (const p of [
      config.repositoryDirectory,
      config.privateDirectory,
      config.imageHelper,
    ])
      if (!/^\/[A-Za-z0-9_./-]+$/.test(p) || p.split("/").includes(".."))
        throw new Error("Worker paths must be explicit safe absolute paths");
    if (
      config.privateDirectory === config.repositoryDirectory ||
      config.privateDirectory.startsWith(`${config.repositoryDirectory}/`)
    )
      throw new Error(
        "Worker private state must be outside the repository checkout",
      );
    const endpoint = new URL(config.credentialUrl);
    if (
      (endpoint.protocol !== "https:" &&
        !(
          endpoint.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
        )) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      endpoint.pathname !== "/v1/git/credentials"
    )
      throw new Error(
        "Worker credential URL must be trusted HTTPS (HTTP only for loopback fixtures)",
      );
    this.#config = config;
  }
  receipt(operation: Operation): string {
    return `receipt-${createHash("sha256").update(operation.id).digest("hex").slice(0, 32)}.json`;
  }
  expected(
    c: Commission,
    operation: Operation,
    workspace: string,
    session: string,
  ) {
    return {
      operationId: operation.id,
      commissionId: c.id,
      assignmentId: operation.assignmentId,
      attemptId: operation.attemptId,
      specificationGeneration: operation.specificationGeneration,
      workspaceId: workspace,
      sessionId: session,
      controllerId: operation.controllerId,
      ownerEpoch: operation.ownerEpoch,
      expiresAt: operation.createdAt + workerBootstrapTtlMs,
    };
  }
  async inspect(
    http: BootstrapHttp,
    c: Commission,
    op: Operation,
    workspace: string,
    session: string,
  ): Promise<ProviderResult<boolean>> {
    const result = await http(
      `api/fs/read/${this.receipt(op)}?location[directory]=${encodeURIComponent(this.#config.privateDirectory)}`,
      "GET",
    );
    if (!result.ok) {
      if (
        result.error.kind === "rejected" &&
        result.error.message.includes("404")
      )
        return { ok: true, value: false };
      return result;
    }
    const expected = this.expected(c, op, workspace, session);
    if (
      typeof result.value !== "object" ||
      result.value === null ||
      Object.keys(result.value).length !== Object.keys(expected).length ||
      !Object.entries(expected).every(
        ([key, value]) =>
          (result.value as Record<string, unknown>)[key] === value,
      )
    )
      return bad(
        "Worker bootstrap receipt conflicts with durable identity",
        true,
      );
    return { ok: true, value: true };
  }
  async install(
    http: BootstrapHttp,
    c: Commission,
    op: Operation,
    workspace: string,
    session: string,
    authorize: () => Promise<boolean>,
    now: number,
  ): Promise<ProviderResult<boolean>> {
    if (
      op.target !== `session:${session}` ||
      op.createdAt + workerBootstrapTtlMs <= now + 10000 ||
      c.workspaceWriter?.kind === "unresolved"
    )
      return bad(
        "Worker binding, writer authority or bootstrap expiry is invalid",
      );
    const repository = parseGitHubRepository(c.repository);
    if (!repository.ok) return bad("Invalid worker repository binding");
    const existing = await this.inspect(http, c, op, workspace, session);
    if (!existing.ok || existing.value) return existing;
    const {
      privateDirectory: root,
      repositoryDirectory: repo,
      imageHelper,
    } = this.#config;
    const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    const wrapper = `#!/bin/sh\nexport ANVIL_GIT_CREDENTIAL_URL=${q(this.#config.credentialUrl)}\nexport ANVIL_GIT_CAPABILITY_FILE=${q(`${root}/capability`)}\nexport ANVIL_GIT_TARGET_REF=${q(this.#config.targetRef(c))}\nexec ${q(imageHelper)} "$@"\n`;
    const staged = `${root}/${this.receipt(op)}.cap`;
    const nextHelper = `${root}/${this.receipt(op)}.helper`;
    const nextConfig = `${root}/${this.receipt(op)}.gitconfig`;
    const prepare = [
      "set -eu",
      "umask 077",
      `test -d ${q(repo)}`,
      `test -x ${q(imageHelper)}`,
      `test ! -L ${q(root)}`,
      `if test -e ${q(root)}; then test -d ${q(root)}; test "$(stat -c %u ${q(root)})" = "$(id -u)"; test "$(stat -c %a ${q(root)})" = 700; else mkdir -m 700 ${q(root)}; fi`,
      `test ! -L ${q(staged)}`,
      `test ! -L ${q(nextHelper)}`,
      `: > ${q(staged)}`,
      `chmod 600 ${q(staged)}`,
      `printf %s ${q(wrapper)} > ${q(nextHelper)}`,
      `chmod 700 ${q(nextHelper)}`,
      // Rotation only replaces the capability. A changed helper/ref contract
      // needs an idle, explicitly reconciled runtime upgrade instead.
      `test ! -L ${q(`${root}/helper`)}`,
      `if test -e ${q(`${root}/helper`)}; then cmp ${q(nextHelper)} ${q(`${root}/helper`)}; fi`,
    ].join("\n");
    const parent = root.slice(0, root.lastIndexOf("/")) || "/";
    const parentCheck = `set -eu\ntest ! -L ${q(parent)}\ntest "$(stat -c %u ${q(parent)})" = "$(id -u)"\nchmod 700 ${q(parent)}\n`;
    const prepared = await this.#shell(
      http,
      op,
      "prepare",
      parentCheck + prepare,
      authorize,
    );
    if (!prepared.ok || !prepared.value) return prepared;
    if (!(await authorize()))
      return bad("Worker bootstrap authority changed before capability write");
    const {
      operationId: _id,
      expiresAt: _expires,
      ...scope
    } = this.expected(c, op, workspace, session);
    const capability = this.#config.signer.mint(
      {
        ...scope,
        controllerId: c.owner!.controllerId,
        ownerEpoch: c.owner!.epoch,
        repository: repository.value,
        targetRef: this.#config.targetRef(c),
      },
      op.createdAt,
      workerBootstrapTtlMs / 1000,
    );
    const written = await http(
      `api/experimental/fs/write?path=${encodeURIComponent(staged)}`,
      "POST",
      capability,
      true,
    );
    if (!written.ok) return written;
    const expected = this.expected(c, op, workspace, session);
    const finish = [
      "set -eu",
      "umask 077",
      `test ! -L ${q(staged)}`,
      `test "$(stat -c %a ${q(staged)})" = 600`,
      `test -s ${q(staged)}`,
      `test -x ${q(nextHelper)}`,
      `test ! -L ${q(`${parent}/.gitconfig`)}`,
      `test ! -L ${q(nextConfig)}`,
      `if test -f ${q(`${parent}/.gitconfig`)}; then cp ${q(`${parent}/.gitconfig`)} ${q(nextConfig)}; fi`,
      `git config --file ${q(nextConfig)} --replace-all credential.helper ''`,
      `git config --file ${q(nextConfig)} --add credential.helper ${q(`${root}/helper`)}`,
      `git config --file ${q(nextConfig)} credential.useHttpPath true`,
      `chmod 600 ${q(nextConfig)}`,
      `if test -e ${q(`${root}/helper`)}; then cmp ${q(nextHelper)} ${q(`${root}/helper`)}; rm ${q(nextHelper)} ${q(nextConfig)}; else mv ${q(nextHelper)} ${q(`${root}/helper`)}; mv ${q(nextConfig)} ${q(`${parent}/.gitconfig`)}; fi`,
      // Same-filesystem rename is the rotation linearization point: readers
      // see the complete old or new credential, never a truncated live file.
      `mv ${q(staged)} ${q(`${root}/capability`)}`,
      `printf %s ${q(JSON.stringify(expected))} > ${q(`${root}/${this.receipt(op)}.tmp`)}`,
      `chmod 600 ${q(`${root}/${this.receipt(op)}.tmp`)}`,
      `mv ${q(`${root}/${this.receipt(op)}.tmp`)} ${q(`${root}/${this.receipt(op)}`)}`,
    ].join("\n");
    const finished = await this.#shell(http, op, "finish", finish, authorize);
    if (!finished.ok || !finished.value) return finished;
    return this.inspect(http, c, op, workspace, session);
  }
  async #shell(
    http: BootstrapHttp,
    op: Operation,
    phase: string,
    command: string,
    authorize: () => Promise<boolean>,
  ): Promise<ProviderResult<boolean>> {
    if (!(await authorize()))
      return bad("Worker bootstrap authority changed before shell admission");
    const started = await http(
      "api/shell",
      "POST",
      JSON.stringify({
        command,
        cwd: this.#config.repositoryDirectory,
        timeout: 10000,
        metadata: { anvilOperationId: op.id, phase },
      }),
    );
    if (!started.ok) return started;
    let info = (
      started.value as { data?: { id: string; status: string; exit?: number } }
    ).data;
    if (!info?.id?.startsWith("sh_"))
      return bad("Worker shell acknowledgement has no valid identity", true);
    for (let poll = 0; poll < 50 && info.status === "running"; poll += 1) {
      await Bun.sleep(100);
      const observed = await http(
        `api/shell/${encodeURIComponent(info.id)}`,
        "GET",
      );
      if (!observed.ok) return observed;
      info = (observed.value as { data?: typeof info }).data;
      if (info === undefined)
        return bad("Worker shell observation is invalid", true);
    }
    return info.status === "exited" && info.exit === 0
      ? { ok: true, value: true }
      : bad("Worker bootstrap shell failed or remains unresolved", true);
  }
}
function bad(message: string, ambiguous = false): ProviderResult<never> {
  return {
    ok: false,
    error: { kind: ambiguous ? "acknowledgement_lost" : "rejected", message },
  };
}
