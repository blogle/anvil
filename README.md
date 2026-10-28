# Anvil pre-1.0 rewrite

The `v2` branch name is historical; Anvil remains a pre-1.0, 0.x rewrite track rather than a SemVer 2.0 release.

The local-first TypeScript slice is a functional Commission reconciliation core with SQLite persistence and a deterministic local provider harness. HTTP/MCP and the operational UI remain later implementation checkpoints; live sandbox and delivery acceptance has a separate authorized deployment gate. The incumbent `main` implementation remains the parity baseline until the rewrite exceeds its capabilities and reliability.

Run `nix develop -c just check` for the pinned Bun-only fast path. `bun.lock` is the sole JavaScript lock authority; `bun.nix` is generated from it and checked by the Nix dependency derivation. `just ci-check` and `just ci-verify` run the higher-fidelity Nix/SDLC checks. Project intent and unresolved decisions live in [`docs/index.md`](docs/index.md). Fieldnotes documentation is available through `just docs`.
