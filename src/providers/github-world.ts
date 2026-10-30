import type { ProviderFailure, ProviderResult } from "../application";
import type {
  CheckObservation,
  Commission,
  IntegrationObservation,
  Observation,
} from "../domain";
import type { WorldObservationPort } from "./composition";
import { parseGitHubRepository } from "./github-app";
import {
  GitHubDeliveryClient,
  type GitHubPullRequestFact,
} from "./github-delivery";
import { MergifyQueueClient } from "./mergify";

export type GitHubWorldObserverConfig = Readonly<{
  delivery: GitHubDeliveryClient;
  mergify: MergifyQueueClient;
  workBranch: (commission: Commission) => string;
  maxObservationAgeMs: number;
}>;

export class GitHubWorldObserver implements WorldObservationPort {
  readonly #delivery: GitHubDeliveryClient;
  readonly #mergify: MergifyQueueClient;
  readonly #workBranch: (commission: Commission) => string;
  readonly #maxObservationAgeMs: number;

  constructor(config: GitHubWorldObserverConfig) {
    if (
      !Number.isSafeInteger(config.maxObservationAgeMs) ||
      config.maxObservationAgeMs < 1
    )
      throw new Error("GitHub observation age must be a positive integer");
    this.#delivery = config.delivery;
    this.#mergify = config.mergify;
    this.#workBranch = config.workBranch;
    this.#maxObservationAgeMs = config.maxObservationAgeMs;
  }

  async observe(
    commission: Commission,
    observedAt: number,
  ): Promise<ProviderResult<Omit<Observation, "execution">>> {
    const now = observedAt;
    const expiresAt = now + this.#maxObservationAgeMs;
    const repository = parseGitHubRepository(commission.repository);
    if (!repository.ok)
      return {
        ok: false,
        error: {
          kind: "rejected",
          message: repository.error.diagnostic.message,
        },
      };
    const branchName = this.#workBranch(commission);
    const branch = await this.#delivery.branch(
      commission.repository,
      branchName,
    );
    if (!branch.ok && branch.error.kind !== "not_found")
      return { ok: false, error: deliveryFailure(branch.error) };

    const candidateRevision = branch.ok ? branch.value.revision : null;
    let checks: CheckObservation | null = null;
    if (candidateRevision !== null) {
      const result = await this.#delivery.requiredChecksForCandidate(
        commission.repository,
        commission.integrationTarget,
        candidateRevision,
        now,
        expiresAt,
      );
      if (!result.ok)
        return { ok: false, error: deliveryFailure(result.error) };
      checks = result.value;
    }

    const integration = await this.#integration(
      commission,
      repository.value,
      branchName,
      now,
      expiresAt,
    );
    if (!integration.ok) return integration;

    return {
      ok: true,
      value: {
        candidateRevision,
        candidateObservedAt: now,
        candidateExpiresAt: expiresAt,
        candidateSource: "github-branch-rest",
        checks,
        integration: integration.value,
        workerClaims: [],
        independentReviews: [],
      },
    };
  }

  async #integration(
    commission: Commission,
    repository: string,
    workBranch: string,
    observedAt: number,
    expiresAt: number,
  ): Promise<ProviderResult<IntegrationObservation>> {
    let fact: GitHubPullRequestFact;
    if (commission.registeredPullRequestId !== null) {
      const parsed = parseRegisteredPullRequest(
        commission.registeredPullRequestId,
        repository,
      );
      if (!parsed.ok)
        return {
          ok: false,
          error: { kind: "rejected", message: parsed.error },
        };
      const pullRequest = await this.#delivery.pullRequest(
        commission.repository,
        parsed.value,
      );
      if (!pullRequest.ok) {
        if (pullRequest.error.kind === "not_found")
          return { ok: true, value: { kind: "none" } };
        return { ok: false, error: deliveryFailure(pullRequest.error) };
      }
      fact = pullRequest.value;
    } else {
      const pullRequest = await this.#delivery.findPullRequestByHead(
        commission.repository,
        workBranch,
        commission.integrationTarget,
      );
      if (!pullRequest.ok)
        return { ok: false, error: deliveryFailure(pullRequest.error) };
      if (pullRequest.value === null)
        return { ok: true, value: { kind: "none" } };
      fact = pullRequest.value;
    }

    if (
      fact.repository.toLowerCase() !== repository.toLowerCase() ||
      fact.baseRef !== commission.integrationTarget
    ) {
      return {
        ok: false,
        error: {
          kind: "rejected",
          message:
            "Registered pull request repository or target differs from Commission authority",
        },
      };
    }
    const providerIdentity = fact.url;
    if (fact.state === "merged")
      return {
        ok: true,
        value: {
          kind: "merged",
          revision: fact.headSha,
          providerIdentity,
          repository: commission.repository,
          target: fact.baseRef,
          observedAt,
          expiresAt,
          source: "github-pull-request-rest",
        },
      };
    if (fact.state === "closed") {
      return {
        ok: false,
        error: {
          kind: "unavailable",
          message:
            "Registered pull request is closed without an authoritative merge",
        },
      };
    }
    const queue = await this.#mergify.pullRequestQueue(
      commission.repository,
      fact.number,
    );
    if (!queue.ok) return { ok: false, error: mergifyFailure(queue.error) };
    const queueActive = queue.value !== null;
    return {
      ok: true,
      value: {
        kind: queueActive ? "queued" : "pr_open",
        revision: fact.headSha,
        providerIdentity,
        repository: commission.repository,
        target: fact.baseRef,
        observedAt,
        expiresAt,
        source: queueActive ? "mergify-queue-rest" : "github-pull-request-rest",
      },
    };
  }
}

function parseRegisteredPullRequest(
  identity: string,
  expectedRepository: string,
): { ok: true; value: number } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(identity);
  } catch {
    return {
      ok: false,
      error: "Registered pull request identity is malformed",
    };
  }
  const parts = url.pathname.split("/").filter((part) => part.length > 0);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    parts.length !== 4 ||
    parts[2] !== "pull" ||
    `${parts[0]}/${parts[1]}`.toLowerCase() !==
      expectedRepository.toLowerCase() ||
    !/^\d+$/.test(parts[3]!)
  ) {
    return {
      ok: false,
      error:
        "Registered pull request identity is not in the approved repository",
    };
  }
  return { ok: true, value: Number(parts[3]) };
}

function deliveryFailure(error: {
  kind: string;
  message: string;
}): ProviderFailure {
  return error.kind === "credentials" || error.kind === "rejected"
    ? { kind: "rejected", message: error.message }
    : { kind: "unavailable", message: error.message };
}

function mergifyFailure(error: {
  kind: string;
  message: string;
}): ProviderFailure {
  return error.kind === "credentials"
    ? { kind: "rejected", message: error.message }
    : { kind: "unavailable", message: error.message };
}
