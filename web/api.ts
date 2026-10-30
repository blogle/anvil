import type { Commission } from "../src/domain";
import type {
  DecisionHistoryEntry,
  projectCommission,
} from "../src/operational";

export type CommissionView = ReturnType<typeof projectCommission>;

export class AnvilApi {
  readonly #token: string;
  readonly #fetch: typeof fetch;
  constructor(token: string, request: typeof fetch = fetch) {
    this.#token = token;
    this.#fetch = request;
  }
  async request<T>(path: string, body?: unknown): Promise<T> {
    const response = await this.#fetch(path, {
      headers: {
        authorization: `Bearer ${this.#token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(body) }),
      cache: "no-store",
    });
    if (!response.ok)
      throw new Error(
        response.status === 401
          ? "Authentication required. Reconnect with an authorized token."
          : `Command or query rejected (HTTP ${response.status}). Refresh authoritative state before retrying.`,
      );
    return (await response.json()) as T;
  }
  async commissions(): Promise<readonly Commission[]> {
    return (
      await this.request<{ commissions: Commission[] }>("/api/commissions")
    ).commissions;
  }
  projection(id: string): Promise<CommissionView> {
    return this.request(
      `/api/commissions/${encodeURIComponent(id)}/projection`,
    );
  }
  async history(id: string): Promise<readonly DecisionHistoryEntry[]> {
    return (
      await this.request<{ history: DecisionHistoryEntry[] }>(
        `/api/commissions/${encodeURIComponent(id)}/history`,
      )
    ).history;
  }
  command(
    id: string,
    command: "hold" | "resume" | "amend",
    body: unknown,
  ): Promise<unknown> {
    return this.request(
      `/api/commissions/${encodeURIComponent(id)}/${command}`,
      body,
    );
  }
}
