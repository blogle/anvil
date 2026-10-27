# Anvil pre-1.0 rewrite

The `v2` branch name is historical; Anvil remains a pre-1.0, 0.x rewrite track rather than a SemVer 2.0 release.

The local-first TypeScript slice currently contains the Commission reconciliation domain and restart-safe SQLite intent/Operation storage. HTTP/MCP, provider adapters, and the operational UI remain later implementation checkpoints; live sandbox and delivery acceptance has a separate authorized deployment gate. The incumbent `main` implementation remains the parity baseline until the rewrite exceeds its capabilities and reliability.

Run `nix develop -c just check` for the pinned Bun, TypeScript, SQLite, Rust scaffold, and Nix checks. Bun development dependencies use `package.json` and `bun.lock`; `package-lock.json` feeds the offline Nix TypeScript check. SDLC standardizes CI and release automation. Project intent and unresolved decisions live in [`docs/index.md`](docs/index.md). Fieldnotes documentation is available through `just docs`.
