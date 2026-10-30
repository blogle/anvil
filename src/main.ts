import { ApplicationService } from "./application";
import { createDaemonApp, startReconciliationLoop } from "./daemon";
import type { Policy } from "./domain";
import { CommissionStore } from "./persistence/sqlite";
import { readFileSync } from "node:fs";
import { GitHubAppBroker } from "./providers/github-app";
import {
  WorkerGitCapabilitySigner,
  WorkerGitCredentialService,
} from "./providers/git-credentials";
import {
  createControllerAuthority,
  createProviderPort,
  workBranchFor,
} from "./providers/runtime";

const bearerToken = process.env["ANVIL_API_TOKEN"];
const databasePath = process.env["ANVIL_DATABASE"] ?? "./anvil.sqlite";
const operatorId = process.env["ANVIL_OPERATOR_ID"] ?? "local-operator";
const reconciliationIntervalMs = Number(
  process.env["ANVIL_RECONCILE_INTERVAL_MS"] ?? "5000",
);
if (bearerToken === undefined || bearerToken.length < 32) {
  throw new Error("ANVIL_API_TOKEN must contain at least 32 characters");
}
if (
  !Number.isSafeInteger(reconciliationIntervalMs) ||
  reconciliationIntervalMs < 250 ||
  reconciliationIntervalMs > 60_000
)
  throw new Error(
    "ANVIL_RECONCILE_INTERVAL_MS must be 250..60000 milliseconds",
  );

const policy: Policy = {
  maxObservationAgeMs: 60_000,
  repeatedToolFailureThreshold: 3,
  activeTurnStuckAfterMs: 5 * 60_000,
  runtimeProvisioning: true,
};

let githubBroker: GitHubAppBroker | undefined;
const provider = createProviderPort(process.env, (broker) => {
  githubBroker = broker;
});
const store = new CommissionStore(databasePath);
const authority = createControllerAuthority(process.env, store);
const { lease, controllerId } = authority;
const application = new ApplicationService(
  store,
  lease,
  provider,
  { approve: async ({ principalId }) => principalId === operatorId },
  controllerId,
  policy,
  Date.now,
);
let gitCredentialService: WorkerGitCredentialService | undefined;
if ((process.env["ANVIL_PROVIDER_MODE"] ?? "unavailable") === "configured") {
  const capabilitySecretPath = process.env["ANVIL_GIT_CAPABILITY_SECRET_FILE"];
  if (capabilitySecretPath === undefined || githubBroker === undefined)
    throw new Error(
      "Configured provider mode requires the Git capability secret and GitHub App broker",
    );
  let capabilitySecret: string;
  try {
    capabilitySecret = readFileSync(capabilitySecretPath, "utf8").trim();
  } catch {
    throw new Error("ANVIL_GIT_CAPABILITY_SECRET_FILE could not be read");
  }
  const signer = new WorkerGitCapabilitySigner(capabilitySecret, 300);
  gitCredentialService = new WorkerGitCredentialService({
    signer,
    github: githubBroker,
    authorize: async (scope, now) => {
      const commission = store.get(scope.commissionId);
      if (commission === null) return false;
      return application.authorizeWorkerGitCapability(
        scope,
        `refs/heads/${workBranchFor(commission)}`,
        now,
      );
    },
  });
}
const app = createDaemonApp({
  application,
  store,
  config: { bearerToken, principalId: operatorId },
  policy,
  ...(gitCredentialService === undefined ? {} : { gitCredentialService }),
  ...(process.env["ANVIL_UI_DIRECTORY"] === undefined
    ? {}
    : { uiDirectory: process.env["ANVIL_UI_DIRECTORY"] }),
});
const port = Number(process.env["PORT"] ?? "8080");
const server = Bun.serve({ port, fetch: app.fetch });
const reconciler = startReconciliationLoop(application, store, {
  intervalMs: reconciliationIntervalMs,
  onResult: (commissionId, error) => {
    const detail =
      error instanceof Error
        ? { name: error.name, message: error.message }
        : error;
    console.error(
      JSON.stringify({
        event: "reconcile_unavailable",
        commissionId,
        error: detail,
      }),
    );
  },
});

console.log(JSON.stringify({ event: "daemon_started", port, databasePath }));
const shutdown = async () => {
  await reconciler.stop();
  server.stop(true);
  await authority.stop();
  store.close();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
