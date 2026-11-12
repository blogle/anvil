# Execution Plans (ExecPlans)

An ExecPlan is a self-contained, living specification that a contributor unfamiliar
with this repository can follow to deliver observable working behavior. This format
adapts the [OpenAI Agents ExecPlan standard](https://github.com/openai/openai-agents-python/blob/main/PLANS.md)
to Anvil's obligation-driven delivery and evidence requirements.

## When to use an ExecPlan

Use an ExecPlan for multi-step or multi-file work, new features, refactors, or work
expected to take more than about an hour. Trivial corrections do not need a plan.
Continue an existing coherent campaign rather than creating competing plans.

Permanent design and operations documentation starts at `docs/index.md`.
Current contributor rules belong in `CONTRIBUTING.md`. Active campaigns belong in
`docs/plans/active/`; accepted completed plans move to `docs/plans/completed/`.
Choose a descriptive filename that remains meaningful after completion.

## How to use this file

Read this file in full before authoring or revising a plan. Start with the skeleton
below. Define unfamiliar terms and include the repository context, paths, commands,
environment assumptions and acceptance criteria needed to execute the work without
conversation history or a predecessor plan. Links provide supporting reference;
they must not substitute for the campaign's approved requirements or recovery steps.

During implementation, proceed to the next authorized milestone without asking for
routine next steps. Update Progress, Surprises & Discoveries, Decision Log, and
Outcomes & Retrospective at each coherent checkpoint and every stopping point.
Reconcile actual branch/PR state before resuming. A plan is a record of approved
work, not permission to bypass an external gate.

## Non-negotiable requirements

The plan must describe what a user can do after the change and how to observe it.
Code edits alone are not an outcome. Include exact commands, working directories,
expected outputs, behavioral checks and meaningful negative cases. Describe retry,
cleanup or rollback for risky steps and make repeatable steps idempotent.

Preserve stable obligation IDs and their exact normative criteria, required
evidence, acceptance gates and stopping rules. Material amendments need explicit
approval with rationale and authority recorded in the plan. Record per-obligation
status and residual gaps; implementation is not proof. Do not promote acceptance
from worker reports, proposed commands, unrelated green checks or local fixtures
that do not establish the claimed real-world behavior.

Record executed commands with source revision or working-tree baseline, exit
status, test counts/diagnostics and scope. Distinguish historical results, local
fixtures, real runtime observations, independent validation, live evidence and
commands merely proposed. Keep failed attempts, exact useful failure traces and
unresolved security failures. Append corrections with provenance rather than
silently replacing contradictory historical evidence.

Keep one campaign record: no parallel acceptance ledgers, status pages or handoff
documents. Extract enduring system explanations into the relevant permanent
document; keep campaign criteria and evidence in the plan. Use diagrams where they
clarify boundaries or execution, with enough prose to explain their meaning.

## Formatting and milestones

When presenting a plan in a message, use one enclosing `md` fence and indent
commands, transcripts and diffs rather than nesting fences. When the file contains
only the ExecPlan, omit that outer fence. Leave blank lines after headings. Prefer
prose; checkbox lists belong only in Progress and are mandatory there. Evidence
tables are appropriate for stable obligation/status mappings.

Milestones tell a story: goal, work, observable result and proof. Each independently
verifiable milestone advances the overall outcome. They describe the intended
sequence; Progress records actual execution with timestamps. Prototypes and parallel
paths are useful when they reduce uncertainty: label them, define validation, and
explain how to retire an unsuccessful path safely.

## ExecPlan skeleton

    # <Short, action-oriented description>

    This ExecPlan is a living document maintained under repository-root PLANS.md.
    Progress, Surprises & Discoveries, Decision Log, and Outcomes & Retrospective
    must stay current as work proceeds.

    ## Purpose / Big Picture

    Explain the user-visible outcome and how to observe it. Identify approved
    scope, branch, PR, source baseline and external authority constraints.

    ## Progress

    - [x] (2026-11-01 12:00Z) Example completed step with evidence reference.
    - [ ] Example incomplete step.
    - [ ] Example partial step (completed: X; remaining: Y).

    ## Surprises & Discoveries

    Observation: describe unexpected behavior, bugs or performance findings.
    Evidence: concise reproduction or transcript, revision and scope.

    ## Decision Log

    Decision: describe the choice.
    Rationale: explain why and identify approval when needed.
    Date/Author: record when and who authorized or made it.

    ## Outcomes & Retrospective

    Compare achieved results with the purpose. State gaps, lessons and the next
    concrete authorized action. Do not imply permission that was never granted.

    ## Context and Orientation

    Define terminology and current state. Name key repository-relative paths,
    modules, functions, interfaces and environment assumptions.

    ## Plan of Work

    Describe independently verifiable milestones in prose, naming edit locations
    and the result each milestone makes observable.

    ## Concrete Steps

    Give exact commands, their working directory and short expected outputs.

    ## Validation and Acceptance

    State behavioral criteria and stable obligation IDs, required evidence,
    command outcomes, negative cases, external gates and stopping rules.

    ## Idempotence and Recovery

    Explain safe retries, cleanup and recovery or rollback of partial work.

    ## Artifacts and Notes

    Include concise executed transcripts, evidence tables, diffs or useful snippets.

    ## Interfaces and Dependencies

    Name required libraries, interfaces, module paths and signatures. Avoid
    prescribing abstractions or dependencies without a concrete need.

## Revising and completing a plan

When scope changes, rewrite affected prospective sections so the plan remains
coherent and self-contained, preserving approved criteria and historical evidence.
After significant edits, add a dated revision note explaining what changed and why.
Older plans may retain historical checkpoint sections alongside the living sections;
do not discard their evidence just to fit the skeleton.

When the approved outcome is accepted, record final evidence, residual limitations
and handoff; move the whole plan to `docs/plans/completed/` and repair repository
and Fieldnotes links. Verify paths, anchors and conservation of criteria/evidence.
Remove obsolete navigation stubs rather than maintaining duplicate entry points.
