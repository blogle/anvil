# Anvil pre-1.0 rewrite

The `v2` branch name is historical; Anvil remains a pre-1.0, 0.x rewrite track rather than a SemVer 2.0 release.

The TypeScript slice includes a functional Commission reconciliation core, SQLite persistence, an authenticated Bun HTTP/MCP daemon, a React Ledger UI, and local HTTP-contract clients for OpenCode V2, GitHub App/REST, Agent Sandbox, and Mergify. A configured-daemon process fixture drives a local Sandbox→Session→Candidate/CI→PR/queue→merge path through the real ApplicationService and SQLite journal, including real local Git publication. The daemon defaults to an unavailable provider; configured mode is not deployment- or multi-controller-accepted. The UI reads durable operational projections and submits governed hold/resume/amend commands; remaining UI and provider gaps are recorded in the [active development plan](docs/plans/active/autonomous-first-slice.md). Nix builds the UI, daemon and a worker OCI image, but the shared-Nix image compatibility gate intentionally fails. Local evidence is not live acceptance. The incumbent `main` implementation remains the parity baseline until the rewrite exceeds its capabilities and reliability.

Run `nix develop -c just check` for the pinned Bun-only fast path. `bun.lock` is the sole JavaScript lock authority; `bun.nix` is generated from it and checked by the Nix dependency derivation. `just ci-check` and `just ci-verify` run the higher-fidelity Nix/SDLC checks. Project intent and unresolved decisions live in [`docs/index.md`](docs/index.md). Fieldnotes documentation is available through `just docs`.

See [`docs/operations.md`](docs/operations.md) for local HTTP/MCP startup and contract details.

The [active ExecPlan](docs/plans/active/autonomous-first-slice.md) owns the campaign criteria, acceptance ledger, parity inventory, remaining work and separately authorized live-acceptance preparation (not execution approval). [PLANS.md](PLANS.md) defines its maintenance and eventual archival process.
