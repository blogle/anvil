import {
  GitHubAppBroker,
  parseGitHubRepository,
  type GitHubBrokerError,
  type GitHubCredentialPurpose,
} from "./github-app";
import type { CheckObservation } from "../domain";

export type GitHubPullRequestFact = Readonly<{
  number: number;
  url: string;
  repository: string;
  state: "open" | "closed" | "merged";
  headSha: string;
  headRef: string;
  baseRef: string;
  observedAt: number;
  source: "github-rest";
}>;

export type GitHubCheckRun = Readonly<{
  id: number;
  name: string;
  headSha: string;
  status: "queued" | "in_progress" | "completed" | "unknown";
  conclusion: string | null;
  detailsUrl: string | null;
  appId: number | null;
}>;

export type GitHubCheckSnapshot = Readonly<{
  revision: string;
  totalCount: number;
  complete: boolean;
  checkRuns: readonly GitHubCheckRun[];
  observedAt: number;
  source: "github-rest";
}>;

export type GitHubBranchFact = Readonly<{
  name: string;
  revision: string;
  observedAt: number;
  source: "github-rest";
}>;

export type GitHubRequiredCheck = Readonly<{
  context: string;
  appId: number | null;
}>;

export type GitHubCommitStatus = Readonly<{
  id: number;
  context: string;
  state: "error" | "failure" | "pending" | "success" | "unknown";
}>;

export type GitHubCommitStatusSnapshot = Readonly<{
  revision: string;
  complete: boolean;
  totalCount: number;
  statuses: readonly GitHubCommitStatus[];
  observedAt: number;
  source: "github-rest";
}>;

export type GitHubDeliveryError = Readonly<{
  kind:
    | "credentials"
    | "not_found"
    | "unavailable"
    | "invalid_response"
    | "conflict"
    | "ambiguous"
    | "rejected";
  message: string;
  upstreamStatus?: number;
  requestId?: string;
}>;

export type GitHubDeliveryResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: GitHubDeliveryError }>;

export type GitHubDeliveryConfig = Readonly<{
  apiUrl?: string;
  timeoutMs?: number;
  now?: () => number;
}>;

export type GitHubPullRequestInput = Readonly<{
  repositoryUrl: string;
  headRef: string;
  baseRef: string;
  title: string;
  body: string;
  draft?: boolean;
}>;

const maximumBodyBytes = 2 * 1024 * 1024;

export class GitHubDeliveryClient {
  readonly #credentials: GitHubAppBroker;
  readonly #apiUrl: URL;
  readonly #timeoutMs: number;
  readonly #now: () => number;

