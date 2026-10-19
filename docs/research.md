# Anvil v2 — research provenance

**Status:** supporting design evidence. **Scope:** external mechanisms relevant to unattended agent execution, context reconstruction, reconciliation, recovery, and delivery. Sources do not establish Anvil's implementation choices by themselves.

## Reference register

### R-01 — Reconciliation from observed state
- **Source:** [Kubernetes controller concepts](https://kubernetes.io/docs/concepts/architecture/controller/)
- **Mechanism:** Control loops compare desired state to current observed state and act to reduce the difference.
- **Application:** Anvil treats events and callbacks as reconciliation triggers; it re-reads OpenCode, Git, CI, and integration state before selecting decisions.
- **Limit:** Kubernetes' controller pattern does not supply an agent strategy-selection algorithm, remote exactly-once effects, or a semantic acceptance oracle.
- **Design links:** `spec.html#invariants`, `architecture.html#loop`, OD-02.

### R-02 — Ralph-style external agent repetition
- **Source:** [Geoffrey Huntley — Ralph](https://ghuntley.com/ralph/)
- **Mechanism:** Repeated bounded agent execution against persistent project artifacts and the current repository state.
- **Application:** OpenCode remains the inner model/tool loop. Anvil's outer controller selects when another bounded instruction is warranted, when to wait, and when to stop.
- **Limit:** Blind iteration does not establish progress, authority, budget safety, or external integration outcomes.
- **Design links:** `architecture.html#control`, OD-01.

### R-03 — External worker orchestration
- **Source:** [OpenAI Symphony specification](https://github.com/openai/symphony/blob/main/SPEC.md)
- **Mechanism:** Worker execution and continuation informed by external work state; bounded retry and thread/session continuity are explicit operational concerns.
- **Application:** Agent idleness is a checkpoint opportunity, not a completion criterion. Anvil may continue an existing context with a delta or reconstruct a fresh session.
- **Limit:** Anvil additionally requires Candidate-bound verification, integration recovery, Campaign dependencies, and authority-aware command delivery.
- **Design links:** `architecture.html#loop`, `architecture.html#context`.

### R-04 — Context continuity across agent sessions
- **Source:** [Anthropic — Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- **Mechanism:** Explicit progress artifacts and repository state help a fresh context recover work without inheriting the entire preceding trajectory.
- **Application:** Anvil reconstructs Campaign, Commission, Assignment, Attempt, previous strategy outcomes, Candidate state, and current Findings from durable records. OpenCode retains repository-owned development instructions.
- **Limit:** A proposed context occupancy target below approximately 50% is an initial tunable heuristic, not a published universal optimum.
- **Design links:** `architecture.html#context`, OD-01.

### R-05 — OpenCode execution and instrumentation
- **Sources:** [OpenCode documentation](https://opencode.ai/docs/), [OpenCode repository](https://github.com/anomalyco/opencode)
- **Mechanism:** OpenCode provides coding sessions, tool outcomes, session todos, and extensibility; concrete API guarantees are version-dependent.
- **Application:** Observe the existing todos and execution messages before adding an Anvil-specific reporting tool or plugin. Structured reports remain implementer claims.
- **Limit:** Precise endpoint semantics, token accounting, and safe steering/interrupt capabilities must be verified against the pinned OpenCode version.
- **Design links:** `architecture.html#watchdog`, `architecture.html#evidence`.

### R-06 — Repository-owned development instructions
- **Sources:** [AGENTS.md](https://agents.md/), [OpenCode documentation](https://opencode.ai/docs/)
- **Mechanism:** Project-level instructions and skills reside with the repository and its harness configuration.
- **Application:** Anvil supplies operational authority, reporting protocol, current objective hierarchy, and Findings. It does not duplicate or supersede repository development conventions.
- **Limit:** Repository-provided instructions are not authorization to exceed controller budgets or change protected delivery gates.
- **Design links:** `architecture.html#context`.

### R-07 — Sandbox runtime boundary
- **Source:** [Kubernetes agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox)
- **Mechanism:** Kubernetes-managed isolated agent workspaces and associated lifecycle.
- **Application:** Real Kubernetes tests are needed for provisioning, readiness, persistence, isolation and cleanup. Domain policy and failure scenarios should run without Kubernetes.
- **Limit:** Local test doubles do not prove production isolation, volume persistence, or rollout behavior.
- **Design links:** `spec.html#acceptance`, OD-06.

### R-08 — Pull request integration and stacks
- **Source:** [Mergify documentation](https://docs.mergify.com/)
- **Mechanism:** Provider-managed merge queues and stacked-change workflows.
- **Application:** Observe authoritative PR/check/merge state; isolate integration semantics behind explicit operations rather than assuming branch pushes imply delivery.
- **Limit:** Branch-based dependency graphs and Mergify stack mechanisms must not be conflated. Candidate validity after rebases and dependency updates remains unresolved.
- **Design links:** `architecture.html#campaign`, OD-04.

### R-09 — External coding benchmarks
- **Source:** [SWE-bench](https://www.swebench.com/)
- **Mechanism:** Independent grading of software-repair patches against benchmark tasks.
- **Application:** Run an affordable, pinned subset periodically to compare OpenCode alone against Anvil-assisted execution under comparable model, repository, and budget settings.
- **Limit:** Benchmark patch success does not measure controller recovery, cross-repository integration, or unattended delivery reliability. Held-out benchmark grading must not leak into in-run repair prompts.
- **Design links:** `spec.html#acceptance`.

### R-10 — HTML as a technical documentation medium
- **Source:** [Claude — Using Claude Code, the unreasonable effectiveness of HTML](https://claude.dev/blog/using-claude-code-the-unreasonable-effectiveness-of-html/)
- **Mechanism:** Navigable static HTML can make diagrams, cross-references, and architecture decisions accessible without a document-processing pipeline.
- **Application:** HTML is the rendering medium for the normative specification and architecture; this is not marketing collateral.
- **Limit:** The presentation medium does not determine the correctness of domain claims.

## Unverified propositions

| Proposition | Evaluation criterion |
| --- | --- |
| Fresh-session hierarchical context improves recovery compared with long same-session continuation | Compare matched task attempts, Candidate correctness, cost and total elapsed time under fixed budgets |
| In-flight watchdog intervention reduces wasted model execution | Measure excessive repeated failure cycles avoided and rate of useful work incorrectly interrupted |
| Agent-maintained todos improve continuation prompts | Compare objective completion and repair accuracy when agent-plan state is included versus omitted |
| Small independent check profiles improve convergence without frequent CI pushes | Measure local diagnostic time/cost and downstream CI results for the same Candidate revision |
| A separate reviewer improves assurance enough to justify cost | Compare independent defect detection, false rejections, and additional inference cost |

## Current design limitations

- Anvil cannot deterministically infer whether arbitrary UI or architectural requirements are satisfied solely by inspecting source code.
- An agent's self-reported plan and completion disposition are not independent evidence.
- Kubernetes runtime correctness, remote operation recovery, and integration provider contracts require direct tests against pinned versions.
- A periodic SWE-bench subset and deterministic scenario tests are sufficient initial evaluation scope; large benchmark campaigns and learned progress scoring are deferred.
- Runtime, database, command deduplication policy, dependency semantics, and Git stack topology are unresolved. See the specification's open decision register.
