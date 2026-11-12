---
name: sdlc
description: Follow the shared SDLC CI, Mergify integration, and release protocol in consuming repositories.
---

# Shared SDLC for consuming repositories

Use this skill when changing CI, build/test contracts, Mergify policy, changelog fragments, or release workflows in a repository that consumes `blogle/sdlc`.

## Ownership and consumer contract

Consumers declare exactly three fields through `sdlc.lib.mkConsumer`:

```nix
ci = {
  check = { fmt = checks.fmt; };
  verify = { tests = checks.tests; };
  publish = { type = "app"; program = "${publishHook}/bin/publish"; };
};
```

`check` and `verify` are named sets of independently buildable Nix derivations. `publish` is an executable Nix app. The flake outputs are `ci.<system>.check`, `ci.<system>.verify`, and `ci.<system>.publish`. Do not add `apps.sdlc-publish`, a package alias, a Just release recipe, a custom CI matrix, or synthetic stage derivations. SDLC owns evaluation, parallel scheduling, Hestia builds/caching, stable status aggregation, protection policy, release orchestration, and receipt validation.

## Nixpkgs channels

Consumers subscribe with `inputs.sdlc.url = "github:blogle/sdlc/v2"`; a separate top-level `nixpkgs` input is unnecessary. SDLC exposes `nixpkgs-latest` (`nixos-unstable`) and `nixpkgs-stable` (the current stable NixOS branch). Use `sdlc.lib.importPackages { system; latest = { config; overlays; }; stable = { config; overlays; }; }` when each package set needs its own options. Other flake inputs may follow `sdlc/nixpkgs-latest` or `sdlc/nixpkgs-stable` when they should share the corresponding locked node.

Anvil's accepted verification scope for this integration is Rust formatting, clippy and workspace tests; frontend tests/build; static checks; local-process E2E; and product image builds. Do not restore Kubernetes acceptance, VM, QEMU, nested OCI, or sandbox lifecycle suites in this lane. Follow-up coverage is tracked separately.

## CI, cache, and protection

Use `nix develop` and the consuming repository's `justfile` for local work. Keep low-latency checks in `ci.check`, full validation in `ci.verify`, and application publication in `ci.publish`. Each Nix check must remain independently buildable and diagnosable.

Hestia is mandatory. Generated pinned callers invoke the shared reusable workflow; default-branch runs warm that repository's cache. Cache misses and evictions affect runtime, not correctness. Hestia is neither a durable artifact store nor cross-repository sharing.

The generated `sdlc / check` is ordinary-PR admission. `sdlc / policy` validates generated adapters against the locked SDLC revision. Those contexts are pinned to GitHub Actions in the default-branch ruleset. `sdlc / verify` runs for Mergify merge candidates and is required by Mergify's queue merge conditions, not as a universal PR-head check. The required `Mergify Merge Protections` context prevents direct merges and is owned by the Mergify app. The separate `sdlc / release-gate` is an App-owned check used only for the rolling release candidate.

Run `nix run .#sdlc -- update` to update the compatible `v2` input's lock and regenerate all pinned callers; it finishes by checking that the callers match the lock. `sdlc install --check` enforces the v2 channel and detects drift in generated callers, Mergify policy, and Renovate configuration. It does not prove live GitHub protection is ready. Enable Mergify Merge Protections in the dashboard, then have an authorized administrator run `sdlc ruleset plan/apply/check --repo OWNER/NAME` against `rulesets/default-branch.json`. Release automation has Administration:read but no ruleset write access. Redacted bypass actors are accepted only with a current admin-created `SDLC_RULESET_ATTESTATION` bound to ruleset ID and `updated_at`.

Mergify admission requires exactly one of `integration:auto` or `integration:review`, successful `sdlc / check`, and the corresponding review condition. The queue requires successful `sdlc / verify` before merging. Labels or manual queue commands do not bypass checks, review requirements, or GitHub protection. Do not upgrade a PR's granted integration authority.

## Changelog and unattended release

Add `.changes/<topic>.json` only for externally meaningful changes. Fragment metadata contains `type`, `semver` (`patch`, `minor`, or `major`), and `summary`. `sdlc changelog check|plan|finalize` validates consumer-local fragments. Release selection is per squash-merged PR, independent of Mergify batching; no fragments means no release.

The generated release callers connect default-branch reconciliation, release-candidate validation, trusted merge, and publication. All release mutations are disabled unless the repository's `SDLC_RELEASE_ACTIVATE` variable is explicitly `true` and the required App credentials and protection are provisioned. Reconciliation produces one replaceable `sdlc/release-next` PR; it never pushes `main`.

The release gate replays the deterministic candidate from its exact source SHA, checks release-App ownership and required statuses, and binds the no-bypass attestation to live protection. The trusted merger rechecks main and the expected candidate head, squash-merges through the GitHub API without a bypass, and reads the actual merge commit SHA. That SHA is passed to publication automatically.

The shared publisher checks out and validates the merged release tree, then resolves and executes `ci.<system>.publish` from that exact consumer revision. The hook receives `SDLC_RELEASE_VERSION`, `SDLC_RELEASE_MERGED_SHA`, `SDLC_RELEASE_SOURCE_SHA`, and `SDLC_RELEASE_RECEIPTS`. Receipts use `source_main_sha`, bind artifact names/digests to the release identity, and are mandatory before GitHub Release completion. Retry against the original merged identity; immutable digest conflicts fail closed. Never publish using the release PR head or a manually substituted current-main SHA.

## Verification and handoff

Run `nix develop -c just check`, `just ci-check`, and relevant verify-stage checks. Use `actionlint` for workflow edits. Verify the pinned generated adapters and ensure changes to SDLC and consumers refer to the same commit. Do not claim hosted merge-candidate verification or cache reuse from an ordinary PR check; cite the exact hosted run that exercised it. Report operator-only dependencies separately from behavior proven by tests.

Never pass private App keys to coding agents or commit secrets. Never recommend `nix --option build-users-group "" develop`.
