# AGENTS.md

Anvil is a control plane and operator loop that drives opencode v2 agents inside
quarantined sandboxes toward merged PRs. This repository (`anvil-next`) is the
rewrite that supersedes the incumbent; it develops on `origin/main` of
`github.com/blogle/anvil`.

## Always-on rules

1. **Read before you build.** [docs/spec.md](docs/spec.md) §3 lists the normative
   MUSTs; [docs/architecture.md](docs/architecture.md) §3 the dependency rules.
   Feature work that violates either is wrong regardless of elegance.
2. **Craft.** Load the `software-craft` skill (`skills/software-craft/SKILL.md`)
   for any implementation work; it governs structure, boundaries, testing, and
   review here.
3. **Normative vs WIP.** Spec §4 sections are quarantined work-in-progress;
   violate them freely once evidence says so. Spec §3 changes only deliberately.
4. **Work lives on the board.** Milestones/issues are tracked on the ANVIL board
   (lific), modules `M1`–`M4`. Do not embed roadmaps in documents.
5. **Changelog.** Release-worthy changes add `.changes/<topic>.json` stubs
   (`type`, `semver`, `summary`). Never edit `CHANGELOG.md` directly.
6. **Verify.** `just ci-check` before declaring work done; never claim a check
   passed that was not run.
7. **Landing & releases.** Work lands via PR with the `integration:auto` label
   through the Mergify queue; `main` receives only checked squash merges.
   Releases wait for milestone completion — the first release (v0.3.0,
   numbering from the incumbent's surviving tags) ships a working M1 loop.

## Commands

- `just docs` — serve this documentation (live reload, fieldnotes)
- `just ci-check` — cheap admission checks
- `just ci-verify` — merge-candidate verification
- `just changelog-check` — validate changelog stubs

## Map

| Path | Content |
| --- | --- |
| [docs/index.md](docs/index.md) | Documentation entry + table of contents |
| [docs/spec.md](docs/spec.md) | Product specification (normative MUSTs) |
| [docs/architecture.md](docs/architecture.md) | Structure, invariants, decisions |
| [docs/research.md](docs/research.md) | Prior-art digests |
| [docs/mockups/](docs/mockups/) | Non-normative UI sketches |
| [skills/software-craft/SKILL.md](skills/software-craft/SKILL.md) | Craft principles |
