# Repository guidance

- Keep shared domain logic in `crates/anvil-core`; service crates should depend on it rather than duplicate validation.
- Run `cargo fmt --check`, the workspace clippy command, and the relevant tests before handing off changes.
- Use `just build` (`cargo build --workspace`) to build development binaries; the Nix dev shell seeds dependencies for this workspace-wide feature set. Package-only builds (`cargo build -p ...`) may recompile dependencies with different features.
- Keep changes focused and do not commit generated build output or secrets.
- Follow the installed `sdlc` skill for lifecycle, CI, and release work. Add `.changes/<topic>.json` fragments only for externally meaningful, release-worthy changes; fragments use `type`, `semver`, and `summary`. This project is experimental: do not declare major releases (`semver: major`).
- Maintain shared agent guidance with `just skills` and `just skills-update`. The skill source is pinned to the SDLC commit in `flake.lock`; the official Skills CLI is independently pinned by the Nix dev shell. Do not overwrite `.agents/anvil/SKILL.md` or add unrelated skills.
