import { expect, test } from "bun:test";
import { createProviderPort } from "../../src/providers/runtime";
import { epoch, proposal } from "../support/fixtures";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("daemon provider mode defaults to explicit unavailable without contacting external providers", async () => {
  const provider = createProviderPort({});
  const result = await provider.observe(proposal().commission, epoch, []);
  expect(result).toEqual({
    ok: false,
    error: {
      kind: "unavailable",
      message: "No provider adapter configured",
    },
  });
});

test("configured provider mode fails closed when required adapter settings are incomplete", () => {
  expect(() =>
    createProviderPort({ ANVIL_PROVIDER_MODE: "configured" }),
  ).toThrow("ANVIL_SANDBOX_NAMESPACE is required");
  expect(() =>
    createProviderPort({ ANVIL_PROVIDER_MODE: "unsafe-mode" }),
  ).toThrow("ANVIL_PROVIDER_MODE must be unavailable or configured");
});

test("configured OpenCode cannot silently omit listener authentication or the matching Sandbox Secret reference", () => {
  const directory = mkdtempSync(join(tmpdir(), "anvil-runtime-auth-"));
  try {
    const secret = join(directory, "secret");
    writeFileSync(secret, "fixture-secret-with-at-least-32-bytes", {
      mode: 0o600,
    });
    const env = {
      ANVIL_PROVIDER_MODE: "configured",
      ANVIL_SANDBOX_NAMESPACE: "fixture",
      ANVIL_SANDBOX_IMAGE_DIGEST: `worker@sha256:${"a".repeat(64)}`,
      ANVIL_WORKSPACE_SIZE: "1Gi",
      ANVIL_PROFILE_PVC: "profile",
      ANVIL_NIX_PVC: "nix",
      ANVIL_OPENCODE_URL_TEMPLATE:
        "https://{sandbox}.{namespace}.example.invalid/",
      ANVIL_GITHUB_APP_ID: "app",
      ANVIL_GITHUB_INSTALLATION_ID: "42",
      ANVIL_GITHUB_PRIVATE_KEY_FILE: secret,
      ANVIL_MERGIFY_TOKEN_FILE: secret,
      ANVIL_KUBERNETES_TOKEN_FILE: secret,
    };
    expect(() => createProviderPort(env)).toThrow(
      "ANVIL_OPENCODE_PASSWORD_FILE is required",
    );
    expect(() =>
      createProviderPort({ ...env, ANVIL_OPENCODE_PASSWORD_FILE: secret }),
    ).toThrow("ANVIL_OPENCODE_SECRET_NAME is required");
    expect(() =>
      createProviderPort({
        ...env,
        ANVIL_OPENCODE_PASSWORD_FILE: secret,
        ANVIL_OPENCODE_SECRET_NAME: "opencode",
      }),
    ).toThrow("ANVIL_OPENCODE_SECRET_KEY is required");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
