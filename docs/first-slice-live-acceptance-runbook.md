# First-slice live acceptance runbook (prepared; not authorized for execution)

This runbook prepares the evidence boundary for FS-15. It is **not** approval to
deploy. The implementation worker must not access addrspace/Kubernetes, run
`kubectl`/Helm, operate kind/k3d, modify dotfiles, or touch the incumbent
production `anvil` namespace. Execution requires a separately authorized
dotfiles operator and an independent acceptance reviewer.

## Required authority and isolation

Before execution, the independent operator records:

1. Explicit approval for one isolated test namespace and its expiry/cleanup
   window.
2. The dotfiles PR and merged commit that declare all resources, secret
   references, images by digest, storage, ingress/preview, Nix daemon, and
   agent-sandbox controller compatibility.
3. A reviewed before/after inventory proving the existing production `anvil`
   namespace and its resources are not targeted or modified.
4. The GitHub App installation, repository, branch rules, required CI checks,
   Mergify policy, OpenCode profile, and worker-vs-controller credential
   permissions for the test Commission.
5. An identified independent reviewer and the approved FS-01–FS-14 local
   evidence ledger revision to use as test input.

Any missing authority, production namespace impact, unbounded credential,
unreviewed image/secret, or ambiguous target stops the run before deployment.

## Execution sequence

1. **Deploy declaratively.** The dotfiles operator applies the authorized
   dotfiles change to the isolated namespace only. Record the deployment commit,
   image digests, health/readiness results, allocated Workspace/PVC identities,
   service endpoints, and secret names (never secret values).
2. **Verify isolation and readiness.** Independently inspect namespace labels,
   service accounts/RBAC, network policy, ingress/preview access, agent-sandbox
   controller readiness, shared Nix daemon/store ownership, read-only worker
   mounts, and that the production namespace inventory is unchanged.
3. **Create one bounded Commission.** Record approved objective/specification
   generation, repository, work branch, integration target, obligations,
   required review policy, budget, controller Lease identity, and registered PR
   identity. Confirm the Assignment's GitHub credential is repository-scoped
   and cannot obtain controller/App credentials.
4. **Exercise autonomous work.** Through the normal authenticated API/MCP/UI,
   admit the Commission and let Anvil provision its Sandbox/Workspace, bind the
   OpenCode Session, dispatch one authorized instruction, observe Candidate and
   CI, repair a deliberately seeded local failure, and report obligation
   evidence. Capture the full durable Decision/Operation IDs and matching
   provider observations without copying transcripts or credentials.
5. **Exercise delivery.** Confirm the tested immutable Candidate SHA matches
   the registered repository, branch, PR, and target. Observe configured CI
   required checks, Mergify queue state, and final authoritative merge. Green
   checks, an open/queued PR, a same-SHA foreign PR, or worker report alone must
   not conclude the Commission.
6. **Exercise interruption and recovery.** In a separately approved test
   window, interrupt/restart the daemon after prepared intent, after provider
   submission, after a remote side effect before acknowledgement, while an
   operation is ambiguous, during safe retry, and after outcome persistence.
   Transfer the Lease to a successor. Verify successor reobservation does not
   replay the predecessor's turn, and stale controller writes are rejected.
7. **Close and clean up.** Verify Commission evidence and operation history;
   record provider IDs, final merged SHA, status of each configured acceptance
   obligation, errors/unknown outcomes, cost/usage sources, and independent
   reviewer result. The operator then removes only the isolated test resources
   through the authorized dotfiles workflow and verifies the production
   inventory remains unchanged.

## Required evidence packet

- Authorizing decision, dotfiles PR/commit, namespace identifier, and
  deployment resource/image digest inventory.
- Pre/post production namespace inventory diff proving no production change.
- Redacted health/readiness, authenticated API/MCP, and UI test outputs.
- Commission/Assignment/Attempt/Lease IDs, specification generation, budget
  before/after, Candidate SHA, repository/branch/PR/target IDs, check-run IDs,
  and Mergify/merge evidence.
- Operation failpoint timeline with dispatch count, original logical ID,
  restart point, reobservation result, retry authorization evidence, and final
  outcome. Include at least one adversarial unknown/foreign-identity case.
- Worker/controller credential-scope proof, secret-reference inventory with
  values redacted, and independent reviewer findings/approval.
- Cleanup result, final isolated namespace inventory, and production
  non-interference confirmation.

Until those separately authorized actions are completed and independently
reviewed, ledger status remains `FS-15: BLOCKED_EXTERNAL`. The runbook itself is
preparatory documentation, not external acceptance evidence.
