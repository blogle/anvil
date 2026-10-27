# Anvil

**Design documentation · draft**

Anvil supervises remote coding agents and reconciles their execution, verification, and integration state against approved engineering objectives.

**Status:** Draft specification · Runtime direction selected; persistence validation pending

> **Document status**
> This draft records required contracts, provisional mechanisms, and unresolved design decisions. It does not authorize implementation choices that remain open.
> Design base branch: `v2`

## System overview

## Purpose and system boundary

Anvil is a Kubernetes-deployed control plane for unattended software delivery. It admits approved engineering objectives, provisions isolated coding workers, observes execution and integration state, and selects bounded corrective actions until the required delivery outcome is observed or an intervention is required.

OpenCode owns model execution and its inner tool loop. Anvil owns the Commission lifecycle, continuation decisions, budget enforcement, context reconstruction, recovery, and delivery policy. Kubernetes and agent-sandbox own runtime resources; GitHub, CI, and Mergify remain authoritative for their respective external states.

**Completion boundary.** A successful model turn, an agent's ready report, a green local check, and a merged pull request represent different observations. A Commission is concluded only when its configured delivery criteria have been established by the appropriate authorities.

## Design status

- **Direction — Externally supervised execution.** Anvil reconciles durable intent against observed world state. Session events trigger observation but do not by themselves authorize action or establish completion.
- **Provisional — Bounded continuation.** OpenCode runs bounded Attempts. Anvil observes in-flight behavior, reconstitutes context from durable artifacts, and applies configurable recovery and escalation limits.
- **Open — Consistency and integration.** Command deduplication, ownership fencing, Campaign dependency gates, stacked-PR integration, and check-profile semantics require final contracts.

Anvil remains pre-1.0. The historical `v2` branch names the rewrite track, not a major release. Use SDLC changelogs and 0.x versions until a stable 1.0 release is explicitly authorized.

## Document responsibilities

- [Domain and requirements](spec.md#domain-terminology): definitions, authority boundaries, lifecycle, invariants, acceptance rules, and unresolved product decisions.
- [Control mechanics](architecture.md#outer-reconciler): observation, the in-flight watchdog, continuation prompts, revision-bound evidence, command execution, and integration.
- [Evidence and provenance](research.md): primary-source findings, applicability to Anvil, limitations, and claims awaiting empirical confirmation.
- [Inbox, Campaign, Operations and Settings mockup](ui.html): responsive sample screens with shared Commission context.
- [Technology decision — TypeScript stack](adr-001-typescript-stack.md).

## Interpretation rules

- **Required:** Normative constraints, explicit invariants, and configured acceptance gates must be enforced.
- **Provisional:** Mechanisms and thresholds may guide initial implementation but are not validated defaults.
- **Open:** Unresolved contracts retain identifiers in the specification's decision register.
- **Illustrative:** Diagrams and pseudocode specify intended behavior without committing to a language, database, or framework.

## Excluded scope

- Replacing OpenCode as an interactive coding harness or implementing its model/tool loop inside Anvil.
- Duplicating repository-owned `AGENTS.md`, skills, test definitions, or developer conventions in Anvil's Campaign specification.
- Claiming semantic correctness of arbitrary changes from source diffs, model reports, or general-purpose CI alone.
- Requiring independent LLM verification, a learned progress scorer, or a large benchmark run for ordinary delivery.
- Treating language selection as open: ADR-001 accepts TypeScript end-to-end and a Bun-first runtime with bounded Node.js fallback.
