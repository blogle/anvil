# Anvil pre-1.0 rewrite

The `v2` branch name is historical; Anvil remains a pre-1.0, 0.x rewrite track rather than a SemVer 2.0 release.

The TypeScript slice includes a functional Commission reconciliation core, SQLite persistence, an authenticated Bun HTTP/MCP daemon, and local HTTP-contract clients for OpenCode V2, GitHub App/REST, Agent Sandbox, and Mergify. A provider-composition fixture drives the initial Sandbox→Session→instruction sequence through the real ApplicationService and SQLite journal. The daemon executable still uses an explicitly unavailable provider until production configuration and full provider composition are complete; local fixtures are not live integration. The operational UI and declarative image remain later checkpoints, and live acceptance has a separate authorized deployment gate. The incumbent `main` implementation remains the parity baseline until the rewrite exceeds its capabilities and reliability.

Run `nix develop -c just check` for the pinned Bun-only fast path. `bun.lock` is the sole JavaScript lock authority; `bun.nix` is generated from it and checked by the Nix dependency derivation. `just ci-check` and `just ci-verify` run the higher-fidelity Nix/SDLC checks. Project intent and unresolved decisions live in [`docs/index.md`](docs/index.md). Fieldnotes documentation is available through `just docs`.

See [`docs/local-daemon.md`](docs/local-daemon.md) for local HTTP/MCP startup and contract details.

The separately authorized live-acceptance preparation (not execution approval) is documented in [`docs/first-slice-live-acceptance-runbook.md`](docs/first-slice-live-acceptance-runbook.md).