  constructor(credentials: GitHubAppBroker, config: GitHubDeliveryConfig = {}) {
    const apiUrl = new URL(config.apiUrl ?? "https://api.github.com/");
    if (apiUrl.protocol !== "https:" && apiUrl.protocol !== "http:")
      throw new Error("GitHub API URL must use HTTP or HTTPS");
    if (
      apiUrl.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "::1"].includes(apiUrl.hostname)
    ) {
      throw new Error(
        "GitHub API HTTP is permitted only for loopback fixtures",
      );
    }
    apiUrl.pathname = apiUrl.pathname.endsWith("/")
      ? apiUrl.pathname
      : `${apiUrl.pathname}/`;
    this.#credentials = credentials;
    this.#apiUrl = apiUrl;
    this.#timeoutMs = config.timeoutMs ?? 10_000;
    this.#now = config.now ?? Date.now;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1)
      throw new Error("GitHub API timeout must be a positive integer");
  }

  async pullRequest(
    repositoryUrl: string,
    number: number,
  ): Promise<GitHubDeliveryResult<GitHubPullRequestFact>> {
    if (!Number.isSafeInteger(number) || number < 1)
      return {
        ok: false,
        error: {
          kind: "invalid_response",
          message: "Pull request number is invalid",
        },
      };
    const repo = parseGitHubRepository(repositoryUrl);
    if (!repo.ok)
      return {
        ok: false,
        error: {
          kind: "invalid_response",
          message: repo.error.diagnostic.message,
        },
      };
    const result = await this.#get(repositoryUrl, `pulls/${number}`, "gh_read");
    if (!result.ok) return result;
    const data = asRecord(result.value);
    const head = asRecord(data?.["head"]);
    const base = asRecord(data?.["base"]);
    const state = data?.["state"];
    const merged = data?.["merged"];
    const factNumber = data?.["number"];
    const url = data?.["html_url"];
    const headSha = head?.["sha"];
    const headRef = head?.["ref"];
    const baseRef = base?.["ref"];
    if (
      factNumber !== number ||
      typeof url !== "string" ||
      typeof headSha !== "string" ||
      typeof headRef !== "string" ||
      typeof baseRef !== "string" ||
      (state !== "open" && state !== "closed") ||
      typeof merged !== "boolean"
    ) {
      return {
        ok: false,
        error: {
          kind: "invalid_response",
          message: "GitHub pull request response was malformed",
        },
      };
    }
    return {
      ok: true,
      value: {
        number,
        url,
        repository: repo.value,
        state: merged ? "merged" : state,
        headSha,
        headRef,
        baseRef,
        observedAt: this.#now(),
        source: "github-rest",
      },
    };
  }

  async createOrFindPullRequest(
    input: GitHubPullRequestInput,
    authorizeEffect?: () => Promise<boolean>,
  ): Promise<GitHubDeliveryResult<GitHubPullRequestFact>> {
    const repository = parseGitHubRepository(input.repositoryUrl);
    if (!repository.ok)
      return {
        ok: false,
        error: {
          kind: "invalid_response",
          message: repository.error.diagnostic.message,
        },
      };
    if (
      !validGitRef(input.headRef) ||
      !validGitRef(input.baseRef) ||
      input.title.trim().length === 0 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.body)
    ) {
      return {
        ok: false,
        error: {
          kind: "invalid_response",
          message: "Pull request input is invalid",
        },
      };
    }
    const [owner] = repository.value.split("/") as [string, string];
    const head = `${owner}:${input.headRef}`;
    const findExisting = async () => {
      const result = await this.#request(
        input.repositoryUrl,
        `pulls?head=${encodeURIComponent(head)}&state=all&per_page=100`,
        "gh_read",
        "GET",
      );
      if (!result.ok) return result;
      if (!Array.isArray(result.value))
        return {
          ok: false as const,
          error: {
            kind: "invalid_response" as const,
            message: "GitHub pull request search response was malformed",
          },
        };
      const facts: GitHubPullRequestFact[] = [];
      for (const item of result.value) {
        const parsed = parsePullRequestFact(
          item,
          repository.value,
          this.#now(),
        );
        if (!parsed.ok) return parsed;
        if (parsed.value.headRef === input.headRef) facts.push(parsed.value);
      }
      if (facts.length > 1)
        return {
          ok: false as const,
          error: {
            kind: "conflict" as const,
            message: "Multiple pull requests use the registered work branch",
          },
        };
      const existing = facts[0];
      if (existing !== undefined && existing.baseRef !== input.baseRef)
        return {
          ok: false as const,
          error: {
            kind: "conflict" as const,
            message:
              "Existing pull request targets a different integration branch",
          },
        };
      return { ok: true as const, value: existing ?? null };
    };

    const existing = await findExisting();
    if (!existing.ok) return existing;
    if (existing.value !== null) return { ok: true, value: existing.value };
    const created = await this.#request(
      input.repositoryUrl,
      "pulls",
      "gh",
      "POST",
      {
        head,
        base: input.baseRef,
        title: input.title,
        body: input.body,
        draft: input.draft ?? false,
      },
      authorizeEffect,
    );
    if (created.ok) {
      const fact = parsePullRequestFact(
        created.value,
        repository.value,
        this.#now(),
      );
      if (
        fact.ok &&
        fact.value.headRef === input.headRef &&
        fact.value.baseRef === input.baseRef
      ) {
        return fact;
      }
      // A successful write with an invalid response still requires a remote
      // postcondition read before the Operation can be considered complete.
    } else if (
      created.error.kind !== "ambiguous" &&
      created.error.kind !== "conflict"
    ) {
      return created;
    }

    const observed = await findExisting();
    if (!observed.ok) return observed;
    if (observed.value !== null) return { ok: true, value: observed.value };
    const createStatus = created.ok ? undefined : created.error.upstreamStatus;
    return {
      ok: false,
      error: {
        kind: "ambiguous",
        message:
          "Pull request create outcome is not observable; do not replay blindly",
        ...(createStatus === undefined ? {} : { upstreamStatus: createStatus }),
      },
    };
  }

  async findPullRequestByHead(
    repositoryUrl: string,
    headRef: string,
    baseRef: string,
  ): Promise<GitHubDeliveryResult<GitHubPullRequestFact | null>> {
    const repository = parseGitHubRepository(repositoryUrl);
    if (!repository.ok)
      return {
        ok: false,
        error: {
          kind: "invalid_response",
          message: repository.error.diagnostic.message,
        },
      };
    if (!validGitRef(headRef) || !validGitRef(baseRef))
      return {
        ok: false,
        error: {
          kind: "invalid_response",
          message: "Pull request branch is invalid",
        },
      };
    const [owner] = repository.value.split("/") as [string, string];
    const result = await this.#request(
      repositoryUrl,
      `pulls?head=${encodeURIComponent(`${owner}:${headRef}`)}&state=all&per_page=100`,
      "gh_read",
      "GET",
    );
    if (!result.ok) return result;
    if (!Array.isArray(result.value))
      return {
        ok: false,
        error: {
          kind: "invalid_response",
          message: "GitHub pull request search response was malformed",
        },
      };
    const matches: GitHubPullRequestFact[] = [];
    for (const value of result.value) {
      const fact = parsePullRequestFact(value, repository.value, this.#now());
      if (!fact.ok) return fact;
      if (fact.value.headRef === headRef) matches.push(fact.value);
    }
    if (matches.length > 1)
      return {
        ok: false,
        error: {
          kind: "conflict",
          message: "Multiple pull requests use the registered work branch",
        },
      };
    const match = matches[0];
    if (match !== undefined && match.baseRef !== baseRef)
      return {
        ok: false,
        error: {
          kind: "conflict",
          message:
            "Existing pull request targets a different integration branch",
        },
      };
    return { ok: true, value: match ?? null };
  }

  async checkRuns(
    repositoryUrl: string,
    revision: string,
  ): Promise<GitHubDeliveryResult<GitHubCheckSnapshot>> {
    if (revision.length === 0 || /[\u0000-\u0020]/.test(revision))
      return {
        ok: false,
        error: { kind: "invalid_response", message: "Git revision is invalid" },
      };
    const repo = parseGitHubRepository(repositoryUrl);
    if (!repo.ok)
      return {
        ok: false,
        error: {
          kind: "invalid_response",
          message: repo.error.diagnostic.message,
        },
      };
    const result = await this.#get(
      repositoryUrl,
      `commits/${encodeURIComponent(revision)}/check-runs?per_page=100`,
      "gh_read",
    );
    if (!result.ok) return result;
    const data = asRecord(result.value);
    const totalCount = data?.["total_count"];
    const rows = data?.["check_runs"];
    if (
      !Number.isSafeInteger(totalCount) ||
      (totalCount as number) < 0 ||
      !Array.isArray(rows)
    ) {
      return {
        ok: false,
        error: {
          kind: "invalid_response",
          message: "GitHub check-run response was malformed",
        },
      };
    }
    const checkRuns: GitHubCheckRun[] = [];
    for (const row of rows) {
      const item = asRecord(row);
      const id = item?.["id"];
      const name = item?.["name"];
      const headSha = item?.["head_sha"];
      const status = item?.["status"];
      const conclusion = item?.["conclusion"];
      const detailsUrl = item?.["details_url"];
      const application = asRecord(item?.["app"]);
      const appId = item?.["app_id"] ?? application?.["id"] ?? null;
      if (
        !Number.isSafeInteger(id) ||
        typeof name !== "string" ||
        typeof headSha !== "string" ||
        typeof status !== "string" ||
        !(appId === null || Number.isSafeInteger(appId)) ||
        !(conclusion === null || typeof conclusion === "string") ||
        !(detailsUrl === null || typeof detailsUrl === "string")
      ) {
        return {
          ok: false,
          error: {
            kind: "invalid_response",
            message: "GitHub returned a malformed check run",
          },
        };
      }
      checkRuns.push({
        id: id as number,
        name,
        headSha,
        status:
          status === "queued" ||
          status === "in_progress" ||
          status === "completed"
            ? status
            : "unknown",
        conclusion,
        detailsUrl,
        appId: appId as number | null,
      });
    }
    return {
      ok: true,
      value: {
        revision,
        totalCount: totalCount as number,
        complete: (totalCount as number) === checkRuns.length,
        checkRuns,
        observedAt: this.#now(),
        source: "github-rest",
      },
    };
  }

  async branch(
    repositoryUrl: string,
    branchName: string,
  ): Promise<GitHubDeliveryResult<GitHubBranchFact>> {
    if (branchName.length === 0 || /[\u0000-\u001f\u007f]/.test(branchName))
      return {
        ok: false,
        error: {
          kind: "invalid_response",
          message: "Git branch name is invalid",
        },
      };
    const repo = parseGitHubRepository(repositoryUrl);
    if (!repo.ok)
      return {
        ok: false,
        error: {
          kind: "invalid_response",
          message: repo.error.diagnostic.message,
        },
      };
    const result = await this.#get(
      repositoryUrl,
      `branches/${encodeURIComponent(branchName)}`,
      "gh_read",
    );
    if (!result.ok) return result;
    const data = asRecord(result.value);
    const commit = asRecord(data?.["commit"]);
    const name = data?.["name"];
    const revision = commit?.["sha"];
    return typeof name === "string" && typeof revision === "string"
      ? {
          ok: true,
          value: {
            name,
            revision,
            observedAt: this.#now(),
            source: "github-rest",
          },
        }
      : {
          ok: false,
          error: {
            kind: "invalid_response",
            message: "GitHub branch response was malformed",
          },
        };
  }

  async requiredChecksForCandidate(
    repositoryUrl: string,
    targetBranch: string,
    revision: string,
    observedAt: number,
    expiresAt: number,
  ): Promise<GitHubDeliveryResult<CheckObservation>> {
    if (!validGitRef(targetBranch))
      return {
        ok: false,
        error: {
          kind: "invalid_response",
          message: "Required-check target branch is invalid",
        },
      };
    const repository = parseGitHubRepository(repositoryUrl);
    if (!repository.ok)
      return {
        ok: false,
        error: {
          kind: "invalid_response",
          message: repository.error.diagnostic.message,
        },
      };
    const required = await this.#requiredCheckProfile(
      repositoryUrl,
      targetBranch,
    );
    if (!required.ok) return required;
    const checkRuns = await this.checkRuns(repositoryUrl, revision);
    if (!checkRuns.ok) return checkRuns;
    if (checkRuns.value.revision !== revision)
      return {
        ok: false,
        error: {
          kind: "invalid_response",
          message: "GitHub check-run response differs from Candidate SHA",
        },
      };
    const statuses = await this.#commitStatuses(repositoryUrl, revision);
    if (!statuses.ok) return statuses;
    if (statuses.value.revision !== revision)
      return {
        ok: false,
        error: {
          kind: "invalid_response",
          message: "GitHub commit-status response differs from Candidate SHA",
        },
      };
    return {
      ok: true,
      value: evaluateRequiredChecks(
        revision,
        targetBranch,
        required.value,
        checkRuns.value,
        statuses.value,
        observedAt,
        expiresAt,
      ),
    };
  }

  async #requiredCheckProfile(
    repositoryUrl: string,
    targetBranch: string,
  ): Promise<GitHubDeliveryResult<readonly GitHubRequiredCheck[]>> {
    const rules = await this.#get(
      repositoryUrl,
      `rules/branches/${encodeURIComponent(targetBranch)}`,
      "gh_read",
    );
    if (!rules.ok) return rules;
    if (!Array.isArray(rules.value))
      return invalidResponse("GitHub branch-rule response was malformed");
    const required: GitHubRequiredCheck[] = [];
    for (const value of rules.value) {
      const rule = asRecord(value);
      if (rule?.["type"] !== "required_status_checks") continue;
      const parameters = asRecord(rule["parameters"]);
      const checks = parameters?.["required_status_checks"];
      if (!Array.isArray(checks))
        return invalidResponse("GitHub required-status rule was malformed");
      for (const check of checks) {
        const parsed = parseRequiredCheck(check);
        if (!parsed.ok) return parsed;
        required.push(parsed.value);
      }
    }

    const protection = await this.#get(
      repositoryUrl,
      `branches/${encodeURIComponent(targetBranch)}/protection/required_status_checks`,
      "gh_read",
    );
    if (!protection.ok && protection.error.kind !== "not_found")
      return protection;
    if (protection.ok) {
      const data = asRecord(protection.value);
      const contexts = data?.["contexts"];
      const checks = data?.["checks"];
      if (!Array.isArray(contexts) || !Array.isArray(checks))
        return invalidResponse(
          "GitHub required-status protection response was malformed",
        );
      const protectionChecks: GitHubRequiredCheck[] = [];
      for (const value of checks) {
        const parsed = parseRequiredCheck(value);
        if (!parsed.ok) return parsed;
        protectionChecks.push(parsed.value);
      }
      for (const context of contexts) {
        if (typeof context !== "string" || context.trim().length === 0)
          return invalidResponse(
            "GitHub required status context was malformed",
          );
        const appChecks = protectionChecks.filter(
          (check) => check.context === context,
        );
        required.push(
          ...(appChecks.length === 0 ? [{ context, appId: null }] : appChecks),
        );
      }
      required.push(
        ...protectionChecks.filter(
          ({ context }) =>
            !contexts.includes(context) &&
            !required.some((check) => check.context === context),
        ),
      );
    }
    return {
      ok: true,
      value: deduplicateRequiredChecks(required),
    };
  }

  async #commitStatuses(
    repositoryUrl: string,
    revision: string,
  ): Promise<GitHubDeliveryResult<GitHubCommitStatusSnapshot>> {
    const result = await this.#get(
      repositoryUrl,
      `commits/${encodeURIComponent(revision)}/status`,
      "gh_read",
    );
    if (!result.ok) return result;
    const data = asRecord(result.value);
    const sha = data?.["sha"];
    const rows = data?.["statuses"];
    const totalCount = data?.["total_count"];
    if (
      sha !== revision ||
      !Array.isArray(rows) ||
      !Number.isSafeInteger(totalCount) ||
      (totalCount as number) < 0
    )
      return invalidResponse("GitHub commit-status response was malformed");
    const parsedStatuses: GitHubCommitStatus[] = [];
    for (const row of rows) {
      const item = asRecord(row);
      const id = item?.["id"];
      const context = item?.["context"];
      const state = item?.["state"];
      if (
        !Number.isSafeInteger(id) ||
        typeof context !== "string" ||
        typeof state !== "string"
      )
        return invalidResponse("GitHub commit status was malformed");
      parsedStatuses.push({
        id: id as number,
        context,
        state:
          state === "error" ||
          state === "failure" ||
          state === "pending" ||
          state === "success"
            ? state
            : "unknown",
      });
    }
    return {
      ok: true,
      value: {
        revision,
        complete: (totalCount as number) === parsedStatuses.length,
        totalCount: totalCount as number,
        statuses: parsedStatuses,
        observedAt: this.#now(),
        source: "github-rest",
      },
    };
  }

  async #get(
    repositoryUrl: string,
    path: string,
    purpose: GitHubCredentialPurpose,
  ): Promise<GitHubDeliveryResult<unknown>> {
    return this.#request(repositoryUrl, path, purpose, "GET");
  }

  async #request(
    repositoryUrl: string,
    path: string,
    purpose: GitHubCredentialPurpose,
    method: "GET" | "POST",
    body?: unknown,
    authorizeEffect?: () => Promise<boolean>,
  ): Promise<GitHubDeliveryResult<unknown>> {
    const repo = parseGitHubRepository(repositoryUrl);
    if (!repo.ok)
      return {
        ok: false,
        error: {
          kind: "invalid_response",
          message: repo.error.diagnostic.message,
        },
      };
    const credential = await this.#credentials.credential(
      repositoryUrl,
      purpose,
    );
    if (!credential.ok) return credentialError(credential.error);
    if (authorizeEffect !== undefined && !(await authorizeEffect()))
      return {
        ok: false,
        error: {
          kind: "rejected",
          message: "Authority lost before GitHub mutation",
        },
      };
    const [owner, name] = repo.value.split("/") as [string, string];
    const url = new URL(
      `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${path}`,
      this.#apiUrl,
    );
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "anvil-github-observer/0.1",
          "x-github-api-version": "2022-11-28",
          authorization: `Bearer ${credential.value.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      return {
        ok: false,
        error: {
          kind: method === "POST" ? "ambiguous" : "unavailable",
          message:
            method === "POST"
              ? "GitHub write acknowledgement was lost; inspect the postcondition before retry"
              : "GitHub API is unavailable",
        },
      };
    }
    const requestId = cleanHeader(response.headers.get("x-github-request-id"));
    let text: string;
    try {
      text = await readBounded(response, maximumBodyBytes);
    } catch {
      return {
        ok: false,
        error: {
          kind: "unavailable",
          message: "GitHub API response was oversized or unreadable",
          upstreamStatus: response.status,
          ...(requestId === undefined ? {} : { requestId }),
        },
      };
    }
    let value: unknown;
    try {
      value = text === "" ? null : JSON.parse(text);
    } catch {
      return {
        ok: false,
        error: {
          kind: "invalid_response",
          message: "GitHub API returned invalid JSON",
        },
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        error: {
          kind:
            response.status === 404
              ? "not_found"
              : response.status === 401 || response.status === 403
                ? "credentials"
                : method === "POST" &&
                    (response.status === 409 ||
                      response.status === 422 ||
                      response.status >= 500)
                  ? "ambiguous"
                  : method === "POST"
                    ? "rejected"
                    : "unavailable",
          message: `GitHub API returned HTTP ${response.status}`,
          upstreamStatus: response.status,
          ...(requestId === undefined ? {} : { requestId }),
        },
      };
    }
    return { ok: true, value };
  }
}

function parseRequiredCheck(
  value: unknown,
): GitHubDeliveryResult<GitHubRequiredCheck> {
  const item = asRecord(value);
  const context = item?.["context"];
  const appId = item?.["app_id"] ?? item?.["integration_id"] ?? null;
  if (
    typeof context !== "string" ||
    context.trim().length === 0 ||
    !(appId === null || Number.isSafeInteger(appId))
  )
    return invalidResponse("GitHub required-check descriptor was malformed");
  return { ok: true, value: { context, appId: appId as number | null } };
}

function deduplicateRequiredChecks(
  checks: readonly GitHubRequiredCheck[],
): readonly GitHubRequiredCheck[] {
  const unique = new Map<string, GitHubRequiredCheck>();
  for (const check of checks)
    unique.set(`${check.context}\0${check.appId ?? "any"}`, check);
  return [...unique.values()].sort(
    (left, right) =>
      left.context.localeCompare(right.context) ||
      (left.appId ?? -1) - (right.appId ?? -1),
  );
}

function evaluateRequiredChecks(
  revision: string,
  targetBranch: string,
  requiredChecks: readonly GitHubRequiredCheck[],
  checkSnapshot: GitHubCheckSnapshot,
  statusSnapshot: GitHubCommitStatusSnapshot,
  observedAt: number,
  expiresAt: number,
): CheckObservation {
  const evidence = requiredChecks.map((required) => {
    const matchingRuns = checkSnapshot.checkRuns
      .filter(
        (run) =>
          run.headSha === revision &&
          run.name === required.context &&
          (required.appId === null || run.appId === required.appId),
      )
      .sort((left, right) => right.id - left.id);
    const run = matchingRuns[0];
    if (run !== undefined) {
      if (run.status === "queued" || run.status === "in_progress")
        return { context: required.context, state: "pending", id: run.id };
      if (run.status !== "completed" || run.conclusion === null)
        return { context: required.context, state: "unknown", id: run.id };
      if (run.conclusion === "success")
        return { context: required.context, state: "passing", id: run.id };
      if (run.conclusion === "neutral" || run.conclusion === "skipped")
        return { context: required.context, state: "unknown", id: run.id };
      return { context: required.context, state: "failing", id: run.id };
    }
    if (required.appId === null) {
      const matchingStatuses = statusSnapshot.statuses
        .filter((status) => status.context === required.context)
        .sort((left, right) => right.id - left.id);
      const status = matchingStatuses[0];
      if (status !== undefined)
        return {
          context: required.context,
          state:
            status.state === "success"
              ? "passing"
              : status.state === "pending"
                ? "pending"
                : status.state === "failure" || status.state === "error"
                  ? "failing"
                  : "unknown",
          id: status.id,
        };
    }
    return { context: required.context, state: "missing", id: null };
  });
  const failures = evidence.filter(({ state }) => state === "failing");
  const missing = evidence.filter(({ state }) => state === "missing");
  const pending = evidence.filter(({ state }) => state === "pending");
  const unknown = evidence.filter(({ state }) => state === "unknown");
  const incomplete = !checkSnapshot.complete || !statusSnapshot.complete;
  const state =
    requiredChecks.length === 0 ||
    (incomplete && missing.length > 0) ||
    unknown.length > 0
      ? "unknown"
      : failures.length > 0
        ? "failing"
        : missing.length > 0
          ? "missing"
          : pending.length > 0
            ? "pending"
            : "passing";
  const runId = `github-required-checks:${encodeURIComponent(
    JSON.stringify([
      revision,
      targetBranch,
      requiredChecks,
      evidence,
      checkSnapshot.complete,
      statusSnapshot.complete,
    ]),
  )}`;
  return {
    runId,
    revision,
    state,
    failureIds:
      failures.length > 0
        ? failures.map(({ context, id }) => `${context}:${id}`)
        : missing.map(({ context }) => context),
    observedAt,
    expiresAt,
    source: "github-required-status-checks",
  };
}

function invalidResponse<T = never>(message: string): GitHubDeliveryResult<T> {
  return { ok: false, error: { kind: "invalid_response", message } };
}

function credentialError(
  error: GitHubBrokerError,
): GitHubDeliveryResult<never> {
  return {
    ok: false,
    error: {
      kind: error.kind === "repository" ? "invalid_response" : "credentials",
      message: error.diagnostic.message,
      ...(error.diagnostic.upstreamStatus === undefined
        ? {}
        : { upstreamStatus: error.diagnostic.upstreamStatus }),
      ...(error.diagnostic.requestId === undefined
        ? {}
        : { requestId: error.diagnostic.requestId }),
    },
  };
}

function parsePullRequestFact(
  value: unknown,
  repository: string,
  observedAt: number,
): GitHubDeliveryResult<GitHubPullRequestFact> {
  const data = asRecord(value);
  const head = asRecord(data?.["head"]);
  const base = asRecord(data?.["base"]);
  const state = data?.["state"];
  const merged = data?.["merged"];
  const number = data?.["number"];
  const url = data?.["html_url"];
  const headSha = head?.["sha"];
  const headRef = head?.["ref"];
  const baseRef = base?.["ref"];
  if (
    !Number.isSafeInteger(number) ||
    typeof url !== "string" ||
    typeof headSha !== "string" ||
    typeof headRef !== "string" ||
    typeof baseRef !== "string" ||
    (state !== "open" && state !== "closed") ||
    typeof merged !== "boolean"
  ) {
    return {
      ok: false,
      error: {
        kind: "invalid_response",
        message: "GitHub pull request response was malformed",
      },
    };
  }
  return {
    ok: true,
    value: {
      number: number as number,
      url,
      repository,
      state: merged ? "merged" : state,
      headSha,
      headRef,
      baseRef,
      observedAt,
      source: "github-rest",
    },
  };
}

function validGitRef(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    !/[\u0000-\u0020\u007f~^:?*[]\\]/.test(value) &&
    !value.includes("..") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.endsWith(".")
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cleanHeader(value: string | null): string | undefined {
  return value === null
    ? undefined
    : value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 128);
}

async function readBounded(
  response: Response,
  maximum: number,
): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximum)
    throw new Error("GitHub response too large");
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximum) {
        await reader.cancel();
        throw new Error("GitHub response too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(output);
}
