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

`test/providers/composition.test.ts` runs this composition through the real
`ApplicationService` and SQLite store, with local HTTP fixtures for both
providers and application/store reconstruction between provisioning stages. It
proves only the local protocol path. `src/providers/runtime.ts` composes the
provider clients and `src/main.ts` exposes them behind explicit
`ANVIL_PROVIDER_MODE=configured`; the default remains unavailable. Configured
daemon mode itself has not been run. Git branch publication, verification
initiation, worker credential handoff, safe Session-create recovery and
multi-controller Lease integration remain outstanding. No live API or
Kubernetes calls are part of these tests.
