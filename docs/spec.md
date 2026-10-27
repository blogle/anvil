# Anvil — Domain specification

**Domain specification · draft**

This document defines domain entities, authority boundaries, lifecycle semantics, required invariants, and unresolved implementation contracts.

**Status:** Domain terminology · Acceptance policy provisional · Open decisions

## Domain terminology

| Term | Definition | Boundary |
| --- | --- | --- |
| **Campaign** | An approved engineering objective with a graph of Commissions and their dependencies. May span multiple repositories. | Not an issue tracker or a GitHub project. |
| **Commission** | One independently integrable engineering objective with an authoritative specification, delivery conditions, budget, and one active control authority. | Not an OpenCode task, session, or pull request. |
| **Assignment** | Delegated responsibility, role, and reporting contract for advancing a Commission. | Not synonymous with an execution session. |
| **Attempt** | A bounded execution strategy for an Assignment; may span multiple turns and replacement sessions, and records its terminal disposition. | Context refresh alone does not require a new Attempt. |
| **Workspace** | Recoverable working files and repository checkout, with one authorized mutable writer at a time. | Distinct from the Sandbox provisioning resource. |
| **Candidate** | A code snapshot identified by revision, effective base and dependency revisions, and relevant verification configuration. | A mutable branch reference is insufficient. |
| **Finding** | A typed, source-attributed discrepancy, blocker, or assessment that may warrant a corrective action. | A Finding is not necessarily independently verified. |
| **Evidence** | A durable observation or result with source, subject, time, applicability, and provenance. Its authority depends on the producing system. | An agent's completion declaration is not a passed check. |
| **Decision** | An inspectable, exhaustively typed controller determination with rationale and relevant evidence. | Not a side effect or an unstructured callback. |
| **Operation** | An identified, authorized external mutation with preconditions, outcome tracking, and a recovery procedure. | Stable identifiers do not imply remote exactly-once execution. |

GitHub PRs, CI checks, OpenCode sessions, Lific issues, and Kubernetes resources retain their external identities. Anvil records references and observations rather than conflating them with Anvil-owned entities.

## Lifecycle and decision types

The Commission lifecycle represents Anvil-owned authority. Execution, verification, and integration are separately observed dimensions; no single status value encodes every combination.

```typescript
type CommissionLifecycle =
  | { kind: 'proposed' }
  | { kind: 'admitted' }
  | { kind: 'active' }
  | { kind: 'held'; reason: HoldReason }
  | { kind: 'concluded'; outcome: DeliveryOutcome };

type ExecutionObservation =
  | { kind: 'running'; session: SessionRef }
  | { kind: 'idle'; session: SessionRef }
  | { kind: 'unavailable'; cause: Failure }
  | { kind: 'unknown'; reason: ObservationGap };

type Decision =
  | { kind: 'wait'; condition: WakeCondition }
  | { kind: 'continue'; assignment: AssignmentId }
  | { kind: 'repair'; findings: FindingId[] }
  | { kind: 'refresh_context'; attempt: AttemptId }
  | { kind: 'change_strategy'; reason: FailurePattern }
  | { kind: 'verify'; candidate: CandidateId }
  | { kind: 'integrate'; candidate: CandidateId }
  | { kind: 'hold'; reason: HoldReason }
  | { kind: 'escalate'; blocker: Blocker }
  | { kind: 'conclude'; evidence: DeliveryEvidence };
```

Decision handling must be exhaustive. Unknown or stale observations are distinct from failure and success. Decision authorization checks the latest specification generation, ownership, budgets, and operation preconditions before side effects are submitted.

## Required invariants

1. Only one controller authority may issue mutable instructions for a Commission at a time; competing workers or controller replicas must not issue conflicting writes.
2. A Workspace has at most one active mutable writer. Verification agents use independent snapshots or checkouts.
3. Notifications are wakeup hints. Reconciliation re-observes required external state; dropped or duplicated notifications do not establish or revoke completion.
4. Agent reports, OpenCode todos, and model messages remain self-reported progress. They may inform a next step but cannot independently satisfy acceptance gates.
5. Acceptance evidence is attached to the Candidate revision, relevant dependency versions, and check configuration. Material changes invalidate affected gate results.
6. Implementation workers cannot independently relax or remove configured delivery requirements. Authorized amendments are versioned and may invalidate earlier assessments.
7. External mutations have stable operation identities and ownership. An ambiguous acknowledgement triggers remote inspection or escalation, not an unsafe blind retry.
8. Attempt limits and Commission budgets persist across context refreshes, agent restarts, and controller process restarts.
9. Current status, observations, their freshness, pending actions, decision rationale, and permitted interventions are available through the application API and MCP.

