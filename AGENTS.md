# Repository guidance

- Keep this repository a small Rust scaffold until the design in `spec.md` answers its open questions.
- Run `nix develop -c just check` before handoff; it covers formatting, build, lint, and tests.
- Keep generated build output, secrets, and application-specific dependencies out of the repository.
