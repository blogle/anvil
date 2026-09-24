# Repository guidance

- Keep shared domain logic in `crates/anvil-core`; service crates should depend on it rather than duplicate validation.
- Run `cargo fmt --check`, the workspace clippy command, and the relevant tests before handing off changes.
- Use `just build` (`cargo build --workspace`) to build development binaries; the Nix dev shell seeds dependencies for this workspace-wide feature set. Package-only builds (`cargo build -p ...`) may recompile dependencies with different features.
- Keep changes focused and do not commit generated build output or secrets.