## Controller ownership and recovery

**Design direction adopted · #4.** Anvil persists authoritative intent and external identities. Operational status is reconstructed from the systems that own execution and integration state. A second event history of OpenCode, Kubernetes, GitHub, or Mergify is not required.

### Exclusive controller authority

1. Anvil coordinates active Commission ownership using namespaced Kubernetes `coordination.k8s.io/v1` `Lease` resources. Lease acquisition and renewal use Kubernetes resource-version compare-and-swap semantics. A controller may authorize a Commission mutation only while it holds a valid Lease.
2. The holder must stop authorizing additional operations when renewal or ownership is lost. A successor acquires the Lease and re-observes state before making decisions. An Assignment or Attempt does not receive an independent Lease by default; a Workspace requires separate coordination only if it is independently shareable.
3. A Lease is an ownership signal, not remote-operation fencing. An instruction submitted immediately before Lease expiry may still execute. `metadata.resourceVersion` is not a fencing token that OpenCode or GitHub accepts. Consequential operations also require stable identities, current authorization checks, and remote-result reconciliation.

### Persistent state

| Category | Retained by Anvil |
| --- | --- |
| Authoritative intent | Campaign/Commission specifications and generations, dependencies, acceptance policy, budgets, intervention and authorization decisions. |
| Execution identity | Assignment and Attempt identity, external resource references, recoverable workspace/checkpoint references, and the current instruction identity or sequence. |
| Unresolved mutations | Operation identity, target, authorized generation, precondition, known dispatch/result status, and the information required to re-observe its postcondition. |
| Derived observations | Fetched again from OpenCode, Kubernetes, Git, GitHub/CI, and Mergify. Important externally ephemeral evidence must be retained or referenced durably when its provider retention is insufficient. |

### Operation outcome and recovery

```typescript
type OperationOutcome =
  | { kind: 'prepared' }
  | { kind: 'submitted'; remoteRef?: ExternalRef }
  | { kind: 'observed'; result: ExternalOutcome }
  | { kind: 'rejected'; reason: ExternalFailure }
  | { kind: 'ambiguous'; lastKnown: ExternalObservation };

recover(commission):
  acquire Commission Lease
  read persisted intent and unresolved Operations
  observe referenced external systems
  reconcile each Operation by remote identity or postcondition
  if outcome is ambiguous and retry cannot be proven safe:
    wait for further observation or require intervention
  else:
    recompute the next authorized Decision
```

Recovery uses ordinary reconciliation rather than a separate controller state machine. When an external API supports caller-supplied idempotency keys, Anvil reuses the original identity. When the desired result is observable, Anvil compares actual and desired state. Absence of a resource is not proof that a previously submitted request cannot still complete; non-idempotent operations without reliable observation must not be retried blindly.

### Required failure scenarios

- Controller exits before operation submission, after submission, and after the remote side effect but before local acknowledgement.
- A Lease expires during an active OpenCode turn; replacement controller must not issue a duplicate logical instruction.
- Two controller replicas contend to acquire an expired Lease; only the holder may authorize a new mutation.
- A remote API is unavailable or its observation is stale; Anvil reports unknown/pending rather than claiming failure or success.
- A sandbox disappears while Git or PR state survives; Anvil determines which artifacts are recoverable and does not assume the former session is still executing.

## Campaign dependency contract

**Provisional direction adopted · #5.**

A Campaign contains a directed acyclic graph of Commissions. Dependency edges MAY span repositories. Anvil SHALL reject cycles and references to nonexistent Commissions at admission and on governed Campaign amendment. A Campaign dependency SHALL constrain delivery ordering independently of any allowance for speculative implementation: the required upstream delivery outcome SHALL be established before a downstream Commission enters integration.

Each dependency SHALL specify exactly one execution gate: `AfterDelivery`, `AfterCheckpoint(CheckpointId)`, or `Unrestricted`. `AfterDelivery` is the default and prevents downstream implementation until the upstream required outcome is delivered. `AfterCheckpoint` permits downstream implementation only after the identified upstream immutable artifact/revision is durably available and approved as an execution input. `Unrestricted` permits immediate concurrent implementation but does not relax delivery ordering. The execution gate SHALL NOT be inferred merely from the presence of a dependency edge.

