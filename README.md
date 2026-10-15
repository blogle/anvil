# Anvil v2

Clean Rust development scaffold for the next Anvil design.

Use `nix develop -c just check` for the baseline validation. Project intent and unresolved decisions live in [`spec.md`](spec.md).

This branch evaluates the unreleased SDLC API at `de40fc00bc632b7acd0b0ba5de1242f1af827a9f`; replace it with a matching tagged release before promotion to `anvil-v2/main`. Crane currently declares no `nixpkgs` input, so the README's `crane.inputs.nixpkgs.follows` example is not applied here; adding it would be an invalid override.
