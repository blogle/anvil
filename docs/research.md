# Anvil v2 — research provenance

**Status:** supporting design evidence. **Scope:** external mechanisms relevant to unattended agent execution, context reconstruction, reconciliation, recovery, and delivery. Sources do not establish Anvil's implementation choices by themselves.

## Reference register

### R-01 — Reconciliation from observed state
- **Source:** [Kubernetes controller concepts](https://kubernetes.io/docs/concepts/architecture/controller/)
- **Mechanism:** Control loops compare desired state to current observed state and act to reduce the difference.
- **Application:** Anvil treats events and callbacks as reconciliation triggers; it re-reads OpenCode, Git, CI, and integration state before selecting decisions.
- **Limit:** Kubernetes' controller pattern does not supply an agent strategy-selection algorithm, remote exactly-once effects, or a semantic acceptance oracle.
- **Design links:** `spec.md#required-invariants`, `architecture.md#outer-reconciler`, OD-02.

### R-02 — Ralph-style external agent repetition
- **Source:** [Geoffrey Huntley — Ralph](https://ghuntley.com/ralph/)
- **Mechanism:** Repeated bounded agent execution against persistent project artifacts and the current repository state.
- **Application:** OpenCode remains the inner model/tool loop. Anvil's outer controller selects when another bounded instruction is warranted, when to wait, and when to stop.
- **Limit:** Blind iteration does not establish progress, authority, budget safety, or external integration outcomes.
- **Design links:** `architecture.md#controller-decisions`, OD-01.

### R-03 — External worker orchestration
- **Source:** [OpenAI Symphony specification](https://github.com/openai/symphony/blob/main/SPEC.md)
- **Mechanism:** Worker execution and continuation informed by external work state; bounded retry and thread/session continuity are explicit operational concerns.
- **Application:** Agent idleness is a checkpoint opportunity, not a completion criterion. Anvil may continue an existing context with a delta or reconstruct a fresh session.
- **Limit:** Anvil additionally requires Candidate-bound verification, integration recovery, Campaign dependencies, and authority-aware command delivery.
- **Design links:** `architecture.md#outer-reconciler`, `architecture.md#context-refresh`.

### R-04 — Context continuity across agent sessions
- **Source:** [Anthropic — Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- **Mechanism:** Explicit progress artifacts and repository state help a fresh context recover work without inheriting the entire preceding trajectory.
- **Application:** Anvil reconstructs Campaign, Commission, Assignment, Attempt, previous strategy outcomes, Candidate state, and current Findings from durable records. OpenCode retains repository-owned development instructions.
- **Limit:** A proposed context occupancy target below approximately 50% is an initial tunable heuristic, not a published universal optimum.
- **Design links:** `architecture.md#context-refresh`, OD-01.

### R-05 — OpenCode execution and instrumentation
- **Sources:** [OpenCode documentation](https://opencode.ai/docs/), [OpenCode repository](https://github.com/anomalyco/opencode)
- **Mechanism:** OpenCode provides coding sessions, tool outcomes, session todos, and extensibility; concrete API guarantees are version-dependent.
- **Application:** Observe the existing todos and execution messages before adding an Anvil-specific reporting tool or plugin. Structured reports remain implementer claims.
- **Limit:** Precise endpoint semantics, token accounting, and safe steering/interrupt capabilities must be verified against the pinned OpenCode version.
- **Design links:** `architecture.md#in-flight-execution-assessment`, `architecture.md#claims-observations-and-acceptance-evidence`.

### R-06 — Repository-owned development instructions
- **Sources:** [AGENTS.md](https://agents.md/), [OpenCode documentation](https://opencode.ai/docs/)
- **Mechanism:** Project-level instructions and skills reside with the repository and its harness configuration.
- **Application:** Anvil supplies operational authority, reporting protocol, current objective hierarchy, and Findings. It does not duplicate or supersede repository development conventions.
- **Limit:** Repository-provided instructions are not authorization to exceed controller budgets or change protected delivery gates.
- **Design links:** `architecture.md#context-refresh`.

### R-07 — Sandbox runtime boundary
- **Source:** [Kubernetes agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox)
- **Mechanism:** Kubernetes-managed isolated agent workspaces and associated lifecycle.
- **Application:** Real Kubernetes tests are needed for provisioning, readiness, persistence, isolation and cleanup. Domain policy and failure scenarios should run without Kubernetes.
- **Limit:** Local test doubles do not prove production isolation, volume persistence, or rollout behavior.
- **Design links:** `spec.md#minimum-behavioral-requirements`, OD-06.

### R-08 — Pull request integration and stacks
- **Source:** [Mergify documentation](https://docs.mergify.com/)
- **Mechanism:** Provider-managed merge queues and stacked-change workflows.
- **Application:** Observe authoritative PR/check/merge state; isolate integration semantics behind explicit operations rather than assuming branch pushes imply delivery.
- **Limit:** Branch-based dependency graphs and Mergify stack mechanisms must not be conflated. Candidate validity after rebases and dependency updates remains unresolved.
- **Design links:** `architecture.md#campaign-graph-across-repositories`, OD-04.

### R-09 — External coding benchmarks
- **Source:** [SWE-bench](https://www.swebench.com/)
- **Mechanism:** Independent grading of software-repair patches against benchmark tasks.
- **Application:** Run an affordable, pinned subset periodically to compare OpenCode alone against Anvil-assisted execution under comparable model, repository, and budget settings.
- **Limit:** Benchmark patch success does not measure controller recovery, cross-repository integration, or unattended delivery reliability. Held-out benchmark grading must not leak into in-run repair prompts.
- **Design links:** `spec.md#minimum-behavioral-requirements`.

### R-10 — Markdown and HTML as technical documentation media
- **Source:** [Claude — Using Claude Code, the unreasonable effectiveness of HTML](https://claude.dev/blog/using-claude-code-the-unreasonable-effectiveness-of-html/)
- **Mechanism:** Navigable static HTML can make diagrams, cross-references, and architecture decisions accessible without a document-processing pipeline.
- **Application:** Markdown is the source format for the normative specification and architecture. HTML remains the medium for the interactive UI and illustrative review mockups; this is not marketing collateral.
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
- Runtime, database, command deduplication policy, and Git stack topology remain unresolved. Dependency execution gates, integration ordering, and governed Campaign amendments are provisionally specified; adapter-specific verification and delivery semantics remain to be implemented. See the specification's open decision register.

## Loop engineering, coordination, and OpenCode extension interfaces (2026-10-20)

Status: Research evidence and implementation hypotheses. No inter-agent communication transport or OpenCode integration mechanism has been selected.

### External loops and convergence

- **Lulla et al., Loop Engineering: Building Blocks, Adoption, and Impact (August 2026).** https://arxiv.org/abs/2608.21884 . Defines an external loop across agent runs, with triggers, machine-checkable stopping conditions, durable state, budgets, verification, and escalation. An exploratory study inspected 36,710 repositories and confirmed autonomous loops in 217 of 256 heuristic matches. This shows existence, not a causal productivity benefit; comparative outcome studies are future work. **Anvil relevance:** Commission intent, Decisions, Operations, and completion are loop-level concerns external to OpenCode.
- **Macedo, Stop Hand-Holding Your Coding Agent (June 2026).** https://arxiv.org/abs/2607.00038 . Distinguishes the loop specification (trigger, goal, verification, stopping rule, memory) from the inner agent tool cycle. Its descriptive catalog of 50 loops is not a controlled comparison. **Anvil relevance:** require bounded next actions, stopping conditions and escalation across Commission paths.
- **Armin Ronacher, The Coming Loop (June 2026).** https://lucumr.pocoo.org/2026/6/23/the-coming-loop/ . Explains outer-loop repetition and cautions that autonomous coding can reduce comprehension and architectural quality despite producing code. Practitioner judgment, not a controlled measurement. **Anvil relevance:** require inspectable rationale and architecture invariants, not merely successful tests.
- **Intelligent Internet, From RALPH to Zenith (2026).** https://ii.inc/blog/post/zenith-research . Compared five harness approaches across eight heterogeneous long-horizon tasks. Zenith won five and had the best mean rank while reportedly using under half RALPH's per-task inference cost. The candidate mechanisms are revisable plans, gap finding, specialist roles, independent verification and bounded stopping; this small comparison does not isolate their independent effects. **Anvil relevance:** adaptive Attempt policy and targeted verification are more promising than blind retries.
- **OpenAI, Using Goals in Codex (May 2026).** https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex . Codex Goals persist objectives, constraints, and completion checks across turns. **Anvil relevance:** Commission-level acceptance outlives any OpenCode Session.
- **OpenAI, Symphony specification.** https://github.com/openai/symphony/blob/main/SPEC.md . Defines a workflow prompt, isolated workspaces, external issue tracker scheduling and agent-native ticket updates. **Anvil relevance:** allow native GitHub/Lific collaboration while retaining outer-loop ownership.
- **Google DeepMind, AlphaEvolve (2025).** https://deepmind.google/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/ . Uses a program database, objective evaluators, and evolutionary sampling to choose future program candidates. **Anvil relevance:** revision-specific evidence and candidate selection; general software acceptance is less objectively measurable than the studied optimization problems.
- **FutureHouse, Robin.** https://github.com/Future-House/robin . A role-specialized scientific-discovery pipeline with stored intermediate artifacts. **Anvil relevance:** structured handoffs; science workflows do not demonstrate benefits of unrestricted communication among coding workers.

### Agent communication, shared coordination and dependency handoffs

- **Pullboard features.** https://pullboard.dev/features/ . Describes item claims, worktree lanes, dependency readiness, directed/broadcast shouts, unread-message presentation at resume, and independent verification tied to commits. Product documentation, not an outcome benchmark. **Anvil relevance:** deliver targeted messages at natural checkpoints, preserve sender/recipient and Commission references.
- **Cotal.** https://github.com/Cotal-AI/Cotal . Supports addressed and channel messages, replay, presence and attention modes using NATS/JetStream, including an OpenCode plugin. Demonstrated capability does not justify deploying a message mesh in Anvil. **Anvil relevance:** distinguish stored message, recipient wakeup, delivery, acknowledgement, and eligibility for interruption.
- **MCP Agent Mail.** https://github.com/Dicklesworthstone/mcp_agent_mail . Searchable mail threads, inbox acknowledgements, advisory file reservations and Beads task identifier conventions. **Anvil relevance:** keep messages separate from task status and Commission authority; avoid a new global filesystem lease layer without conflict evidence.
- **Redis Agent Filesystem.** https://github.com/redis/agent-filesystem . Provides persistent workspace mounts, forks, checkpoints and file tools. It is primarily a shared artifact system, not evidence that agent chat improves delivery. **Anvil relevance:** compare against existing Git and Workspace storage before adding another persistence layer.
- **Destefanis and Aste, When Agents Coordinate (August 2026).** https://arxiv.org/abs/2608.16801 . Study of 1,902 coding-agent runs and 244 additional sealed-condition runs. Pipeline workloads tended toward sparse local-interface communication; common-specification workloads toward denser messaging. Shared files reduced output tokens around 42 percent in one eight-agent message-heavy condition, but introduced overhead when file channels sufficed. Nominal coordinators did not consistently improve task success. Context- and benchmark-specific results, not guaranteed Anvil improvements. **Anvil relevance:** choose communication topology based on dependencies and distinguish reusable artifacts from chat.
- **Anthropic, How we built our multi-agent research system.** https://www.anthropic.com/engineering/multi-agent-research-system . Demonstrates role-scoped delegation and distilled outputs with persisted lead-agent plans; notes risks of duplicated work and over-delegation. Research search differs from concurrent code integration. **Anvil relevance:** scoped outputs and short handoffs rather than copying full trajectories.

### OpenCode v2 extension and message delivery surface

- **OpenCode v2 Build plugins.** https://opencode.ai/v2/docs/build/plugins . Documents configurable plugins; transforms for agent, model/provider, MCP servers, commands and integrations; event subscriptions; prompt admission, model-context, tool-execution, permission and shell hooks. Prompt admission uses steer or queue delivery and occurs once per admitted prompt. The context hook runs at agent model requests, including tool-driven continuations, and may edit assembled model input. These are documented interfaces rather than proof of safe intervention semantics in Anvil's pinned runtime. **Anvil relevance:** support essential short Assignment instructions with progressively loaded Anvil skills; verify whether a small plugin improves context injection and observation without constructing a second harness.
- **OpenCode v2 API.** https://dev.opencode.ai/v2/docs/api . Documents durable pending session inbox items, delivery-mode changes and cancellation. **Anvil relevance:** experimentally distinguish admitted, pending, surfaced, addressed, and obsolete messages before asserting exactly-once processing or safe mid-turn steering.

### Testable hypotheses, not accepted design decisions

1. Compare sequential hard dependencies plus pinned contract artifacts against optional directed mailboxes on paired API/client Commissions. Track delivery success, combined merge latency, token cost, conflict rework, stale handoffs and interventions.
2. Compare queued prompt delivery at natural boundaries with ephemeral context-hook injection on the exact pinned OpenCode release. Test retries, duplicate delivery, context size, replacement Sessions and recovery. Hook invocation does not prove model consumption.
3. Build an evidence-grounded downstream handoff from upstream revision, contract artifact, checks, Findings, and unknowns. Compare against simply forwarding the predecessor's narrative. Agent claims are never authoritative completion evidence.
4. For repeated build or CI failures, test targeted retrieval of verified troubleshooting notes tied to repository/toolchain revisions before broadcasting hints to every agent.
5. Keep Commission requirements and integration decisions authoritative in Anvil. Mail, acknowledgements, file reservations and third-party issue comments do not amend them without governed action.