An upstream checkpoint reference SHALL bind a stable artifact revision, not a moving branch name. A downstream Commission SHALL retain the identity of the actual upstream revision or artifact consumed. An upstream push SHALL NOT automatically interrupt downstream execution. If the pinned checkpoint is superseded, Anvil SHALL record that the downstream binding may be stale; an applicable contract change or integration outcome SHALL trigger dependency reassessment at an appropriate execution boundary. The controller MAY hold downstream execution when continuing would clearly violate an approved contract or waste an exhausted budget.

Execution readiness and delivery readiness SHALL be separately evaluated. Downstream integration SHALL require applicable verification against the actual delivered upstream result; a previous check against a speculative checkpoint does not by itself establish compatibility with a changed delivered result. A dependency transition SHALL NOT silently rewrite downstream requirements, integration targets, or acceptance policy.

Anvil MAY autonomously create or replace Assignments, Attempts, verification work, and temporary working strategies within an approved Commission and authorized budget. Creating a new independently integrable Commission, adding or removing Campaign dependency edges, or changing approved requirements SHALL require a governed Campaign amendment. Contract-first decomposition MAY establish an approved durable interface artifact; it SHALL be a separate Commission only when the interface work has an independent integration and acceptance boundary.

A Campaign SHALL report success only when all required Commissions have met their individual authoritative delivery contracts and any Campaign-level acceptance conditions have passed. Failed, cancelled, unavailable, or superseded upstream results SHALL be represented as explicit dependency blockers or recovery decisions; Anvil SHALL NOT silently omit or waive dependency edges.

```rust
enum ExecutionGate {
    AfterDelivery,
    AfterCheckpoint(CheckpointId),
    Unrestricted,
}

struct Dependency {
    upstream: CommissionId,
    execution: ExecutionGate,
}
```

The dependency policy does not require automatic stacked pull requests or a distinct dependency controller. Coordination and dependency evaluation remain subordinate to the Campaign/Commission reconciliation machinery.

## Commission Git publication and collaboration

**Provisional decision.**

Anvil SHALL provision or register a Commission's repository, nominal delivery branch, intended integration target, and pull request identity. A pull request MAY be created after a bootstrap empty commit; a bootstrap commit SHALL NOT constitute implementation progress or acceptance evidence.

An implementation Assignment MAY edit files, create and rewrite local commits, push its authorized working branch, update its pull request, and participate in GitHub and Lific discussions. Anvil SHALL NOT require controller-mediated Git publication for ordinary worker development. These permissions SHALL be bounded by configured credentials and repository policies; instruction text alone SHALL NOT be treated as enforcement.

The Commission's approved integration target and acceptance criteria SHALL NOT change merely because a worker changes a pull request base, opens another pull request, or closes or reopens the registered pull request. Anvil SHALL detect and reconcile discrepancies between registered delivery intent and observed GitHub state. A replacement pull request SHALL be explicitly associated with the Commission before it can satisfy its delivery contract.

Anvil SHALL select immutable Git revision identities for verification from observed published commits, while branch and pull request state remain mutable. A worker readiness claim, push, or pull request creation SHALL NOT independently establish verification success, integration, or Commission completion. Delivery completion SHALL require authoritative integration evidence under the approved repository policy.

GitHub and Lific SHALL remain first-class collaboration surfaces. Anvil-provided agent instructions SHALL identify the relevant repository, branch, pull request, issue, reporting protocol, and expected collaboration behavior. An installed Anvil skill MAY provide progressively loaded detailed procedures; essential obligations SHALL be stated in the initial Assignment instructions. Workers MAY comment and propose issue changes. Closure of Commission-linked issues as delivered SHALL remain a controller-governed action. Discussion content SHALL NOT implicitly amend approved Commission requirements.

## Worker credential separation

**Provisional requirement.**

The controller SHALL retain control-plane GitHub authority and SHALL NOT expose its GitHub App private key or privileged installation credentials to worker sandboxes. The credential broker SHOULD issue short-lived, repository-restricted worker installation tokens with the minimum GitHub permissions needed for ordinary Git publication and review collaboration. Token scopes SHALL be derived from the authorized Assignment rather than an unrestricted worker request.

