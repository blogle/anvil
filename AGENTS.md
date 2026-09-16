# Repository guidance

- Keep shared domain logic in `crates/anvil-core`; service crates should depend on it rather than duplicate validation.
- Run `cargo fmt --check`, the workspace clippy command, and the relevant tests before handing off changes.
- Keep changes focused and do not commit generated build output or secrets.
