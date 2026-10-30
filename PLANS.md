# Execution plans

Permanent documentation starts at [docs/index.md](docs/index.md): product behavior
in `docs/spec.md`, architectural contracts in `docs/architecture.md`, procedures
in `docs/operations.md`, provenance in `docs/research.md`, and UI/screen references.
Temporary implementation campaigns belong in [docs/plans/active/](docs/plans/active/).
Finished plans move to [docs/plans/completed/](docs/plans/completed/).

## Self-contained ExecPlan format

Use one Markdown plan per coherent campaign, with a descriptive filename and:

1. Objective and observable outcome; branch, PR and predecessor/source baseline.
2. Approved scope, authority and environment constraints; distinguish product
   requirements from campaign authorization and unresolved decisions.
3. Stable obligation IDs, exact normative criteria, required evidence, acceptance
   gates and stopping rules. Material amendments require explicit approval.
4. Concrete progress per obligation, source/commit and test references, positive
   and negative findings, and remaining limitations. Implementation is not proof.
5. Unexpected findings, exact failure traces and unresolved security failures.
6. Dated decision log with rationale and authority for scope/structure changes.
7. Remaining gaps and next concrete authorized actions, including external gates.
8. Verification commands and exact executed results: source revision, exit status,
   counts/diagnostics and scope. Distinguish local fixtures, live observations,
   independent validation, historical evidence and commands merely proposed.
9. Outcome/handoff: achieved checkpoint, outstanding obligations and authorization
   status; enough context to resume without prior conversation transcripts.

Sections may be ordered for readability; explicit stable anchors help navigation.
Keep the plan self-contained by including campaign criteria and evidence rather
than requiring deleted status pages. Link permanent semantics and retained source
artifacts instead of copying whole product documents.

## Maintenance

Read the active plan and latest branch/PR before implementation. Update the same
plan at each coherent checkpoint with progress, exact results, failed attempts,
decisions and next actions. Do not create parallel acceptance ledgers, handoff
pages or ad hoc status reports. Retain historical results and their scope; append
corrections with provenance rather than silently replacing contradictory evidence.
Never promote acceptance from a worker claim, unexecuted command or unrelated
green check. External authorization remains separate from local readiness.

Extract enduring requirements/procedures to their permanent domain document and
link them from the plan. On relocation, update repository and site references;
former public entry points may be navigation-only pointers, never duplicate
normative text. Verify paths/anchors and conservation of criteria/evidence.

When the approved outcome is accepted, record final evidence, residual limitations
and handoff, then move the whole plan to `docs/plans/completed/`, preserving its
evidence and updating incoming links. Completion must not erase failures or imply
authorization that was never granted.