Separate controller and worker tokens issued under one GitHub App do not necessarily establish separate GitHub actor identities or ruleset-bypass boundaries. A distinct worker GitHub App is an open implementation option if repository ruleset testing demonstrates that the shared App grants unacceptable privilege to worker tokens. Repository-level token permissions do not enforce per-Commission branch ownership; this limitation SHALL be reflected in the threat model and operational findings.

## Commission execution sequence

1. Admit the Commission when Campaign execution dependencies, authorization, resource availability, and budget permit execution.
2. Create an Assignment and Attempt, provision its Sandbox and Workspace, and deliver the objective with an Anvil operational/reporting contract. Repository conventions remain in repository `AGENTS.md` and skills.
3. Observe OpenCode activity, todos, structured reports, Git changes, local check results, CI, and relevant external integration state. Do not infer acceptance from agent idleness.
4. Use the in-flight watchdog to detect tool errors, resource exhaustion, repeated diagnostics, and context pressure. Apply only bounded, authorized interventions at safe boundaries.
5. Reconcile when the agent becomes idle or relevant world state changes. Select `Wait`, `Continue`, `Repair`, `RefreshContext`, `ChangeStrategy`, `Verify`, `Integrate`, `Hold`, or `Escalate` as appropriate.
6. For a fresh session, reconstruct the Campaign/Commission/Assignment/Attempt hierarchy and immediate directive from durable artifacts, external observations, outstanding Findings, and previous strategy outcomes. Do not replay a complete transcript.
7. Evaluate an exact Candidate using configured local and external checks. Independent semantic review or held-out tests are optional policies; their absence must remain visible.
8. Conclude delivery only after externally authoritative integration evidence and all configured delivery requirements are satisfied; otherwise continue within bounds or request intervention.

## Sandbox reconciliation and upgrades

**Provisional contract · runtime upgrades.** Anvil SHALL reconcile the desired Sandbox runtime configuration and revision against observed Kubernetes and OpenCode state throughout the Assignment lifecycle, not merely at initial provisioning. Runtime drift, failed Sandbox health, and newer approved runtime revisions SHALL result in an explicit reconcile decision: maintain, apply a supported live update, defer, replace, or hold/escalate when recovery cannot be demonstrated safe.

Routine runtime upgrades SHALL prefer safe execution boundaries and SHALL NOT unnecessarily disrupt an active OpenCode turn or interactive steering claim. Anvil SHALL preserve the mutable Workspace, uncommitted work, and durable Attempt identity across replacement. Session continuity SHALL be restored where supported; when it cannot be restored, Anvil MAY create a fresh Session with deterministic context reconstruction under the existing Attempt and SHALL report the loss of conversation continuity. A Sandbox SHALL NOT be considered successfully upgraded solely because a replacement Pod becomes Ready.

The desired runtime revision and observed revision, upgrade disposition, blockers, and outcome SHALL be visible through Commission/Sandbox projections. Replacement SHALL reconcile service and preview routing, credentials, Nix access, and instruction admission without creating multiple simultaneous writers to one Workspace. Critical security upgrades MAY use an explicit more-disruptive policy; a routine image refresh SHALL NOT silently discard productive agent work.

## Minimum behavioral requirements

### Execution and recovery

- Controller restarts preserve the Commission objective, remaining budget, owned work, unresolved Operations, and applicable evidence.
- Lost prompt acknowledgements do not create accidental duplicate logical instructions.
- Idle sessions, external waits, blocked work, active execution, and completed delivery are distinguishable through the API.
- Humans and ChatGPT may inspect state, issue direct interactive steering, and submit governed Commission amendments through authorized interfaces.

### Verification and development

- Repository-declared quick/full/integration checks may be run at stable Candidate checkpoints; external CI supplies configured integration gates.
- Unknown UI or semantic acceptance requirements are not promoted to independently verified status without an appropriate check or authorized review.
- Pure domain and failure-scenario tests run locally without Kubernetes; real sandbox lifecycle receives narrow Kubernetes integration coverage.
- Optional, infrequent small benchmark runs compare an OpenCode-only baseline and Anvil-assisted execution under comparable budgets.

## Acceptance obligations, evidence, and review

**Provisional direction · #8.** A Commission defines explicit, stable semantic acceptance obligations in an approved specification generation. Every obligation requires inspectable supporting evidence. An implementation worker MAY modify its execution plan, but SHALL NOT rewrite approved acceptance criteria or waive evidence requirements. Amendments to the acceptance contract SHALL pass through the Commission's governed amendment mechanism and advance its specification generation.

