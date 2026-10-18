# Anvil v2 research ledger

**Status:** dated working notes, not a bibliography of claims. **Last reviewed:** 2026-10-18. Links below point to primary or first-party material where possible; a link is not evidence that Anvil has adopted a technology.

## Adopted lessons

### 2026-10-18 · Kubernetes controller pattern

**Reference:** [Kubernetes controller concepts](https://kubernetes.io/docs/concepts/architecture/controller/)

The useful lesson is the control shape: observe current state, compare it with desired state, and reconcile. Anvil borrows that shape, not Kubernetes API machinery as an architectural prescription. This supports “events trigger reconciliation; world state is authoritative” and makes retry/recovery an explicit design concern.

**Implication:** a callback or session event must not directly decide that a Commission is complete. It should wake a reconciliation that reads the world again.

### 2026-10-18 · Ralph-style external loop

**Reference:** [Geoffrey Huntley, Ralph](https://ghuntley.com/ralph/)

Ralph is the inspiration for an outer loop that repeatedly gives an agent bounded work and evaluates the result. Anvil’s proposed distinction is important: the loop supervises and reconciles; OpenCode remains the worker environment. The reference does not settle Anvil’s persistence, safety, or acceptance policy.

**Implication:** Attempts need explicit bounds and outcomes. “The agent is still talking” is not equivalent to progress.

### 2026-10-18 · Context engineering for coding agents

**Reference:** [Claude Code: Using Claude Code, the unreasonable effectiveness of HTML](https://claude.dev/blog/using-claude-code-the-unreasonable-effectiveness-of-html/)

The practical lesson adopted here is to make durable, navigable artifacts do explanatory work instead of relying on an enormous prompt or transcript. It is a presentation and workflow reference, not an independent claim about model quality.

**Implication:** fresh sessions should receive a compact context packet assembled from repository instructions, durable artifacts, current findings, and observable state. The “under ~50% context” target is a tunable heuristic, not a measured law.

### 2026-10-18 · Repository-local instructions

**References:** [OpenCode repository](https://github.com/anomalyco/opencode), [AGENTS.md convention](https://agents.md/)

The design direction keeps repository-owned instructions and skills in their repository boundary. Anvil supplies operational/reporting protocol and current work hierarchy; it should not silently override local instructions.

**Implication:** provenance must identify whether a rule came from the repository, Anvil’s protocol, a Commission amendment, or a worker claim.

### 2026-10-18 · Stacked change workflows

**Reference:** [Mergify stacked PRs](https://docs.mergify.com/stacked-prs/)

Stack workflows demonstrate that dependent changes can be useful, but this reference does not answer Anvil’s graph semantics, Candidate identity, or failure policy. It is a candidate integration constraint only.

**Implication:** Git stacks and dependent branches remain an open decision, not a hidden assumption in Campaign design.

### 2026-10-18 · Benchmarking agentic software work

**Reference:** [SWE-bench paper and benchmark](https://www.swebench.com/)

SWE-bench can provide an occasional, affordable comparison of an OpenCode baseline and Anvil’s supervision on a subset. It cannot serve as a general semantic correctness oracle or validate Kubernetes operations.

**Implication:** benchmark results belong in research evidence, not in a universal acceptance gate.

## Uncertain claims to test

| Claim | Why uncertain | Cheap discriminating test |
| --- | --- | --- |
| A compact context packet outperforms transcript continuation | Depends on task, model, and repository | Paired scenario runs with identical revisions and fixed budgets |
| Watchdog intervention before idle improves convergence | Intervention may interrupt useful reasoning | Fault-injected idle/active sessions with outcome and cost traces |
| Selective history is enough for recovery | Missing history may hide causal context | Kill/restart scenarios using only durable artifacts and journal |
| Independent semantic review catches useful errors | Reviewer may agree with the implementer or add noise | Held-out executable checks plus blinded reviewer comparisons |
| A graph of Commissions is clearer than one giant task | Depends on dependency frequency and integration cost | Model the same cross-repo change both ways and compare recovery paths |

## Primary references to keep watching

- [Kubernetes API conventions](https://github.com/kubernetes/community/blob/master/contributors/devel/sig-architecture/api-conventions.md) — useful vocabulary for conditions and observed state; not a requirement to copy its API.
- [OpenCode documentation](https://opencode.ai/docs/) — worker/session behavior must be checked against the version actually used; do not infer guarantees from a name.
- [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) — relevant to isolated agent execution and Kubernetes integration; Anvil should confirm lifecycle and security properties before depending on it.
- [Mergify documentation](https://docs.mergify.com/) — first-party integration behavior for queues and stacks.
- [Model Context Protocol specification](https://modelcontextprotocol.io/specification/latest) — relevant if external steering or tool exposure uses MCP; it does not define Anvil’s authorization policy.

## Not researched / do not infer

- No runtime, database, or workflow engine has been selected. Rust, Go, TypeScript, Temporal, and DBOS are all outside the current decision boundary.
- No general semantic correctness oracle exists in this design. Repository checks, CI, optional independent review, and held-out executable checks have different authority and failure modes.
- “Lific issue” is an external integration object in the vocabulary, not a researched Anvil primitive here. Its contract and API should be documented from its own primary source before integration design.

## Questions for the next research pass

1. What is the smallest Commission acceptance contract that can be tested without a semantic oracle?
2. Which operation identities and leases make a one-writer workspace recoverable after controller failure?
3. How should Campaign dependency edges behave when an upstream Candidate is revised after downstream work starts?
4. What evidence can a human or external ChatGPT steering client inspect without exposing full transcripts?
