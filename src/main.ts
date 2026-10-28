import { ApplicationService } from "./application";
import { createDaemonApp, startReconciliationLoop } from "./daemon";
import type { LeasePort, ProviderPort, ProviderResult } from "./application";
import type { Operation, OperationOutcome, Policy } from "./domain";
import { CommissionStore } from "./persistence/sqlite";

const bearerToken = process.env["ANVIL_API_TOKEN"];
const databasePath = process.env["ANVIL_DATABASE"] ?? "./anvil.sqlite";
const controllerId =
  process.env["ANVIL_CONTROLLER_ID"] ?? "anvil-local-controller";
const operatorId = process.env["ANVIL_OPERATOR_ID"] ?? "local-operator";
if (bearerToken === undefined || bearerToken.length < 32) {
  throw new Error("ANVIL_API_TOKEN must contain at least 32 characters");
}

const policy: Policy = {
  maxObservationAgeMs: 60_000,
  repeatedToolFailureThreshold: 3,
};

const lease: LeasePort = {
  async current(commissionId, requestedController, now) {
    if (requestedController !== controllerId)
      return {
        ok: false,
        error: { kind: "unavailable", message: "local controller mismatch" },
      };
    return {
      ok: true,
      value: {
        owner: { controllerId, epoch: 1 },
        resourceVersion: `local:${commissionId}:1`,
        observedAt: now,
        validUntil: now + 60_000,
      },
    };
  },
};

const provider: ProviderPort = {
  async observe(): Promise<ProviderResult<never>> {
    return {
      ok: false,
      error: {
        kind: "unavailable",
        message: "No external provider adapter is configured",
      },
    };
  },
  async dispatch(
    _operation: Operation,
  ): Promise<ProviderResult<Exclude<OperationOutcome, { kind: "prepared" }>>> {
    return {
      ok: false,
      error: { kind: "unavailable", message: "No provider adapter configured" },
    };
  },
  async inspectOperation(): Promise<ProviderResult<OperationOutcome | null>> {
    return { ok: true, value: null };
  },
};
const store = new CommissionStore(databasePath);
const application = new ApplicationService(
  store,
  lease,
  provider,
  { approve: async ({ principalId }) => principalId === operatorId },
  controllerId,
  policy,
);
const app = createDaemonApp({
  application,
  store,
  config: { bearerToken, principalId: operatorId },
  policy,
});
const port = Number(process.env["PORT"] ?? "8080");
const server = Bun.serve({ port, fetch: app.fetch });
const reconciler = startReconciliationLoop(application, store, {
  intervalMs: Number(process.env["ANVIL_RECONCILE_INTERVAL_MS"] ?? "1000"),
  onResult: (commissionId, error) =>
    console.error(
      JSON.stringify({ event: "reconcile_unavailable", commissionId, error }),
    ),
});

console.log(JSON.stringify({ event: "daemon_started", port, databasePath }));
const shutdown = async () => {
  await reconciler.stop();
  server.stop(true);
  store.close();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