Semantic obligations describe the intended behavior or outcome. Deterministic checks establish narrower mechanical facts and do not, by themselves, prove arbitrary semantic correctness. The worker SHALL discover repository-specific tests, execute relevant targeted checks during implementation, address failures, and report evidence supporting each obligation. Repository AGENTS.md, skills, and other project-owned instructions determine preferred local feedback practices; Anvil SHALL NOT duplicate or maintain a registry of the repository test suite.

Repository CI and integration policy are owned by the repository and SDLC. Anvil SHALL observe CI outcomes and reported mergeability, SHALL NOT authorize integration with known failing applicable checks, and SHALL respect authoritative GitHub/Mergify delivery restrictions. Anvil SHALL NOT independently define whether repository CI coverage, skipped jobs, or check configuration are sufficiently rigorous. Local development checks may use a fast Nix development shell; authoritative CI may use separate Nix build invocations.

Every acceptance obligation SHALL have a traceable evidence disposition distinguishing absent, submitted, challenged, and accepted evidence. Evidence SHALL retain provenance and revision applicability, including whether it is worker-reported or independently observed. Evidence completeness is necessary but not conclusive proof of semantic correctness. Review requirements are additive: worker evidence is always required, while optional independent agent review and ChatGPT/operator review increase scrutiny. The currently preferred integration policy requests explicit operator authorization after review readiness; the architecture SHALL also support automatic integration when approved policy permits.

The controller SHALL provide the worker with the relevant complete gap set, not merely the first incomplete obligation. Continuation context SHALL include the Commission objective, accepted or evidenced obligations, remaining gaps, Findings, applicable CI state, and next directive. Healthy waits on CI, delivery, or review SHALL NOT trigger repetitive agent turns. Bounded retries, strategy changes, and escalation apply if evidence cannot be completed.

A Commission MAY become ready for review when its applicable obligations have submitted supporting evidence, relevant CI is healthy according to repository policy, its PR is in a reviewable condition, and required review work remains. Review readiness SHALL NOT imply integration approval or Commission completion. Anvil SHALL surface the specification, Candidate, evidence, diff, checks, Findings, PR, and preview URL in one inspectable review projection. Findings and review decisions SHALL be durable and attached to their applicable revision and specification generation. The exact revision-change invalidation and approval freshness policy remains to be finalized with intervention semantics.

Lific Plans MAY hold the mutable agent-owned implementation plan. Anvil SHALL provide a unified Commission progress projection independent of the Lific UI and SHALL remain operable during Lific outages. An optional repository-local ExecPlan MAY hold more detailed technical reasoning; maintaining both artifacts SHALL NOT be mandatory. Completion of a plan step SHALL NOT independently satisfy a Commission acceptance obligation.

### Interactive steering

Interactive operator or ChatGPT instructions MAY steer the current implementation within the approved Commission scope. Such steering SHALL reuse the active Assignment and mutable Workspace when safe, SHALL be serialized with active worker operations, and SHALL NOT implicitly amend the approved Commission specification. Changes to requirements, budgets, dependency graph, or acceptance criteria SHALL be submitted as governed amendments. When an operator yields control, Anvil SHALL reconcile the current state before resuming autonomous instruction admission. The controller SHALL continue observation while interactive control is active.

### Interactive acceptance amendments

**Provisional contract · interactive steering.** Interactive steering MAY change implementation approach without changing the approved Commission specification. It MAY also surface unmet requirements, introduce additional acceptance obligations, or request changes to approved obligations. A new or changed criterion SHALL be represented as an explicit, attributable Commission amendment against the expected specification generation, not inferred from ordinary agent edits or natural-language progress reports.

Within a specification generation, approved semantic acceptance obligations SHALL remain stable. No worker, Lific Plan edit, local ExecPlan edit, or ordinary steering action SHALL silently delete, weaken, replace, or waive an approved criterion. An authorized operator or ChatGPT acting through an explicitly authorized amendment command MAY add, remove, or revise obligations, with recorded rationale and a new specification generation. An agent MAY propose an amendment or raise a Finding, but such proposals SHALL NOT be treated as approval.

Unchanged acceptance obligations and evidence MAY remain applicable across specification amendments if their criterion, Candidate applicability, and other provenance still hold. A new obligation MAY return a Commission from review readiness to implementation, but the reason and invalidated approval or evidence SHALL be inspectable; existing evidence SHALL NOT be silently discarded. Interactive prompts SHALL support fast incremental changes in the current Assignment and Workspace without imposing an amendment ceremony on edits that do not alter the success contract.

