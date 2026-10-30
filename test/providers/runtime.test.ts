import { expect, test } from "bun:test";
import { createProviderPort } from "../../src/providers/runtime";
import { epoch, proposal } from "../support/fixtures";

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
