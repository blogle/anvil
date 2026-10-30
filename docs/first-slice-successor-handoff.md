# Successor local-slice handoff

## Outcome and source boundary

**BLOCKED_OR_EXHAUSTED — session execution budget exhausted, local work remains.**
This is a published implementation checkpoint, not `LOCAL_SLICE_READY`, independent
acceptance, or a request to execute deployment. The approved FS contract is unchanged.

The successor work branch is `anvil/anvil-first-slice-completion-58824672`, starting
from PR #123's recorded and fetched head
`f6723b79d5a938a86c6770660969a1298abde148`. First successor increment `5945dc5`
revalidates Lease authority across provider I/O. The operational Ledger increment
is the next commit containing this document; resolve its full SHA from Git/PR.
The predecessor branch and PR remain preserved. Implementation PRs target `v2`.

Read `first-slice-acceptance.md` for executed evidence and limitations, and run:

```sh
nix develop -c just check
nix develop -c just ci-check
nix develop -c just ci-verify
nix run .#sdlc -- install --check
nix build .#ui .#daemon .#checks.x86_64-linux.daemonSmoke --no-link -L
```

`ci-check` is expected to fail at the preserved `sandboxImageGate`; do not disable
it or describe the CI as green. The fast suite and Nix verify pass at this
checkpoint. The package smoke executes Bun, static UI serving, authentication,
SQLite schema v5 and process restart; the component test executes real commands.
Neither is browser/visual acceptance or independent semantic review.

## Per-obligation residual work

| FS | Current local evidence | Work still required for complete local verification |
|---|---|---|
| 01 | Locked Bun/Nix installs, generated-lock negative, format/type/tests and pinned verify executed. | Clean-clone replay at published successor SHA; complete SDLC/GitHub review. Aggregate flake check is red on FS-13. |
| 02 | Pure domain, frozen input, no-op SQL/version cases, projection gaps reuse domain evidence policy. | Exhaustive source/decision review with independent assessment. |
| 03 | Governed generation amendments, wrong actor/forgery/CAS and terminal cases; UI stale amendment denial. | Authority-freshness coverage beyond tested generation/principal cases; command attribution/audit. |
| 04 | Durable Operation identity, restart/lost-ack/local provider lifecycle tests; submission-precondition regressions. | Real process-kill failpoints at every write/dispatch boundary and randomized crash ordering; governed resolution of invalidated prepared intent. |
| 05 | Successor/stale-owner and new I/O-boundary tests preserve immutable Operation owner and no replay. | Actual Kubernetes Lease adapter and daemon wiring, exclusive Workspace writer, independent verifier snapshot. The current main-process Lease is local-only. |
| 06 | Persistent usage and bounded budgets; held prepared instruction cannot execute until resumed; final reserved instruction allowed at exact limit. | Randomized nonproductive/restart traces; deadline/takeover combination; invalidated-intent recovery. |
| 07 | Candidate/criterion/spec/PR/target identity and required-check fail-closed cases; explicit provenance in UI. | Complete independent evidence/freshness/invalidation matrix and reviewed required-check contract. |
| 08 | Configured daemon drives local delivery with real Git publication, CI repair/waits, restart and lost PR ack recovery. | Actual Sandbox helper/capability bootstrap, broader context/tool-boundary/event loss/reorder/restart traces. |
| 09 | 105-test fast suite and Nix verify, real SQLite/Bun child/local HTTP/Git lifecycle. | Multiprocess randomized failure pyramid and independently specified stronger reference invariants. |
| 10 | Real adapter implementations exercised against local protocol-compatible endpoints; Git helper and scoped broker tests. | Actual helper/capability bootstrap; provider compatibility; explicit worker repository-wide-token risk; verifier/Workspace isolation. |
| 11 | HTTP/MCP commands and shared durable projection/history; authenticated packaged-daemon startup/restart. | Campaign/Assignment/Findings/steering command completeness, durable command audit, Kubernetes Lease wiring. |
| 12 | Real authenticated Ledger and component hold/resume/amend evidence; compiled UI served by packaged daemon. | Full Campaigns/dependencies, review/diff/Findings, serialized steering, external actual links, browser screenshots/accessibility/visual acceptance. |
| 13 | Nix daemon/UI packages and worker image; package startup/assets/migration/restart smoke. | Daemon/UI OCI artifact/digests, narrow overlayable Kubernetes base, read-only-container startup, safe shared-Nix preseed/order/authorization, complete artifact/security review. Hard failing gate remains. |
| 14 | Grounded read-only incumbent inventory and partial parity matrix. | Refresh all stale matrix rows, execute comparative scenarios, complete independent source/reliability review. No cutover supported. |
| 15 | Prepared runbook only. | **BLOCKED_EXTERNAL**: separately authorized dotfiles-managed isolated deployment and independent execution/review. |

## Next authorized engineering milestones

1. Close end-to-end worker capability/helper handoff, with fail-closed transport
   policy and real local Sandbox bootstrap. Implement actual Lease coordination;
   do not promote the current local Lease stub to deployment evidence.
2. Finish governed Assignment steering serialized with autonomous dispatch and
   complete Campaign/Findings/review projections; extend Ledger with real links and
   browser evidence. The current Campaign screen deliberately only groups IDs.
3. Finish the shared-Nix contract as one complete startup/security boundary.
   Signature enforcement is not Nix protocol read-only authorization: predecessor
   `derivation add` finding remains failed. Preserve the negative tests.
4. Package reviewed immutable images and Kubernetes interface, run the full crash
   matrix/parity/review, then assemble the separately executable acceptance packet.

These are local engineering obligations, not requests for routine operator
decisions. No Kubernetes/dotfiles credentials are needed to continue them.

## K8S_ACCEPTANCE_REQUEST: NOT_EXECUTABLE

No deployment authorization is requested at this checkpoint. Material local gates
fail; inventing image digests or manifests would not produce an executable handoff.
Before converting this section into an executable request, record all of:

- exact reviewed source/PR and passing FS-01–FS-14 evidence;
- daemon/UI and worker OCI manifest digests and registry locations, with content
  and non-root read-only-rootfs process tests;
- namespace-specific declarative manifests/overlay and isolated service accounts,
  namespaced Sandbox/Lease RBAC, ingress/auth and egress/network assumptions;
- Secret **names/keys only** for operator auth, capability signing, GitHub App,
  OpenCode/model and sandbox profiles; tested worker/controller separation;
- SQLite persistent state/single-writer strategy and backups; Workspace PVCs;
  shared-Nix store/database exclusive owner, approved socket/build authorization,
  complete closure seeding before Pod startup, init ordering and GC roots;
- health/readiness/ports, compatible agent-sandbox/OpenCode revisions, external
  preview/session endpoints and required GitHub CI/Mergify policies;
- approved isolated failure-injection timeline, independent reviewer, evidence
  capture, production non-interference checks and declarative cleanup/expiry.

Only after those fields are concrete should an independently authorized dotfiles
operator be asked to execute the isolated namespace runbook. FS-15 remains
`BLOCKED_EXTERNAL`. The dormant dotfiles prep branch and `docs/plans` migration
remain untouched/unqueued; no deployment, merge, release or cutover is authorized.