## User interface and observability contract

The operational UI presents four primary areas: Inbox, Campaigns, Operations, and Settings. A persistent left navigation selects an area; the main workspace and a resizable right inspector reflow together without overlay. Detailed workbench views MAY expand to full width. On mobile and tablet, the inspector replaces the main content in document flow and provides a back control. URL/hash navigation preserves screen and selected Commission or Campaign; legacy `#fleet`, `#commission`, `#review`, and `#campaign` links resolve to corresponding current views.

Inbox Focused separates Needs attention from Recently integrated (last seven days); Everything supports search and selectable/removable repository and status filters across active, waiting, and completed Commissions. Search matches Commission title, repository, ticket, and pull request. Rows show branch and external references, status, time in the current state (distinct from total age), obligation count, and requested action. Obligation counts are not a measure of work completion. Merged, release-pending, deployed, and deployment-unknown outcomes remain distinct.

The inspector retains Commission identity, parent Campaign, repository, branch, ticket, pull request, specification, preview availability, and exact OpenCode Session identity when known. Unavailable external URLs are identified as examples or unavailable rather than presented as live links. Inspector tabs expose Overview, Obligations, Diff, Activity, and Attempts; agent conversation is not the default view. The overview includes the controller's decision and next action, existing watchdog observations and disposition, freshness, pending question or intervention, and applicable Candidate and specification generation.

Campaigns are searchable and expose objective, derived progress, a flat Commission list, many-to-many dependency relationships, human-readable upstream state, execution gate (`AfterDelivery`, `AfterCheckpoint`, or `Unrestricted`), downstream unlocks, and the separately enforced integration order. The default Campaign view is not a dependency DAG graphic.

Operations contains Fleet, Performance, and Budget views. Fleet reports controller/reconciliation, agent-sandbox, existing session-watchdog, GitHub/CI/Mergify health and issues linked to affected Commissions. Performance reports integrated outcomes, elapsed-time distributions, review bottlenecks, failures/recovery, attempts, and model turns relative to results. Budget distinguishes measured, estimated, and unavailable provider/model usage, utilization, quota, and unused capacity. Illustrative values SHALL be clearly labeled sample data and SHALL NOT imply production telemetry.

Settings expose provider/model, MCP, skills/plugins, worker defaults, and effective configuration for an Attempt. Configuration changes apply to new work by default; active Attempts require explicit upgrade or steering. ChatGPT, CLI, MCP, and UI read projections SHALL use the same application/API semantics. Mutating commands are typed, authorized and idempotency/version checked; the UI is not a separate mutation authority. Review authorization is bound to the explicit Candidate and specification generation and is revalidated when stale. Evidence provenance, CI/integration outcome, deployment state, and observation freshness remain distinguishable.

The interactive UI reference screens are a static-data mockup. All sample records, metrics, status, controls, and locally simulated interactions are illustrative only; they do not report live Anvil telemetry or submit real commands. The UI exposes existing watchdog state and does not define a separate liveness feature.

## Open decision register

| ID / topic | Contract to finalize | Status |
| --- | --- | --- |
| **OD-01** Corrective policy | Define watchdog thresholds, safe interruption, context-refresh criteria, and bounded strategy changes. | Provisional |
| **OD-02** Operation implementation | Adopt per-Commission Kubernetes Leases, stable operation identity, and external re-observation. Validate pinned OpenCode idempotency and provider-specific safe retry/fencing behavior through restart and ownership-transfer tests. | Direction settled; adapter tests pending |
| **OD-03** Campaign coordination implementation | Dependency execution gates, integration ordering, and governed graph changes are provisionally settled. Validate stale checkpoint handling, adapter-specific delivery readiness, and coordination message delivery during implementation. | Direction settled; adapter details open |
| **OD-04** Git delivery | Select independent branch/PR and stacked-change behavior; define Mergify and GitHub authority. | Open |
| **OD-05** Check contracts | Define repository check profiles, environment/test capabilities, and optional review/held-out gates. | Provisional |
| **OD-06** Storage and runtime | Implement the accepted TypeScript/Bun-first application stack and provisional SQLite single-active-controller deployment direction. Complete versioned migration, backup/restore and runtime compatibility checks during the first vertical slice. | Stack accepted; operational validation pending |
