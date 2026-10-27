# Repository guidance

- Build the approved TypeScript/Bun application incrementally; keep unresolved provider and deployment contracts explicit and do not claim live acceptance without its separate deployment gate.
- Run `nix develop -c just check` before handoff; it covers formatting, build, lint, and tests.
- Keep generated build output, secrets, and application-specific dependencies out of the repository.
- Apply `skills/software-craft/SKILL.md` to all implementation and review work; make it available to every implementation/review agent.
