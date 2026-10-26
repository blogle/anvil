# ADR-001: TypeScript end-to-end and Bun-first implementation

Status: Accepted architecture direction, 2026-10-20.
Scope: Anvil implementation. Approved Campaign, Commission, evidence and authority semantics are unchanged.
Priority: Short development feedback loops and rapid convergence over premature runtime optimization.

## Decision
1. **TypeScript end-to-end.** Implement anvild (domain, decisions, reconciliation, state, API/MCP and adapters), web UI and OpenCode plugin in TypeScript. Maintain independent process/security boundaries even while sharing the language. A Rust rewrite of stabilized daemon internals MAY be reconsidered later on concrete evidence, but v2 SHALL NOT start with a split-language stack.
2. **Bun first; Node fast fallback.** Use pinned Bun for install, local development, tests and daemon runtime. At the first material, reproducible Bun-specific compatibility or packaging friction, move the affected daemon to Node rather than diverting substantial time into runtime debugging. Avoid unnecessary Bun-specific dependencies in the domain and contracts packages. Isolate runtime-specific SQLite and server integrations so fallback is bounded. Do not require two runtimes to be tested continuously before a problem warrants fallback.
3. **Single-executable packaging is a target, not a prerequisite.** Try Bun build --compile for a minimal production OCI image that does not need a separately installed Bun executable. The compiled artifact EMBEDS a copy of the Bun runtime; it is not runtime-independent or a Node binary. Validate assets, migrations, SQLite and API/MCP integration within the first implementation vertical slice. A normal Bun or Node image is an acceptable fallback if compiling slows development or delivery.
4. **Web: React + Vite + TanStack Router/Query + Tailwind + shadcn/ui.** Implement an authenticated operational SPA rather than a second full-stack server. Use TanStack Router for typed navigation and TanStack Query for remote server-state caching and invalidation; use ordinary React state for local UI concerns. Use accessible shadcn/ui primitives and Tailwind with design tokens preserving the selected Ledger brown/stone/wheat look. Avoid hand-rolled routing, DOM manipulation, async data caching and component primitives.
5. **No Next.js initially.** Next.js is viable but its SSR/RSC/Server Actions and extra server boundary do not solve an established Anvil requirement. The authoritative application/controller already runs in anvild. Reconsider only if concrete SSR, hosting or UX needs emerge; do not introduce another independent mutation authority in a web framework.
6. **HTTP and database adapters.** Prefer Hono for small API routing and middleware, not for domain workflows. Share explicit request/response contracts and runtime validation via Zod or equivalent. The MCP adapter and HTTP handlers invoke the same authorized application operations. Continue with SQLite single-active-controller, versioned checked-in migrations and deployment backup/restore discipline; Drizzle ORM/Kit is the provisional schema/migration choice. Prefer node:sqlite when pinned versions support it across runtimes; otherwise bun:sqlite is fine behind a small replaceable driver adapter. Do not build a generic database abstraction framework.
7. **Domain conventions.** Model states, Operations, Decisions, outcomes and errors with discriminated unions and exhaustiveness checks (ts-pattern or never). Enable strict TS, noUncheckedIndexedAccess and exactOptionalPropertyTypes. Forbid casual any and unchecked type assertions. Validate incoming external/provider/database data at runtime. Keep reconciliation decisions pure and testable; side effects live in separately testable durable Operation/provider adapters.
8. **Project layout.** Use a minimal Bun workspaces monorepo, approximately apps/anvild, apps/web, packages/domain, packages/contracts, packages/integrations and packages/opencode-plugin. These are modular responsibilities, not six independently deployed services; consolidate packages to improve edit/test velocity. Reuse pinned Nix/SDLC and existing shared multi-user Nix daemon/read-only store, agent-sandbox, credential broker, GitHub/Mergify, preview router and Lific surfaces.
9. **Fast loop required.** Use HMR for web, fast Bun target tests and TypeScript checks for focused development, and actual repository SDLC Nix/CI checks before integration. Bundling/transpilation alone does not replace strict type checking. Optimize for agent-driven end-to-end feature edits across domain, API, plugin and UI.

## Rationale
Anvil is a network- and I/O-dominated control plane, not a native compute runtime. Its hardest correctness properties are durable intent, external source-of-truth observation, idempotency, ambiguous-operation recovery, lease ownership, approval and evidence freshness; Rust's ownership rules do not solve these distributed problems automatically. TypeScript simplifies cross-layer agent development and shortens iteration. Strict ADTs, runtime decoding and deterministic failure testing mitigate its weaker type guarantees. Rust remains available later if observed constraints warrant the cost.

## Explicit reconsideration triggers
Material Bun incompatibility; unacceptable production packaging complexity; empirically demonstrated CPU or memory bottlenecks; persistent reliability issues from TypeScript implementation despite appropriate tests; or new UI requirements that genuinely need server rendering.

## Reference documentation
- Bun standalone executables: https://bun.sh/docs/bundler/executables
- Bun Node API compatibility: https://bun.com/docs/runtime/nodejs-compat
- TanStack Router with Vite: https://tanstack.com/router/latest/docs/installation/with-vite
- shadcn/ui with TanStack Router: https://ui.shadcn.com/docs/installation/tanstack-router
- Hono: https://hono.dev/docs/guides/middleware
- Drizzle SQLite adapters: https://orm.drizzle.team/docs/sqlite/get-started-sqlite
- Next.js self-hosting: https://nextjs.org/docs/app/guides/self-hosting
