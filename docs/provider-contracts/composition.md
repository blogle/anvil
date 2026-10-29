# Provider composition checkpoint

`src/providers/composition.ts` implements the `ProviderPort` boundary for the
initial runtime sequence using the locally tested `AgentSandboxClient` and
`OpenCodeAdapter`. `ApplicationService` persists each prepared Operation before
dispatch. The provisioning resource name and OpenCode Session ID are retained as
the external identities of their successful Operations; the next reconciliation
reconstructs those bindings from the SQLite Operation journal instead of
replaying provider calls or relying on process memory.

The ordered local flow is `provision_sandbox` → `create_session` → `continue`.
Sandbox create ambiguity is resolved only by reobserving the same Commission
and complete desired-spec hash. A lost OpenCode Session-create acknowledgement
remains unknown because the pinned V2 create contract does not expose a
caller-selected idempotent Session identity; it is not automatically replayed.
OpenCode turn dispatch uses deterministic message identity plus message
inspection, never assuming that a repeated message ID is exactly-once.
For `continue` and `repair`, the directive requests explicit
`ANVIL_EVIDENCE <obligation-id> <candidate-sha>: <claim>` lines. Composition
accepts only completed assistant text for an approved obligation whose stated
SHA matches the observed Candidate, as submitted worker evidence attributed to
the OpenCode Session. Old-SHA reports are ignored. It is never independent
review or delivery acceptance.

After a worker publishes its Candidate branch, the controller observes its
immutable SHA from GitHub. Before creating/finding a PR, composition rereads that
branch and rejects a changed SHA; the resulting PR must report the same head
SHA, worker branch, and approved target. The controller does not push commits.
`verify` is a read-only observation bound to the Operation's Candidate SHA. The
observer combines effective branch rules, classic branch-protection contexts,
Check Runs, and legacy commit statuses. It distinguishes missing, pending,
failing, passing and unknown required evidence; only exact-context, exact-SHA
success can pass, while skipped/neutral and incomplete evidence remain unknown.
The stable required-evidence identity is recorded in the Operation and
reobserved after an ambiguous acknowledgement; it does not trigger CI. An
unconfigured or unavailable required-check policy fails closed. Mergify queue
health is observed separately from source-PR checks.

`test/providers/composition.test.ts` runs this composition through the real
`ApplicationService` and SQLite store, with local HTTP fixtures for providers,
application/store reconstruction, failing-CI repair and changed Candidate,
pending/pass checks, PR, queue and merge. It proves only the local protocol
path. `src/providers/runtime.ts` composes the
provider clients and `src/main.ts` exposes them behind explicit
`ANVIL_PROVIDER_MODE=configured`; the default remains unavailable. Configured
daemon mode has process-level watchdog tests, but not yet the full delivery
lifecycle. The Git-purpose App token is repository-scoped and contents-only but
is not wired to a worker or bound to an Assignment. Worker Git credential
handoff/publication, configured-daemon delivery trace, safe Session-create recovery and multi-controller Lease
integration remain outstanding. No live API or Kubernetes calls are part of
these tests.
