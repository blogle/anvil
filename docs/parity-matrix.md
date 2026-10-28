# Incumbent parity and cutover protection

Baseline inspected read-only from `origin/main` at
`b55f9b0ecbf89309832c6dcdc9a615cbc4e15f8b`. This matrix compares the contract
in `docs/first-slice-contract.md` with concrete incumbent paths and the rewrite.
It is a development gap inventory, not an independent cutover assessment.

| Capability | Incumbent evidence (`origin/main`) | Rewrite evidence | Assessment |
|---|---|---|---|
| Durable control-plane process and HTTP | `crates/anvild/src/main.rs`, `crates/anvild/src/lib.rs`, `crates/anvild/src/store.rs`; service initialization, routes, durable SQLite-backed sessions/tasks. | `src/main.ts`, `src/daemon.ts`, `src/persistence/sqlite.ts`; local process restart and HTTP tests in `test/daemon-process.test.ts`, `test/daemon.test.ts`. | Rewrite now boots and persists basic Commission state; provider unavailable, no Campaign aggregate or incumbent route coverage. Incumbent ahead. |
| MCP | `crates/anvil-mcp/src/main.rs`; Streamable HTTP facade, tools for sessions, batches, attempts, status, activity, steering, and operations. | `src/daemon.ts`, MCP endpoint/tools; `test/daemon.test.ts` protocol initialize/tools/list and shared durable command test. | Rewrite supports initial Commission tools only; no full parity of task/session/activity/campaign surface. Incumbent ahead. |
| Pure domain and reconciliation | `crates/anvil-core/src/lib.rs`, `crates/anvil-reconcile/src/lib.rs`, `crates/anvild/src/store/scheduler.rs`; typed core/task reconciliation with fixture/reference behavior. | `src/domain.ts`; `test/domain-core.test.ts` seeded fast-check model and G01–G07 cases. | Commission-specific model implemented locally; no demonstrated feature/reliability superiority. |
| Durable Operations and restart | `crates/anvild/src/store.rs`, `crates/anvild/src/store/scheduler.rs`; durable task/session state, request ids, operation handling, migration fixtures. | `src/persistence/sqlite.ts`; `test/store.test.ts` SQL reopen, CAS, ambiguous outcome, retry authorization tests. | Narrow local Operation journal proven; full crash matrix and external remote recovery parity remain incomplete. |
| Agent sandbox and Workspace | `crates/anvild/src/lib.rs` (`KubeSandboxApi`), `crates/anvild/src/local.rs` (`LocalSandboxApi`), `k8s/base/*`, vendored agent-sandbox v1.0.2 contract. | Local Agent Sandbox V1beta1 resource client `src/providers/agent-sandbox.ts` and protocol fixture `test/providers/agent-sandbox.test.ts`; not composed into daemon, not exercised against a cluster. | Incumbent has actual local and Kubernetes-backed lifecycles; rewrite has only the local HTTP contract client. Live controller, Workspace/storage, auth/RBAC, and upgrade continuity remain unverified. |
| OpenCode execution, sessions, watchdog | `crates/anvild/src/lib.rs` `OpenCode` client, message/run/status/activity routes and recovery; `crates/anvild/src/local.rs` starts real local OpenCode workers. | No OpenCode adapter, turn state, watchdog, context handoff, or safe active interruption. | Incumbent materially ahead. |
| Git/GitHub/credential scope | `crates/anvild/src/github.rs` App token broker, capability-bound repository/session credential, least-privilege profiles; `crates/anvild/src/lib.rs` PR/credential integration. | No GitHub adapter or credential broker; current daemon has one bearer-authenticated configured principal. | Incumbent materially ahead; rewrite worker/controller credential separation absent. |
| CI/Mergify and delivery | `docs/deterministic-task-reconciler.md`, `docs/reconciler-integration-research.md`, `crates/anvil-reconcile/fixtures/*`, GitHub and delivery references in `crates/anvild/src/lib.rs`. | Fake checks/integration only in `test/support/fake-world.ts`; G03 identity validation in `src/domain.ts`. | Core policy handles local observations; real CI/Mergify polling and queue/merge adapters absent. |
| UI | `web/src/*`, `web/index.html`, `web/state.test.js`, `docs/frontend-implementation.md`; real API-backed session list/detail/files/activity controls. | Static mockups in `docs/review-mockups.html`; no runtime UI. | Incumbent has operational session UI; rewrite missing required Campaign/Commission Ledger UI. |
| Preview routing | `crates/anvild/src/lib.rs`, sandbox router deployment and preview routes documented in `docs/api.md` and `docs/architecture.md`. | No preview gateway/URL support. | Incumbent capability not present in rewrite. |
| Declarative build/deployment and shared Nix | `nix/images.nix`, `nix/sandbox.nix`, `k8s/base/*`, `runtime/nix-daemon-entrypoint`, `docs/nix-shared-volume-ownership.md`. | Bun/Nix dev and CI only in `flake.nix`; no app image/deployment interface. | Rewrite toolchain is locally reproducible; deployment/runtime absent. |
| Security, observability, cost | `crates/anvild/src/github.rs`, capability signer, scoped token tests, structured service diagnostics, activity state/read projections in `crates/anvild/src/lib.rs`; inspect complete configuration/telemetry contracts before equivalence claims. | Bearer token HTTP auth, SQLite evidence/outcome; no multi-principal identity, structured operational metrics, usage accounting projections or cost estimates. | Incumbent has broader security/runtime telemetry; rewrite incomplete. Cost parity not yet evidenced either way. |

## Cutover rule

This evidence does not justify moving Anvil development to the rewrite. No
capability/reliability comparison currently shows the rewrite matching or
materially exceeding the incumbent. Keep `main` as the parity baseline until an
independent review of this matrix, runnable comparative scenarios, and all
required local acceptance obligations support a stronger conclusion.
