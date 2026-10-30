# Repository guidance

- Start with `docs/index.md` for permanent product, architecture, operations,
  research and UI documentation. Read `PLANS.md` and the relevant plan under
  `docs/plans/active/` before campaign work; the autonomous development campaign
  is `docs/plans/active/autonomous-first-slice.md`.
- Maintain the existing ExecPlan at every coherent checkpoint: preserve approved
  criteria, statuses, evidence, failures, decisions and next actions. Do not create
  ad hoc acceptance/status/handoff pages. Move accepted completed plans with their
  evidence to `docs/plans/completed/` and repair links.

- Build the approved TypeScript/Bun application incrementally; keep unresolved provider and deployment contracts explicit and do not claim live acceptance without its separate deployment gate.
- Run `nix develop -c just check` for formatting, TypeScript checks, and deterministic tests; run `just ci-check` and `just ci-verify` for pinned Nix/SDLC verification.
- Keep generated build output, secrets, and application-specific dependencies out of the repository.
- Apply `skills/software-craft/SKILL.md` to all implementation and review work; make it available to every implementation/review agent.
