# ANVIL-49: Preact + signals migration

## Migration plan

- Port the current-main Sessions UI and interactions to Preact components with `@preact/signals` state.
- Build static assets with Vite and npm using the committed lockfile; use `npm ci` for reproducible local verification.
- Serve a deterministic packaged static asset directory from `anvild`, preserving direct SPA/session routes and runtime configurability.
- Add DOM/browser regressions for stable keyed rows, interaction retention, routing, mobile behavior, and packaged asset serving.
- Add canonical Just frontend build/test targets and include frontend verification in `just check`; integrate the asset derivation into Nix and image packaging.

## Explicit non-goals

- No SSR, production Node/Vite server, TypeScript migration, or alternate state framework.
- No visual redesign or manual DOM reconciliation compatibility layer.
- No porting/merging of open UI tickets PRs #24, #26–#31; preserve current main behavior only.
- No Branch/PR cards, Files, Activity, OpenCode deep-link changes, or ANVIL-44 IA changes unless already on current main.
