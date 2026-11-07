# Controller and harness

Anvil supervises OpenCode workers from approved work to integrated changes. Its
deterministic outer harness replaces session babysitting while supporting human-led
interactive development within the same work model.

## Work model and workflow

```text
Campaign — purpose and shared contracts
  └─ Commission — objective, obligations, repository/target, branch, PR, optional ticket
       └─ Attempt — bounded strategy, starting revision, budget, reason and outcome
            └─ Session — OpenCode conversation and execution identity
```

An operator creates Campaigns and Commissions through UI/API/MCP. Admission starts
work when capacity and start gates permit. Provisioning establishes a persistent
Workspace and branch, binds a Session, and supplies its work contract. OpenCode
implements, tests, commits, publishes and reports progress. Anvil observes those
results, directs corrections, surfaces review and records authoritative merge.
Provisioning may establish a draft PR; the worker normally manages its development
and PR workflow.

Dependencies allow parallel development while gating integration by default. An
explicit start-blocking dependency requires upstream input before work begins, such
as an agreed API contract. Optional reviewer/verifier workers and cross-worker
messages support coordination without replacing the shared work contract.

## Continuous convergence

The loop regularly observes execution, obligation reports, GitHub branches/checks/PRs,
Mergify and relevant runtime health. Events accelerate reconciliation; periodic
observation covers missed events. It prefers fast feedback on implementation and
obligation evidence before waiting for downstream PR evidence.

| Observation | Behavior |
| --- | --- |
| Healthy active work | Observe without duplicating or racing the current instruction. |
| Missing deliverable or report | Direct the next concrete gap. |
| New failed check, challenged evidence or merge conflict | Supply revision-bound diagnostics and request repair. |
| CI, dependency or merge queue pending | Keep observing without another model turn. |
| Required review or unresolved question | Surface the requested decision in the Inbox. |
| Stuck tool, repeated failure or non-progress | Watchdog performs bounded recovery, changes strategy or escalates. |
| Exhausted budget or unknown effect outcome | Stop new costly work; expose recovery context. |
| Registered PR merged into the approved target | Record integration, including while held. |

Prompt dispatch respects active execution and safe boundaries, rechecks current facts
and serializes with human steering. Unchanged failures do not generate repeated
identical instructions. Lost acknowledgements require reobservation, not blind replay.
The separate watchdog uses execution progress, resolved failures, reports and code
changes; busy/idle transitions or changing prose alone do not establish progress.
Recovery allowances and thresholds are configurable and recorded. LLM-based failure
classification is a research direction, not required for deterministic supervision.

## Hierarchical instructions and context

Each instruction combines a stable context envelope with a reason-specific directive.
References supply detailed artifacts without replaying full transcripts.

```text
Campaign: purpose, relevant shared contracts and dependency state
Commission: scope, repository/target, branch/PR, obligation IDs/versions
Attempt: strategy, starting state, work limits and remaining budget
Current facts: Candidate SHA (or none), reports, findings, checks, relevant health
Next action: implement | continue | repair | resume after human handoff
Report progress using the installed Anvil reporting skill.
```

Initial work receives the full contract; continuation emphasizes changed facts and
remaining gaps. A repair names the failed check/run and Candidate, links diagnostics,
and requests a focused correction and updated evidence. Human handback includes
retained UX changes and deferred checks. New Sessions receive durable decisions,
Workspace state and unresolved work rather than assumed conversational knowledge.

| Situation | Attempt / Session choice |
| --- | --- |
| Ordinary continuation, CI repair or review feedback | Same strategy Attempt and healthy Session. |
| Context unusable or Session definitively lost | New Session, same Attempt, reconstructed context and recorded continuity loss. |
| Strategy fails within its recovery allowance | End Attempt with reason; admit a different strategy with a fresh Session if budget permits. |
| Controller/provider restarts with Session intact | Reobserve and retain it. |

A completed turn does not end an Attempt. Workspace, branch, PR, obligations and
aggregate usage survive Session/Attempt changes. Replacing a Session does not reset
budgets or permit simultaneous writers. Autonomous context retention is experimental:
retain healthy Sessions as the baseline and compare fresh-per-prompt Sessions using
the same durable packet, measuring convergence, latency, cost and context size.

## Interactive development

A human takes interactive control of a Commission, steers its Session through
API/MCP and watches the live sandbox preview. Routine autonomous prompts, test
requests and integration are deferred; explicit checks remain possible and obligations
remain binding. Takeover serializes with active execution. Conversation continuity is
retained; watchdog alerts do not silently restore autonomous control.

**Only explicit human handback resumes autonomous convergence; inactivity never does.**
Anvil reobserves the changed work, retains UX changes and directs regression repair,
coverage, evidence and delivery.

<a id="acceptance-obligations-evidence-and-review"></a>

## Obligations, reporting and review

Authorized API/MCP/UI commands add, modify or remove obligations with an audit trail.
Modifying an obligation invalidates its prior evidence; removal retains history.

| Record | Contract |
| --- | --- |
| Obligation | Stable ID, Commission, version, requirement and acceptance expectations. |
| Evidence | ID, obligation/version, Candidate SHA, Attempt/Session/instruction provenance, claim, artifact references, observation time and disposition. |

An installed **Anvil reporting skill** teaches progress reports, obligation claims,
artifacts and blockers. Prompts refer to the skill instead of repeating its procedure.
Anvil binds reports to actual execution identities and validates applicability.
Ordinary worker claims supply obligation evidence by default; they are review aids,
not independently certified truth. A reviewer challenges evidence with a reason;
the resulting gap returns to convergence without changing the requirement. Old-code
claims are non-current until the worker supplies applicable evidence. CI/review facts
retain their independent provider identities and provenance.

Reporting transport is an experiment: structured completed responses versus an
OpenCode reporting tool accompanying the skill. Missing reports remain gaps and
duplicates do not duplicate evidence. Reporting cannot amend obligations, approve
work or conclude a Commission. Plugin events may wake the loop; plugins do not
independently initiate continuation prompts.

## Integration

**Work complete:** current obligation claims supplied and no implementation gap.
**Review ready:** reviewable PR, healthy required checks and no unresolved repair;
approval may still be pending. **Integrated:** the registered PR authoritatively
merged into the approved target. A Commission is not done before integration;
deployment is separately observable, not initially required for completion.

PRs default to `integration:review`. GitHub/Mergify enforce approval and merge policy;
Anvil observes approval regardless of its author. Automatic review/integration and
dotfiles-managed production promotion extend this delivery flow without transferring
repository approval policy to Anvil.

<a id="user-interface-and-observability-contract"></a>

## Inbox and observability

The [Ledger reference](ui.html) illustrates the application with sample data. Focused
Inbox shows actionable review, decisions, blockers and unhealthy/exhausted work plus
recent integrations. Everything includes healthy waits. A Commission inspector brings
together obligations/evidence, challenged claims, Candidate/diff, checks/review,
activity and Attempts. PR, ticket, exact Session and preview links navigate to actual
targets. Reviewers inspect that packet, challenge claims or steer repairs; GitHub
approval is observed. Interventions include obligation amendments, interactive
takeover/handback and hold/resume. Campaign view exposes start and integration gates.
API/MCP and UI expose the same work and commands.

Durable, correlated, exportable telemetry records what Anvil observed, why it acted
or waited, the context and instruction it supplied, and subsequent effects/outcomes.
Include revisions, source identities, timestamps, latency, retries, usage, failure
and recovery reasons, prompt version/size and Session/Attempt changes. Redact
credentials and distinguish measured, estimated, stale and unavailable data. Humans
and LLMs can analyze these traces to improve convergence policies.
